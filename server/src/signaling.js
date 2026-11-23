// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 BridgeCam Contributors

import crypto from 'crypto'
import { isIP } from 'node:net'
import { logger, generateRequestId, createRequestLogger } from './logger.js'
import { config } from './config.js'
import * as rooms from './room.js'
import { isValidRoomId, generateRoomId } from './room.js'

const clientRateLimits = new Map()
const ipConnectionLimits = new Map()
const IP_CONNECTION_WINDOW_MS = 60000

const ipRoomCreateLimits = new Map()
const ROOM_CREATE_LIMIT = 5
const ROOM_CREATE_WINDOW_MS = 60000

function safeSend(ws, obj) {
  if (!ws || ws.readyState !== 1) return false
  try {
    ws.send(JSON.stringify(obj))
    return true
  } catch (err) {
    logger.warn({ error: err.message }, 'Failed to send WebSocket message')
    return false
  }
}

function checkRateLimit(clientId) {
  const now = Date.now()
  const windowStart = now - config.rateLimit.windowMs

  if (!clientRateLimits.has(clientId)) {
    clientRateLimits.set(clientId, { timestamps: [] })
  }

  const clientData = clientRateLimits.get(clientId)
  clientData.timestamps = clientData.timestamps.filter(t => t > windowStart)

  if (clientData.timestamps.length >= config.rateLimit.maxMessages) {
    return false
  }

  clientData.timestamps.push(now)
  return true
}

function checkIpConnectionLimit(clientIp) {
  const now = Date.now()
  if (!ipConnectionLimits.has(clientIp)) {
    ipConnectionLimits.set(clientIp, { count: 1, windowStart: now })
    return true
  }

  const record = ipConnectionLimits.get(clientIp)
  if (now - record.windowStart > IP_CONNECTION_WINDOW_MS) {
    record.count = 1
    record.windowStart = now
    return true
  }

  if (record.count >= config.rateLimit.maxConnectionsPerIp) {
    return false
  }

  record.count++
  return true
}

function checkIpRoomCreateLimit(clientIp) {
  const now = Date.now()
  if (!ipRoomCreateLimits.has(clientIp)) {
    ipRoomCreateLimits.set(clientIp, { count: 1, windowStart: now })
    return true
  }

  const record = ipRoomCreateLimits.get(clientIp)
  if (now - record.windowStart > ROOM_CREATE_WINDOW_MS) {
    record.count = 1
    record.windowStart = now
    return true
  }

  if (record.count >= ROOM_CREATE_LIMIT) {
    return false
  }

  record.count++
  return true
}

