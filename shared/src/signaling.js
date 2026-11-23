// BridgeCam Shared Signaling Utilities
// Common WebSocket signaling message types and helpers

// Message action types
export const Action = {
  HELLO: 'hello',
  CREATE: 'create',
  CREATED: 'created',
  JOIN: 'join',
  JOINED: 'joined',
  PEER_JOINED: 'peer-joined',
  PEER_LEFT: 'peer-left',
  SIGNAL: 'signal',
  LEAVE: 'leave',
  LEFT: 'left',
  ERROR: 'error'
}

// Payload types for signal messages
export const SignalType = {
  OFFER: 'offer',
  ANSWER: 'answer',
  ICE: 'ice',
  DIAGNOSTIC: 'diagnostic',
  LATENCY_PING: 'latency-ping',
  LATENCY_PONG: 'latency-pong',
  QUALITY_FEEDBACK: 'quality-feedback',
  MIC_MUTE: 'mic-mute'
}

// Diagnostic levels
export const DiagnosticLevel = {
  INFO: 'info',
  WARNING: 'warning',
  ERROR: 'error'
}

// Build a signaling WebSocket URL from a base URL
export function buildSignalingUrl(baseUrl) {
  let url = baseUrl.trim()
  if (!url) url = `ws://localhost:${3000}/ws`
  url = url.replace(/^http/, 'ws')
  if (!url.endsWith('/ws')) url = url.replace(/\/?$/, '/ws')
  return url
}

// Build HTTP URL from base (for REST calls like create-room)
export function buildHttpUrl(baseUrl) {
  let url = baseUrl.trim() || 'http://localhost:3000'
  url = url.replace(/^ws/, 'http')
  url = url.replace(/\/ws\/?$/, '')
  return url
}

// Send a signal payload over WebSocket
export function sendSignal(ws, payload) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ action: Action.SIGNAL, payload }))
  }
}

// Send diagnostic message
export function sendDiagnostic(ws, level, message, code = null, deviceId = null) {
  sendSignal(ws, {
    type: SignalType.DIAGNOSTIC,
    level,
    code,
    message,
    deviceId
  })
}

// Send ICE candidate
export function sendIceCandidate(ws, candidate) {
  sendSignal(ws, { type: SignalType.ICE, candidate })
}

// Send latency ping
export function sendLatencyPing(ws, t = Date.now()) {
  sendSignal(ws, { type: SignalType.LATENCY_PING, t })
}

// Send latency pong
export function sendLatencyPong(ws, t) {
  sendSignal(ws, { type: SignalType.LATENCY_PONG, t })
}

// Send quality feedback
export function sendQualityFeedback(ws, fps, dropped, loss) {
  sendSignal(ws, { type: SignalType.QUALITY_FEEDBACK, fps, dropped, loss })
}

// Send mic mute state
export function sendMicMute(ws, muted) {
  sendSignal(ws, { type: SignalType.MIC_MUTE, muted })
}

// Parse incoming signaling message
export function parseSignalingMessage(raw) {
  try {
    return JSON.parse(raw)
  } catch {
    return null
  }
}

// Check if message is an error
export function isErrorMessage(msg) {
  return msg && msg.action === Action.ERROR
}

// Get reconnect delay with exponential backoff
export function getReconnectDelay(attempts, baseDelay = 1000, maxDelay = 30000) {
  return Math.min(baseDelay * Math.pow(2, attempts), maxDelay)
}