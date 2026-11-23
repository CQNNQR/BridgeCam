// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 BridgeCam Contributors

import crypto from 'crypto'
import { logger } from './logger.js'
import { config } from './config.js'

// In-memory room manager. Room -> Map(clientId -> { ws, joinedAt, metadata })
const rooms = new Map()
const roomMetrics = new Map()
const REJOIN_GRACE_MS = 60_000

/**
 * Generate a 48-bit cryptographically random room ID (12 hex characters).
 */
export function generateRoomId() {
  return crypto.randomBytes(6).toString('hex')
}

/**
 * Validate room ID format — must be UUID, short hex (8-16), or base64url (8-22).
 */
export function isValidRoomId(roomId) {
  if (!roomId || typeof roomId !== 'string') return false
  const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
  const hexRegex = /^[0-9a-f]{8,16}$/i
  const base64Regex = /^[A-Za-z0-9_-]{8,22}$/
  return uuidRegex.test(roomId) || hexRegex.test(roomId) || base64Regex.test(roomId)
}

/**
 * @param {string} [roomId]
 * @returns {string} roomId
 */
export function createRoom(roomId = generateRoomId()) {
  if (roomId && !isValidRoomId(roomId)) {
    logger.warn({ roomId }, 'Invalid room ID format, generating new ID')
    roomId = generateRoomId()
  }

  if (!rooms.has(roomId)) {
    if (config.maxRooms > 0 && rooms.size >= config.maxRooms) {
      throw new Error('max-rooms-reached')
    }
    rooms.set(roomId, new Map())
    roomMetrics.set(roomId, {
      createdAt: Date.now(),
      peerCount: 0,
      maxPeerCount: 0
    })
    logger.info({ roomId, totalRooms: rooms.size }, 'Room created')
  }
  return roomId
}

export function hasRoom(roomId) {
  const deadline = roomMetrics.get(roomId)?.rejoinUntil
  if (deadline && deadline <= Date.now()) {
    rooms.delete(roomId)
    roomMetrics.delete(roomId)
  }
  return rooms.has(roomId)
}

export function addPeer(roomId, clientId, ws, metadata = {}) {
  if (!rooms.has(roomId)) createRoom(roomId)
  const room = rooms.get(roomId)
  const peerInfo = { ws, joinedAt: Date.now(), metadata }
  room.set(clientId, peerInfo)

  const metrics = roomMetrics.get(roomId)
  if (metrics) {
    delete metrics.rejoinUntil
    metrics.peerCount = room.size
    metrics.maxPeerCount = Math.max(metrics.maxPeerCount, room.size)
  }

  logger.info({ roomId, clientId, peerCount: room.size, metadata }, 'Peer joined room')
  return Array.from(room.keys())
}

export function removePeer(roomId, clientId, reason = 'disconnect') {
  if (!rooms.has(roomId)) {
    logger.warn({ roomId, clientId }, 'Attempted to remove peer from non-existent room')
    return
  }

  const room = rooms.get(roomId)
  const peerInfo = room.get(clientId)
  const duration = peerInfo ? Date.now() - peerInfo.joinedAt : 0

  room.delete(clientId)

  const metrics = roomMetrics.get(roomId)
  if (metrics) {
    metrics.peerCount = room.size
  }

  logger.info({ roomId, clientId, peerCount: room.size, duration, reason }, 'Peer left room')

  if (room.size === 0) {
    if (reason === 'ws-close' && peerInfo && metrics) {
      metrics.rejoinUntil = Date.now() + REJOIN_GRACE_MS
      return
    }
    const roomDuration = metrics ? Date.now() - metrics.createdAt : 0
    rooms.delete(roomId)
    roomMetrics.delete(roomId)
    logger.info({ roomId, duration: roomDuration }, 'Room destroyed (empty)')
  }
}

export function getPeers(roomId) {
  if (!rooms.has(roomId)) return []
  const room = rooms.get(roomId)
  return Array.from(room.entries()).map(([clientId, info]) => ({
    clientId,
    ws: info.ws,
    joinedAt: info.joinedAt,
    metadata: info.metadata
  }))
}

export function peerCount(roomId) {
  if (!rooms.has(roomId)) return 0
  return rooms.get(roomId).size
}

export function listRooms() {
  return Array.from(rooms.keys())
}

export function getRoomInfo(roomId) {
  if (!rooms.has(roomId)) return null
  const metrics = roomMetrics.get(roomId)
  if (!metrics) return null
  return {
    peerCount: metrics.peerCount,
    createdAt: metrics.createdAt,
    maxPeerCount: metrics.maxPeerCount,
    age: Date.now() - metrics.createdAt
  }
}

/**
 * Prune abandoned 0-peer rooms older than `maxAgeMs` (e.g., created via HTTP POST /create-room).
 */
export function pruneStaleRooms(maxAgeMs = 15 * 60 * 1000) {
  const now = Date.now()
  let pruned = 0
  for (const [roomId, room] of rooms.entries()) {
    const metrics = roomMetrics.get(roomId)
    if (room.size === 0 && metrics &&
        (metrics.rejoinUntil ? now >= metrics.rejoinUntil : now - metrics.createdAt > maxAgeMs)) {
      rooms.delete(roomId)
      roomMetrics.delete(roomId)
      pruned++
    }
  }
  if (pruned > 0) {
    logger.debug({ pruned, remainingRooms: rooms.size }, 'Pruned abandoned empty rooms')
  }
  return pruned
}

export function getStats() {
  let totalPeers = 0
  for (const room of rooms.values()) {
    totalPeers += room.size
  }
  return {
    totalRooms: rooms.size,
    totalPeers,
    avgPeersPerRoom: rooms.size > 0 ? Number((totalPeers / rooms.size).toFixed(2)) : 0
  }
}

export function _clearRooms() {
  rooms.clear()
  roomMetrics.clear()
}