function sanitizeString(str, maxLength = 256) {
  if (typeof str !== 'string') return ''
  return str.slice(0, maxLength).replace(/[<>'"&;]/g, '')
}

const VALID_APP_SIGNAL_TYPES = new Set([
  'quality-feedback',
  'diagnostic',
  'latency-ping',
  'latency-pong',
  'mic-mute',
  'sender-stats',
  'camera-capabilities',
  'camera-capabilities-request',
  'get-camera-capabilities',
  'camera-control',
  'camera-control-result',
  'camera-control-ack',
  'camera-paused',
  'camera-resumed'
])

export function isValidSignalPayload(payload) {
  if (typeof payload === 'string' && payload.startsWith('v=')) return true
  if (!payload || typeof payload !== 'object') return false

  const hasIceCandidate = typeof payload.candidate === 'object' && payload.candidate !== null
  const hasWebRTCStructure = (
    payload.type === 'offer' ||
    payload.type === 'answer' ||
    payload.type === 'pranswer' ||
    payload.type === 'rollback' ||
    hasIceCandidate
  )
  const isAppMessage = typeof payload.type === 'string' && VALID_APP_SIGNAL_TYPES.has(payload.type)
  return hasWebRTCStructure || isAppMessage
}

export function getClientIp(req, settings = config) {
  if (settings.render) {
    const address = req.headers?.['cf-connecting-ip']?.trim()
    if (address && isIP(address)) return address
  } else if (settings.trustProxy) {
    const address = req.headers?.['x-forwarded-for']?.split(',').at(-1)?.trim()
    if (address && isIP(address)) return address
  }
  return req.socket?.remoteAddress || 'unknown'
}

function getTurnServers(clientId) {
  const { urls, secret } = config.turn ?? {}
  if (!urls?.length || !secret) return []
  const expiresAt = Math.floor(Date.now() / 1000) + 24 * 60 * 60
  const username = `${expiresAt}:${clientId}`
  const credential = crypto.createHmac('sha1', secret).update(username).digest('base64')
  return [{ urls, username, credential }]
}

function removeClientFromRoom(ws, reason) {
  const roomId = ws._roomId
  if (!roomId) return
  ws._roomId = null
  rooms.removePeer(roomId, ws._clientId, reason)
  for (const peer of rooms.getPeers(roomId)) {
    safeSend(peer.ws, { action: 'peer-left', clientId: ws._clientId })
  }
}

export function attachSignaling(wsServer) {
  wsServer.on('connection', (ws, req) => {
    const clientIp = getClientIp(req)

    if (!checkIpConnectionLimit(clientIp)) {
      logger.warn({ clientIp }, 'Rate limit: Too many connections from IP')
      const elapsed = Date.now() - ipConnectionLimits.get(clientIp).windowStart
      const retryAfter = Math.max(1, Math.ceil((IP_CONNECTION_WINDOW_MS - elapsed) / 1000))
      safeSend(ws, { action: 'error', message: 'too-many-connections', retryAfter })
      ws.close(1013, 'Connection rate limit exceeded')
      return
    }

    const clientId = crypto.randomBytes(4).toString('hex')
    const reqId = generateRequestId()

    const log = createRequestLogger(logger, reqId)
    ws._clientId = clientId
    ws._reqId = reqId
    ws._clientIp = clientIp
    ws._isAlive = true
    let pendingJoin = null

    function cancelPendingJoin() {
      clearTimeout(pendingJoin)
      pendingJoin = null
    }

    function joinRoom(roomId, deadline) {
      if (ws.readyState !== 1) return
      if (!rooms.hasRoom(roomId)) {
        log.info({ roomId, clientId }, 'Join attempt for non-existent room')
        return safeSend(ws, { action: 'error', message: 'room-not-found' })
      }

      for (const peer of rooms.getPeers(roomId)) {
        if (peer.ws.readyState !== 1) removeClientFromRoom(peer.ws, 'ws-close')
      }
      if (ws._roomId === roomId) {
        return safeSend(ws, { action: 'joined', roomId, clientId, peerCount: rooms.peerCount(roomId), iceServers: getTurnServers(clientId) })
      }
      if (rooms.peerCount(roomId) >= 2) {
        // A refreshed browser can open its new socket before the proxy closes the old one.
        const remaining = deadline - Date.now()
        if (remaining > 0) {
          pendingJoin = setTimeout(() => {
            pendingJoin = null
            joinRoom(roomId, deadline)
          }, Math.min(remaining, 250))
          pendingJoin.unref()
          return
        }
        log.info({ roomId, clientId }, 'Join attempt for full room')
        return safeSend(ws, { action: 'error', message: 'room-full' })
      }

      removeClientFromRoom(ws, 'client-leave')
      rooms.addPeer(roomId, clientId, ws, { clientIp, joinedAt: Date.now() })
      ws._roomId = roomId
      ws._joinedAt = Date.now()

      const peers = rooms.getPeers(roomId)
      log.info({ roomId, clientId, peerCount: peers.length }, 'Peer joined room')
      safeSend(ws, { action: 'joined', roomId, clientId, peerCount: peers.length, iceServers: getTurnServers(clientId) })
      for (const peer of peers) {
        if (peer.clientId !== clientId) {
          safeSend(peer.ws, { action: 'peer-joined', clientId, iceServers: getTurnServers(peer.clientId) })
        }
      }
    }

    ws.on('pong', () => {
      ws._isAlive = true
    })

    log.info({ clientId, clientIp, reqId }, 'WebSocket client connected')
    safeSend(ws, { action: 'hello', clientId, reqId })

    ws.on('message', (raw) => {
      let msg
      try {
        msg = JSON.parse(raw)
      } catch (e) {
        log.warn({ error: e.message }, 'Invalid JSON received')
        return safeSend(ws, { action: 'error', message: 'invalid-json' })
      }

      if (typeof msg !== 'object' || msg === null) {
        return safeSend(ws, { action: 'error', message: 'invalid-message' })
      }

      const action = sanitizeString(msg.action, 32)
      let roomId = msg.roomId ? sanitizeString(msg.roomId, 64) : null
      const payload = msg.payload

      if (!checkRateLimit(clientId)) {
        log.warn({ clientId, roomId, action }, 'Rate limit exceeded')
        return safeSend(ws, {
          action: 'error',
          message: 'rate-limit-exceeded',
          retryAfter: Math.ceil(config.rateLimit.windowMs / 1000)
        })
      }

      const actionStart = Date.now()

      switch (action) {
        case 'create': {
          cancelPendingJoin()
          if (!checkIpRoomCreateLimit(clientIp)) {
            log.warn({ clientIp, roomId }, 'Room creation rate limit exceeded')
            return safeSend(ws, { action: 'error', message: 'room-create-rate-limit' })
          }

          if (roomId && !isValidRoomId(roomId)) {
            log.warn({ clientId, roomId }, 'Invalid room ID format')
            return safeSend(ws, { action: 'error', message: 'invalid-room-id' })
          }
          if (!roomId) {
            roomId = generateRoomId()
          }

          let id
          try {
            id = rooms.createRoom(roomId)
          } catch (err) {
            return safeSend(ws, { action: 'error', message: err.message || 'room-create-failed' })
          }
          rooms.addPeer(id, clientId, ws, { clientIp, createdAt: Date.now() })
          ws._roomId = id
          ws._joinedAt = Date.now()
          log.info({ roomId: id, clientId, action }, 'Room created')
          return safeSend(ws, { action: 'created', roomId: id, clientId, iceServers: getTurnServers(clientId) })
        }

        case 'join': {
          cancelPendingJoin()
          if (!roomId || !isValidRoomId(roomId)) {
            log.warn({ clientId, roomId }, 'Invalid room ID format')
            return safeSend(ws, { action: 'error', message: 'invalid-room-id' })
          }

          return joinRoom(roomId, Date.now() + 5000)
        }

        case 'signal': {
          if (!ws._roomId) {
            if (pendingJoin) return
            log.warn({ clientId, action }, 'Signal without room')
            return safeSend(ws, { action: 'error', message: 'not-in-room' })
          }
          if (!isValidSignalPayload(payload)) {
            log.warn({ clientId, action }, 'Invalid signal payload')
            return safeSend(ws, { action: 'error', message: 'invalid-payload' })
          }
          const signalType = payload?.type || 'unknown'
          let forwardedCount = 0
          for (const peer of rooms.getPeers(ws._roomId)) {
            if (peer.clientId === clientId) continue
            if (safeSend(peer.ws, { action: 'signal', from: clientId, payload })) {
              forwardedCount++
            }
          }
          log.debug(
            { roomId: ws._roomId, clientId, signalType, forwardedCount, duration: Date.now() - actionStart },
            'Signal forwarded to peers'
          )
          return
        }

        case 'leave': {
          cancelPendingJoin()
          removeClientFromRoom(ws, 'client-leave')
          return safeSend(ws, { action: 'left' })
        }

        default: {
          log.warn({ clientId, action, roomId }, 'Unknown action received')
          return safeSend(ws, { action: 'error', message: 'unknown-action' })
        }
      }
    })

    ws.on('close', () => {
      cancelPendingJoin()
      clientRateLimits.delete(clientId)
      const duration = ws._joinedAt ? Date.now() - ws._joinedAt : 0
      if (ws._roomId) {
        const rid = ws._roomId
        removeClientFromRoom(ws, 'ws-close')
        log.info({ roomId: rid, clientId, duration, reason: 'ws-close' }, 'Client disconnected')
      } else {
        log.info({ clientId, duration: 0 }, 'Client disconnected without joining room')
      }
    })

    ws.on('error', (err) => {
      log.error({ clientId, roomId: ws._roomId, error: err.message }, 'WebSocket error')
    })
  })

  wsServer.on('error', (err) => {
    logger.error({ error: err.message, stack: err.stack }, 'WebSocket server error')
  })

  // Periodic heartbeat + rate-limit/stale-room cleanup (unref'd so tests/shutdown exit cleanly)
  const heartbeatInterval = setInterval(() => {
    const now = Date.now()
    for (const [ip, rec] of ipConnectionLimits.entries()) {
      if (now - rec.windowStart > IP_CONNECTION_WINDOW_MS) ipConnectionLimits.delete(ip)
    }
    for (const [ip, rec] of ipRoomCreateLimits.entries()) {
      if (now - rec.windowStart > ROOM_CREATE_WINDOW_MS) ipRoomCreateLimits.delete(ip)
    }
    rooms.pruneStaleRooms()

    if (wsServer.clients) {
      for (const client of wsServer.clients) {
        if (client._isAlive === false) {
          client.terminate()
          continue
        }
        client._isAlive = false
        try { client.ping() } catch (_) {}
      }
    }

    const stats = rooms.getStats()
    logger.debug({ stats, rateLimitState: clientRateLimits.size }, 'Server stats')
  }, config.healthCheckInterval || 25000)

  if (typeof heartbeatInterval.unref === 'function') {
    heartbeatInterval.unref()
  }

  wsServer.on('close', () => {
    clearInterval(heartbeatInterval)
  })
}

export function _clearSignalingState() {
  clientRateLimits.clear()
  ipConnectionLimits.clear()
  ipRoomCreateLimits.clear()
}
