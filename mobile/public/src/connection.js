// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 BridgeCam Contributors
//
// Lightweight WebSocket helper for signaling

function safeSend(ws, payload) {
  if (!ws || ws.readyState !== WebSocket.OPEN) return false
  try {
    ws.send(JSON.stringify(payload))
    return true
  } catch (e) {
    console.warn('signaling send failed', e)
    return false
  }
}

export function connectSignaling(onMessage) {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws'
  const url = `${proto}://${location.host}/ws`
  const ws = new WebSocket(url)

  ws.addEventListener('open', () => console.log('signaling: open'))
  ws.addEventListener('message', (ev) => {
    try {
      const msg = JSON.parse(ev.data)
      onMessage(msg)
    } catch (e) {
      console.warn('invalid message', e)
    }
  })
  ws.addEventListener('close', () => console.log('signaling: closed'))
  ws.addEventListener('error', (e) => console.error('signaling error', e))

  return ws
}

export function joinRoom(ws, roomId) {
  return safeSend(ws, { action: 'join', roomId })
}

export function createRoom(ws) {
  return safeSend(ws, { action: 'create' })
}

export function sendSignal(ws, payload) {
  return safeSend(ws, { action: 'signal', payload })
}

export function leaveRoom(ws) {
  return safeSend(ws, { action: 'leave' })
}
