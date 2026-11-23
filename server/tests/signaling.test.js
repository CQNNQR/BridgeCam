import { jest, describe, test, expect, beforeEach, afterEach } from '@jest/globals'
import { attachSignaling, getClientIp, _clearSignalingState } from '../src/signaling.js'
import { _clearRooms } from '../src/room.js'

// Mock WebSocket class
class MockWebSocket {
  constructor() {
    this._clientId = null
    this._roomId = null
    this._listeners = {}
    this._sentMessages = []
    this.readyState = 1 // OPEN
  }

  on(event, handler) {
    if (!this._listeners[event]) this._listeners[event] = []
    this._listeners[event].push(handler)
  }

  emit(event, ...args) {
    if (this._listeners[event]) {
      this._listeners[event].forEach(h => h(...args))
    }
  }

  send(data) {
    this._sentMessages.push(JSON.parse(data))
  }

  // Helper to simulate receiving a message
  receive(data) {
    this.emit('message', data)
  }

  // Helper to simulate closing
  close() {
    this.readyState = 3 // CLOSED
    this.emit('close')
  }

  // Clear sent messages between tests
  _clearMessages() {
    this._sentMessages = []
  }
}

// Create a mock wsServer
function createMockWsServer() {
  const listeners = {}
  return {
    on(event, handler) {
      if (!listeners[event]) listeners[event] = []
      listeners[event].push(handler)
    },
    _triggerConnection(ws, req = {}) {
      if (listeners['connection']) {
        listeners['connection'].forEach(h => h(ws, req))
      }
    },
    _listeners: listeners
  }
}

