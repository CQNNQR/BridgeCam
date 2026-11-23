import { jest, describe, test, expect, beforeEach } from '@jest/globals'
import { createRoom, addPeer, removePeer, getPeers, peerCount, hasRoom, getRoomInfo, getStats, _clearRooms } from '../src/room.js'

describe('room.js', () => {
  beforeEach(() => {
    _clearRooms()
  })

  describe('createRoom()', () => {
    test('creates room with valid ID', () => {
      const roomId = createRoom('test-room-1')
      expect(roomId).toBe('test-room-1')
      expect(hasRoom(roomId)).toBe(true)
    })

    test('creates room with auto-generated ID when none provided', () => {
      const roomId = createRoom()
      expect(roomId).toBeDefined()
      expect(typeof roomId).toBe('string')
      expect(roomId.length).toBeGreaterThan(0)
    })

    test('returns existing room ID if already exists', () => {
      const roomId1 = createRoom('dup-room')
      const roomId2 = createRoom('dup-room')
      expect(roomId1).toBe(roomId2)
    })

    test('room info is tracked after creation', () => {
      const roomId = createRoom('info-test-room')
      const info = getRoomInfo(roomId)
      expect(info).toBeDefined()
      expect(info.peerCount).toBe(0)
      expect(info.createdAt).toBeDefined()
    })

    test('rejects invalid room ID format and generates new one', () => {
      const roomId = createRoom('invalid-room-id!')
      expect(roomId).toBeDefined()
      expect(roomId).not.toBe('invalid-room-id!')
    })
  })

  describe('addPeer()', () => {
    test('adds peer to room', () => {
      createRoom('add-peer-room')
      const mockWs = { send: jest.fn() }
      const peers = addPeer('add-peer-room', 'peer1', mockWs)
      expect(peers).toContain('peer1')
      expect(peerCount('add-peer-room')).toBe(1)
    })

    test('adds peer with metadata', () => {
      createRoom('metadata-room')
      const mockWs = { send: jest.fn() }
      const metadata = { displayName: 'Test User' }
      addPeer('metadata-room', 'peer1', mockWs, metadata)
      const peers = getPeers('metadata-room')
      expect(peers[0].metadata).toEqual(metadata)
    })

    test('adds multiple peers to room', () => {
      createRoom('multi-peer-room')
      const ws1 = { send: jest.fn() }
      const ws2 = { send: jest.fn() }
      addPeer('multi-peer-room', 'peer1', ws1)
      addPeer('multi-peer-room', 'peer2', ws2)
      expect(peerCount('multi-peer-room')).toBe(2)
      const peers = getPeers('multi-peer-room')
      expect(peers).toHaveLength(2)
    })

    test('adding same peer twice updates existing peer', () => {
      createRoom('double-peer-room')
      const ws = { send: jest.fn() }
      addPeer('double-peer-room', 'same-peer', ws)
      // Adding same peer again should update, not duplicate
      addPeer('double-peer-room', 'same-peer', ws)
      expect(peerCount('double-peer-room')).toBe(1)
    })

    test('auto-creates room if it does not exist when adding peer', () => {
      const mockWs = { send: jest.fn() }
      const peers = addPeer('auto-room', 'peer1', mockWs)
      expect(hasRoom('auto-room')).toBe(true)
      expect(peerCount('auto-room')).toBe(1)
    })

    test('records joinedAt timestamp', () => {
      createRoom('timestamp-room')
      const mockWs = { send: jest.fn() }
      const beforeAdd = Date.now()
      addPeer('timestamp-room', 'peer1', mockWs)
      const peers = getPeers('timestamp-room')
      expect(peers[0].joinedAt).toBeGreaterThanOrEqual(beforeAdd)
      expect(peers[0].joinedAt).toBeLessThanOrEqual(Date.now())
    })
  })

  describe('removePeer()', () => {
    test('removes peer from room', () => {
      createRoom('remove-peer-room')
      const ws = { send: jest.fn() }
      addPeer('remove-peer-room', 'to-remove', ws)
      removePeer('remove-peer-room', 'to-remove')
      expect(peerCount('remove-peer-room')).toBe(0)
    })

    test('removes peer and cleans up empty rooms', () => {
      createRoom('empty-room-cleanup')
      const ws = { send: jest.fn() }
      addPeer('empty-room-cleanup', 'lone-peer', ws)
      expect(hasRoom('empty-room-cleanup')).toBe(true)
      removePeer('empty-room-cleanup', 'lone-peer')
      expect(hasRoom('empty-room-cleanup')).toBe(false)
    })

    test('removing from non-existent room does not throw', () => {
      expect(() => removePeer('nonexistent-room', 'peer')).not.toThrow()
    })

    test('removing non-existent peer does not throw', () => {
      createRoom('room-with-no-such-peer')
      const ws = { send: jest.fn() }
      addPeer('room-with-no-such-peer', 'existing', ws)
      expect(() => removePeer('room-with-no-such-peer', 'missing')).not.toThrow()
    })

    test('removePeer with reason parameter', () => {
      createRoom('reason-room')
      const ws = { send: jest.fn() }
      addPeer('reason-room', 'peer1', ws)
      removePeer('reason-room', 'peer1', 'intentional-leave')
      expect(peerCount('reason-room')).toBe(0)
    })
  })

  describe('getPeers()', () => {
    test('returns correct peers for room', () => {
      createRoom('get-peers-room')
      const ws1 = { send: jest.fn() }
      const ws2 = { send: jest.fn() }
      addPeer('get-peers-room', 'peer-a', ws1)
      addPeer('get-peers-room', 'peer-b', ws2)
      const peers = getPeers('get-peers-room')
      expect(peers).toHaveLength(2)
      const clientIds = peers.map(p => p.clientId)
      expect(clientIds).toContain('peer-a')
      expect(clientIds).toContain('peer-b')
    })

    test('returns empty array for non-existent room', () => {
      const peers = getPeers('totally-fake-room')
      expect(peers).toEqual([])
    })

    test('returns empty array for empty room', () => {
      createRoom('empty-get-peers-room')
      const peers = getPeers('empty-get-peers-room')
      expect(peers).toEqual([])
    })

    test('peers contain ws and joinedAt', () => {
      createRoom('peer-info-room')
      const mockWs = { send: jest.fn() }
      addPeer('peer-info-room', 'peer1', mockWs)
      const peers = getPeers('peer-info-room')
      expect(peers[0].ws).toBe(mockWs)
      expect(peers[0].joinedAt).toBeDefined()
    })
  })

  describe('peerCount()', () => {
    test('returns accurate count', () => {
      createRoom('count-room')
      expect(peerCount('count-room')).toBe(0)
      addPeer('count-room', 'p1', { send: jest.fn() })
      expect(peerCount('count-room')).toBe(1)
      addPeer('count-room', 'p2', { send: jest.fn() })
      expect(peerCount('count-room')).toBe(2)
    })

    test('returns 0 for non-existent room', () => {
      expect(peerCount('nonexistent-count-room')).toBe(0)
    })
  })

  describe('getRoomInfo()', () => {
    test('returns room info with metrics', () => {
      const roomId = createRoom('info-metrics-room')
      const info = getRoomInfo(roomId)
      expect(info.peerCount).toBe(0)
      expect(info.createdAt).toBeDefined()
      expect(info.maxPeerCount).toBe(0)
    })

    test('tracks max peer count', () => {
      const roomId = createRoom('max-peer-room')
      addPeer(roomId, 'p1', { send: jest.fn() })
      addPeer(roomId, 'p2', { send: jest.fn() })
      const info = getRoomInfo(roomId)
      expect(info.maxPeerCount).toBe(2)
    })

    test('returns null for non-existent room', () => {
      expect(getRoomInfo('fake-room')).toBeNull()
    })
  })

  describe('getStats()', () => {
    test('returns aggregate server statistics', () => {
      const stats = getStats()
      expect(stats.totalRooms).toBeDefined()
      expect(stats.totalPeers).toBeDefined()
      expect(stats.avgPeersPerRoom).toBeDefined()
    })
  })
})