describe('signaling.js', () => {
  let wsServer
  let connectedWs

  beforeEach(() => {
    _clearRooms()
    _clearSignalingState()
    wsServer = createMockWsServer()
    connectedWs = null

    // Attach signaling and capture the connected websocket
    attachSignaling(wsServer)

    // Trigger a connection and capture the ws
    const mockWs = new MockWebSocket()
    wsServer._triggerConnection(mockWs, { headers: {}, socket: { remoteAddress: '127.0.0.1' } })
    connectedWs = mockWs

    // First message should be 'hello' with clientId
    const helloMsg = connectedWs._sentMessages[0]
    expect(helloMsg.action).toBe('hello')
    expect(helloMsg.clientId).toBeDefined()

    // Clear messages after setup
    connectedWs._clearMessages()
  })

  afterEach(() => {
    _clearRooms()
    _clearSignalingState()
  })

  test('tells a rate-limited client when it can reconnect', () => {
    const request = { headers: {}, socket: { remoteAddress: '127.0.0.1' } }
    for (let count = 0; count < 9; count++) {
      const ws = new MockWebSocket()
      wsServer._triggerConnection(ws, request)
      ws.close()
    }
    const rejected = new MockWebSocket()
    wsServer._triggerConnection(rejected, request)
    const [message] = rejected._sentMessages
    expect(message).toMatchObject({ action: 'error', message: 'too-many-connections' })
    expect(message.retryAfter).toBeGreaterThan(0)
    expect(message.retryAfter).toBeLessThanOrEqual(60)
    expect(rejected.readyState).toBe(3)
  })

  describe('Message type routing', () => {
    test('routes "create" action to room creation', () => {
      connectedWs.receive(JSON.stringify({ action: 'create', roomId: 'test-room-xyz' }))
      const createMsg = connectedWs._sentMessages.find(m => m.action === 'created')
      expect(createMsg).toBeDefined()
      expect(createMsg.roomId).toBe('test-room-xyz')
    })

    test('routes "join" action to room join', () => {
      // First create a room
      connectedWs.receive(JSON.stringify({ action: 'create', roomId: 'join-test-room' }))
      connectedWs._clearMessages()

      // Try to join it (need a new ws for this)
      const joinerWs = new MockWebSocket()
      wsServer._triggerConnection(joinerWs, { headers: {}, socket: { remoteAddress: '127.0.0.1' } })
      joinerWs.receive(JSON.stringify({ action: 'join', roomId: 'join-test-room' }))
      const joinMsg = joinerWs._sentMessages.find(m => m.action === 'joined')
      expect(joinMsg).toBeDefined()
      expect(joinMsg.roomId).toBe('join-test-room')
      expect(joinMsg.peerCount).toBe(2)
    })

    test('routes "leave" action to room leave', () => {
      connectedWs.receive(JSON.stringify({ action: 'create', roomId: 'leave-test-room' }))
      connectedWs._clearMessages()
      connectedWs.receive(JSON.stringify({ action: 'leave' }))
      const leaveMsg = connectedWs._sentMessages.find(m => m.action === 'left')
      expect(leaveMsg).toBeDefined()
    })

    test('routes unknown action to error', () => {
      connectedWs.receive(JSON.stringify({ action: 'unknown-action' }))
      const errMsg = connectedWs._sentMessages.find(m => m.action === 'error')
      expect(errMsg).toBeDefined()
      expect(errMsg.message).toBe('unknown-action')
    })
  })

  describe('Validation of incoming messages', () => {
    test('handles invalid JSON gracefully', () => {
      connectedWs.emit('message', 'not-valid-json{')
      const errMsg = connectedWs._sentMessages.find(m => m.action === 'error')
      expect(errMsg).toBeDefined()
      expect(errMsg.message).toBe('invalid-json')
    })

    test('handles missing action field', () => {
      connectedWs.receive(JSON.stringify({ roomId: 'some-room' }))
      const errMsg = connectedWs._sentMessages.find(m => m.action === 'error')
      expect(errMsg).toBeDefined()
    })

    test('joins with missing roomId returns error', () => {
      connectedWs.receive(JSON.stringify({ action: 'join' }))
      const errMsg = connectedWs._sentMessages.find(m => m.action === 'error')
      expect(errMsg).toBeDefined()
    })
  })

  describe('Error handling for malformed messages', () => {
    test('handles empty message object', () => {
      connectedWs.receive(JSON.stringify({}))
      const errMsg = connectedWs._sentMessages.find(m => m.action === 'error')
      expect(errMsg).toBeDefined()
    })

    test('handles null values in message', () => {
      connectedWs.receive(JSON.stringify({ action: null, roomId: null }))
      const errMsg = connectedWs._sentMessages.find(m => m.action === 'error')
      expect(errMsg).toBeDefined()
    })
  })

  describe('Room creation on "create" action', () => {
    test('creates room with specified ID', () => {
      connectedWs.receive(JSON.stringify({ action: 'create', roomId: 'my-custom-room' }))
      const msg = connectedWs._sentMessages.find(m => m.action === 'created')
      expect(msg.roomId).toBe('my-custom-room')
    })

    test('creates room with generated ID when not specified', () => {
      connectedWs.receive(JSON.stringify({ action: 'create' }))
      const msg = connectedWs._sentMessages.find(m => m.action === 'created')
      expect(msg.roomId).toBeDefined()
      expect(msg.roomId.length).toBeGreaterThan(0)
    })

    test('assigns clientId in created response', () => {
      connectedWs.receive(JSON.stringify({ action: 'create', roomId: 'id-check-room' }))
      const msg = connectedWs._sentMessages.find(m => m.action === 'created')
      expect(msg.clientId).toBeDefined()
    })

    test('rejects invalid room ID format', () => {
      connectedWs.receive(JSON.stringify({ action: 'create', roomId: 'invalid!' }))
      const errMsg = connectedWs._sentMessages.find(m => m.action === 'error')
      expect(errMsg).toBeDefined()
      expect(errMsg.message).toBe('invalid-room-id')
    })
  })

  describe('Peer join notifications', () => {
    test('notifies existing peers when new peer joins', () => {
      // Create room with first peer
      connectedWs.receive(JSON.stringify({ action: 'create', roomId: 'notify-room' }))
      connectedWs._clearMessages()

      // Second peer joins
      const secondWs = new MockWebSocket()
      wsServer._triggerConnection(secondWs, { headers: {}, socket: { remoteAddress: '127.0.0.1' } })
      secondWs.receive(JSON.stringify({ action: 'join', roomId: 'notify-room' }))
      secondWs._clearMessages()

      // First peer should receive peer-joined notification
      const notifyMsg = connectedWs._sentMessages.find(m => m.action === 'peer-joined')
      expect(notifyMsg).toBeDefined()
    })

    test.each([false, true])('handles a full room when an old socket closes: %s', (oldSocketCloses) => {
      // Create and join with first two peers
      connectedWs.receive(JSON.stringify({ action: 'create', roomId: 'full-room' }))
      connectedWs._clearMessages()

      const peer2Ws = new MockWebSocket()
      wsServer._triggerConnection(peer2Ws, { headers: {}, socket: { remoteAddress: '127.0.0.1' } })
      peer2Ws.receive(JSON.stringify({ action: 'join', roomId: 'full-room' }))
      peer2Ws._clearMessages()

      const peer3Ws = new MockWebSocket()
      wsServer._triggerConnection(peer3Ws, { headers: {}, socket: { remoteAddress: '127.0.0.1' } })
      jest.useFakeTimers()
      try {
        peer3Ws.receive(JSON.stringify({ action: 'join', roomId: 'full-room' }))
        expect(peer3Ws._sentMessages.map(m => m.action)).toEqual(['hello'])
        if (oldSocketCloses) {
          peer2Ws.close()
          jest.advanceTimersByTime(250)
          expect(peer3Ws._sentMessages.at(-1)).toMatchObject({ action: 'joined', peerCount: 2 })
        } else {
          jest.advanceTimersByTime(5000)
          expect(peer3Ws._sentMessages.at(-1)).toMatchObject({ action: 'error', message: 'room-full' })
        }
      } finally {
        jest.useRealTimers()
      }
    })

    test('join fails when room does not exist', () => {
      const newWs = new MockWebSocket()
      wsServer._triggerConnection(newWs, { headers: {}, socket: { remoteAddress: '127.0.0.1' } })
      newWs.receive(JSON.stringify({ action: 'join', roomId: 'nonexistent-room' }))
      const errMsg = newWs._sentMessages.find(m => m.action === 'error')
      expect(errMsg).toBeDefined()
      expect(errMsg.message).toBe('room-not-found')
    })
  })

  describe('Signal forwarding between peers', () => {
    test('forwards signal to other peers in room', () => {
      // Create room with first peer
      connectedWs.receive(JSON.stringify({ action: 'create', roomId: 'signal-room' }))
      connectedWs._clearMessages()

      // Second peer joins
      const secondWs = new MockWebSocket()
      wsServer._triggerConnection(secondWs, { headers: {}, socket: { remoteAddress: '127.0.0.1' } })
      secondWs.receive(JSON.stringify({ action: 'join', roomId: 'signal-room' }))
      secondWs._clearMessages()

      // First peer sends signal
      connectedWs.receive(JSON.stringify({ action: 'signal', payload: { type: 'offer', sdp: 'test-sdp' } }))

      // Second peer should receive the signal
      const signalMsg = secondWs._sentMessages.find(m => m.action === 'signal')
      expect(signalMsg).toBeDefined()
      expect(signalMsg.payload).toEqual({ type: 'offer', sdp: 'test-sdp' })
      expect(signalMsg.from).toBeDefined()
    })

    test('signal fails when not in a room', () => {
      // Fresh connection, no room joined
      const newWs = new MockWebSocket()
      wsServer._triggerConnection(newWs, { headers: {}, socket: { remoteAddress: '127.0.0.1' } })
      newWs._clearMessages()

      newWs.receive(JSON.stringify({ action: 'signal', payload: { type: 'offer', sdp: 'test' } }))
      const errMsg = newWs._sentMessages.find(m => m.action === 'error')
      expect(errMsg).toBeDefined()
      expect(errMsg.message).toBe('not-in-room')
    })

    test('signal rejects invalid payload', () => {
      connectedWs.receive(JSON.stringify({ action: 'create', roomId: 'invalid-signal-room' }))
      connectedWs._clearMessages()

      connectedWs.receive(JSON.stringify({ action: 'signal', payload: { invalid: 'payload' } }))
      const errMsg = connectedWs._sentMessages.find(m => m.action === 'error')
      expect(errMsg).toBeDefined()
      expect(errMsg.message).toBe('invalid-payload')
    })
  })

  describe('Leave message handling', () => {
    test('sends left confirmation on leave', () => {
      connectedWs.receive(JSON.stringify({ action: 'create', roomId: 'leave-handler-room' }))
      connectedWs._clearMessages()
      connectedWs.receive(JSON.stringify({ action: 'leave' }))
      const leftMsg = connectedWs._sentMessages.find(m => m.action === 'left')
      expect(leftMsg).toBeDefined()
    })

    test('notifies other peers when peer leaves', () => {
      // Create room with first peer
      connectedWs.receive(JSON.stringify({ action: 'create', roomId: 'leave-notify-room' }))
      connectedWs._clearMessages()

      // Second peer joins
      const secondWs = new MockWebSocket()
      wsServer._triggerConnection(secondWs, { headers: {}, socket: { remoteAddress: '127.0.0.1' } })
      secondWs.receive(JSON.stringify({ action: 'join', roomId: 'leave-notify-room' }))
      secondWs._clearMessages()

      // First peer leaves
      connectedWs.receive(JSON.stringify({ action: 'leave' }))

      // Second peer should receive peer-left notification
      const leftMsg = secondWs._sentMessages.find(m => m.action === 'peer-left')
      expect(leftMsg).toBeDefined()
    })

    test('leaving when not in room does not throw', () => {
      const newWs = new MockWebSocket()
      wsServer._triggerConnection(newWs, { headers: {}, socket: { remoteAddress: '127.0.0.1' } })
      expect(() => newWs.receive(JSON.stringify({ action: 'leave' }))).not.toThrow()
    })
  })

  describe('WebSocket close handling', () => {
    test('allows peers to rejoin when both signaling sockets close', () => {
      connectedWs.receive(JSON.stringify({ action: 'create', roomId: 'rejoin-room' }))
      connectedWs.close()
      const replacement = new MockWebSocket()
      wsServer._triggerConnection(replacement, { headers: {}, socket: { remoteAddress: '127.0.0.1' } })
      replacement.receive(JSON.stringify({ action: 'join', roomId: 'rejoin-room' }))
      expect(replacement._sentMessages.at(-1)).toMatchObject({ action: 'joined', peerCount: 1 })
    })
    test('removes peer and notifies on close', () => {
      connectedWs.receive(JSON.stringify({ action: 'create', roomId: 'close-room' }))
      connectedWs._clearMessages()

      const secondWs = new MockWebSocket()
      wsServer._triggerConnection(secondWs, { headers: {}, socket: { remoteAddress: '127.0.0.1' } })
      secondWs.receive(JSON.stringify({ action: 'join', roomId: 'close-room' }))
      secondWs._clearMessages()

      // First peer closes connection
      connectedWs.close()

      // Second peer should be notified
      const leftMsg = secondWs._sentMessages.find(m => m.action === 'peer-left')
      expect(leftMsg).toBeDefined()
    })
  })
})

test('uses the client address supplied by Render ingress for HTTP and WebSocket requests', () => {
  const request = {
    headers: { 'cf-connecting-ip': '203.0.113.5', 'x-forwarded-for': '192.0.2.1, 203.0.113.5' },
    socket: { remoteAddress: '10.0.0.1' }
  }
  expect(getClientIp(request, { render: true })).toBe('203.0.113.5')
  expect(getClientIp(request, { trustProxy: true })).toBe('203.0.113.5')
  expect(getClientIp(request, {})).toBe('10.0.0.1')
})
