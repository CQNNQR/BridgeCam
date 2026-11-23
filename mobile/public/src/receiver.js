import { connectSignaling, joinRoom, sendSignal } from './connection.js'

const video = document.getElementById('remote')
const statusBadge = document.getElementById('status')
const roomInput = document.getElementById('roomInput')
const joinBtn = document.getElementById('joinBtn')
const errorEl = document.getElementById('error')
const params = new URLSearchParams(location.search)
const testCamera = params.get('testCamera') === '1' &&
  ['localhost', '127.0.0.1', '[::1]'].includes(location.hostname)

let ws = null
let pc = null
let roomId = null
let pendingIce = []
let latencyInterval = null
const latencyEl = document.getElementById('latency')
const statsEl = document.getElementById('stats')
let statsInterval = null
let lastInboundStats = null

// Auto-reconnect state (Sprint 10.2)
let reconnectAttempts = 0
const MAX_RECONNECT_ATTEMPTS = 10
const RECONNECT_BASE_DELAY = 1000
let reconnectTimer = null
let intentionalDisconnect = false

function setLatency(ms) {
  if (!latencyEl) return
  if (typeof ms === 'number') {
    latencyEl.textContent = `${ms} ms`
    latencyEl.hidden = false
  } else {
    latencyEl.textContent = '-- ms'
    latencyEl.hidden = true
  }
}

function setSenderDiagnostic(obj) {
  if (!statsEl) return
  const diagEl = document.getElementById('senderDiagnostic')
  if (!diagEl) return
  if (!obj) { 
    console.log(`📊 [RECEIVER] Clearing sender diagnostic`)
    diagEl.hidden = true
    diagEl.textContent = ''
    return
  }
  const when = new Date().toLocaleTimeString()
  const msg = `[${when}] ${obj.level || 'info'}: ${obj.code ? obj.code + ' - ' : ''}${obj.message || obj.text || JSON.stringify(obj)}`
  console.log(`📊 [RECEIVER] Displaying sender diagnostic: ${msg}`)
  diagEl.textContent = msg
  diagEl.hidden = false
}

function startReceiverStats() {
  if (!pc || statsInterval) return
  const conn = pc
  lastInboundStats = null
  statsInterval = setInterval(async () => {
    try {
      const s = await conn.getStats()
      if (pc !== conn) return
      s.forEach(r => {
        if (r.type === 'inbound-rtp' && (r.kind === 'video' || r.mediaType === 'video')) {
          const frames = r.framesDecoded || 0
          const dropped = r.framesDropped || 0
          const packetsLost = r.packetsLost || 0
          const packetsReceived = r.packetsReceived || 0
          if (lastInboundStats && lastInboundStats.frames != null) {
            const dt = (r.timestamp - lastInboundStats.ts) / 1000
            const fps = dt > 0 ? Math.round((frames - lastInboundStats.frames) / dt) : 0
            const droppedDelta = dropped - (lastInboundStats.dropped||0)
            if (conn.connectionState === 'connected') {
              const track = video.srcObject?.getVideoTracks()[0]
              if (track?.muted) setStatus('Camera paused')
              else if (fps > 0 && video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA) setStatus('🎥 Streaming')
              else if (frames === lastInboundStats.frames) setStatus('Waiting for video frames…')
            }
            if (statsEl) {
              statsEl.textContent = `fps: ${fps} | dropped: ${droppedDelta}`
              statsEl.hidden = false
            }

            // send feedback to sender for adaptive tuning
            const lossRatio = (packetsReceived + packetsLost) > 0 ? (packetsLost / (packetsReceived + packetsLost)) : 0
            if (ws && ws.readyState === WebSocket.OPEN) {
              sendSignal(ws, { type: 'quality-feedback', fps, dropped: droppedDelta, loss: lossRatio })
            }
          }
          lastInboundStats = { frames, dropped, ts: r.timestamp }
        }
      })
    } catch (e) { console.warn('receiver stats failed', e) }
  }, 3000)
}

function stopReceiverStats() { if (statsInterval) { clearInterval(statsInterval); statsInterval = null } }

// ── Auto-reconnect (Sprint 10.2) ─────────────────────────────────────

function getReconnectDelay() {
  return Math.min(RECONNECT_BASE_DELAY * Math.pow(2, reconnectAttempts), 30000)
}

function scheduleReconnect(minimumDelay = 0) {
  if (reconnectTimer) return
  if (intentionalDisconnect || reconnectAttempts >= MAX_RECONNECT_ATTEMPTS) {
    if (reconnectAttempts >= MAX_RECONNECT_ATTEMPTS) {
      showError(`Connection lost after ${MAX_RECONNECT_ATTEMPTS} attempts. Click "Join Room" to retry.`)
      setStatus('Disconnected')
    }
    return
  }

  const delay = Math.max(minimumDelay, getReconnectDelay())
  reconnectAttempts++
  console.log(`🔄 [RECEIVER] Scheduling reconnect ${reconnectAttempts}/${MAX_RECONNECT_ATTEMPTS} in ${delay}ms`)
  setStatus(minimumDelay ? `Server busy — retrying in ${Math.ceil(delay / 1000)} seconds` :
    `Reconnecting (${reconnectAttempts}/${MAX_RECONNECT_ATTEMPTS})…`)

  reconnectTimer = setTimeout(() => {
    reconnectTimer = null
    if (intentionalDisconnect) return
    connectAndJoin(roomId)
  }, delay)
}

function cancelReconnect() {
  if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null }
  reconnectAttempts = 0
}

const STUN_SERVERS = [
  { urls: 'stun:stun.l.google.com:19302' },
  { urls: 'stun:stun1.l.google.com:19302' },
  { urls: 'stun:stun.cloudflare.com:3478' }
]
let turnServers = []

function setStatus(s) {
  statusBadge.textContent = s
  if (s === 'Connecting' || s === 'Joined room' || s === 'Peer detected — waiting for offer' || s.startsWith('Reconnecting') || s.startsWith('Connection: connecting') || s.startsWith('Connection: new')) {
    statusBadge.classList.add('pulsing')
  } else {
    statusBadge.classList.remove('pulsing')
  }
}
function showError(msg){ errorEl.hidden = false; errorEl.textContent = msg }
function clearError(){ errorEl.hidden = true; errorEl.textContent = '' }

let rxDisconnectGrace = null

function resetPeerConnection() {
  if (rxDisconnectGrace) clearTimeout(rxDisconnectGrace)
  rxDisconnectGrace = null
  const oldPc = pc
  pc = null
  oldPc?.close()
  pendingIce = []
  stopReceiverStats()
  video.srcObject = null
}

function createPC(){
  const conn = new RTCPeerConnection({ iceServers: testCamera ? [] : [...STUN_SERVERS, ...turnServers] })

  conn.addEventListener('track', (ev) => {
    if (conn !== pc) return
    const stream = video.srcObject || ev.streams[0] || new MediaStream()
    if (!stream.getTracks().includes(ev.track)) stream.addTrack(ev.track)
    video.srcObject = stream
    video.play().catch(() => {})
    if (ev.track.kind === 'video') {
      video.requestVideoFrameCallback?.(() => {
        if (pc === conn && conn.connectionState === 'connected') setStatus('🎥 Streaming')
      })
    }
  })

  conn.addEventListener('icecandidate', (ev) => {
    if (conn !== pc) return
    if (ev.candidate && ws) {
      console.log('📤 sending ICE candidate', ev.candidate.type)
      sendSignal(ws, { type: 'ice', candidate: ev.candidate })
    }
  })

  conn.addEventListener('connectionstatechange', () => {
    if (conn !== pc) return
    console.log('🔗 connection state:', conn.connectionState)
    setStatus(`Connection: ${conn.connectionState}`)
    if (conn.connectionState === 'connected') {
      if (rxDisconnectGrace) { clearTimeout(rxDisconnectGrace); rxDisconnectGrace = null }
      cancelReconnect()
      return
    }
    if (conn.connectionState === 'disconnected' && !intentionalDisconnect) {
      if (!rxDisconnectGrace) {
        rxDisconnectGrace = setTimeout(() => {
          rxDisconnectGrace = null
          if (conn === pc && conn.connectionState === 'disconnected' && !intentionalDisconnect) {
            scheduleReconnect()
          }
        }, 4000)
      }
      return
    }
    if (conn.connectionState === 'failed' && !intentionalDisconnect) {
      if (rxDisconnectGrace) { clearTimeout(rxDisconnectGrace); rxDisconnectGrace = null }
      console.log('🔄 [RECEIVER] Peer connection failed — scheduling reconnect')
      scheduleReconnect()
    }
  })

  conn.addEventListener('iceconnectionstatechange', () => {
    console.log('🧊 ICE state:', conn.iceConnectionState)
  })

  conn._drainPending = async () => {
    console.log(`🚰 draining ${pendingIce.length} pending ICE candidates`)
    while (pendingIce.length) {
      const c = pendingIce.shift()
      try { await conn.addIceCandidate(c) } catch(e){ console.warn('addIceCandidate failed', e) }
    }
  }

  return conn
}

async function handleSignalingMessage(msg, activeWs){
  if (ws !== activeWs) return
  if (msg.action === 'joined' || msg.action === 'peer-joined') {
    turnServers = Array.isArray(msg.iceServers) ? msg.iceServers : []
    clearError()
  }

  // handle server-side error messages (room-full, room-not-found, etc.)
  if (msg.action === 'error') {
    const m = msg.message || 'Signaling error'
    if (m === 'too-many-connections') {
      scheduleReconnect(Number(msg.retryAfter) * 1000 || 30_000)
      return
    }
    if (m === 'room-full') {
      showError('Room is already in use — close other receiver or use the Host preview')
      setStatus('Room full')
    } else if (m === 'room-not-found') {
      showError('This room expired. Create a new room from the Host page.')
      setStatus('Room expired')
    } else {
      showError(m)
      return
    }
    intentionalDisconnect = true
    cancelReconnect()
    activeWs.close()
    return
  }

  if (msg.action === 'joined') {
    setStatus(msg.peerCount === 1 ? 'Waiting for camera…' : 'Joined room')
    latencyInterval ??= setInterval(() => {
      sendSignal(activeWs, { type: 'latency-ping', t: Date.now() })
    }, 2000)
  }
  if (msg.action === 'peer-joined') {
    setStatus('Peer detected — waiting for offer')
  }
  if (msg.action === 'peer-left') {
    if (reconnectTimer) clearTimeout(reconnectTimer)
    reconnectTimer = null
    resetPeerConnection()
    setStatus('Waiting for camera…')
  }
  if (msg.action === 'signal') {
    const payload = msg.payload
    if (!payload) return

    // latency messages
    if (payload.type === 'latency-pong') {
      const rtt = Date.now() - (payload.t || Date.now())
      setLatency(rtt)
      return
    }
    if (payload.type === 'latency-ping') {
      // reply immediately
      if (ws && ws.readyState === WebSocket.OPEN) sendSignal(ws, { type: 'latency-pong', t: payload.t || Date.now() })
      return
    }

    // diagnostic messages from sender (show on receiver UI)
    if (payload.type === 'diagnostic') {
      console.log(`📨 [RECEIVER] Received diagnostic from sender:`, payload)
      setSenderDiagnostic(payload)
      return
    }

    if (payload.type === 'offer') {
      if (!pc) pc = createPC()
      const conn = pc
      try {
        await conn.setRemoteDescription(payload)
        const answer = await conn.createAnswer()
        await conn.setLocalDescription(answer)
        if (pc !== conn || ws !== activeWs) return
        sendSignal(activeWs, conn.localDescription)
        if (conn.connectionState !== 'connected') setStatus('Answer sent')
        await conn._drainPending()
        if (pc === conn) startReceiverStats()
      } catch (e) {
        if (pc === conn && ws === activeWs) showError('Failed to handle offer')
        console.error(e)
      }
      return
    }

    if (payload.type === 'ice') {
      const candidate = payload.candidate
      if (!pc || !pc.remoteDescription) {
        pendingIce.push(candidate)
      } else {
        try { await pc.addIceCandidate(candidate) } catch(e){ console.warn('addIceCandidate failed', e) }
      }
    }
  }
}

function connectAndJoin(rid){
  if (ws) ws.close()
  clearInterval(latencyInterval)
  latencyInterval = null
  resetPeerConnection()
  intentionalDisconnect = false
  const activeWs = connectSignaling(msg => handleSignalingMessage(msg, activeWs))
  ws = activeWs
  activeWs.addEventListener('open', () => {
    if (ws !== activeWs) return
    joinRoom(activeWs, rid)
    setStatus('Connecting')

  })
  activeWs.addEventListener('close', () => {
    if (ws !== activeWs) return
    if (latencyInterval) { clearInterval(latencyInterval); latencyInterval = null }
    setLatency(null)
    stopReceiverStats()
    if (!intentionalDisconnect && roomId) {
      console.log('🔄 [RECEIVER] WebSocket closed — scheduling reconnect')
      scheduleReconnect()
    }
  })
}

const onJoinClick = () => {
  const rid = roomInput.value.trim()
  if (!rid) return showError('Enter a room id')
  if (rid === roomId && !intentionalDisconnect &&
      (reconnectTimer || (ws && ws.readyState <= WebSocket.OPEN))) return
  clearError()
  cancelReconnect()
  roomId = rid
  connectAndJoin(roomId)
}

if (joinBtn) {
  if (typeof joinBtn.addEventListener === 'function') {
    joinBtn.addEventListener('click', onJoinClick)
  } else {
    // fallback for unusual environments where addEventListener is missing
    joinBtn.onclick = onJoinClick
  }
} else {
  console.warn('joinBtn not found in DOM')
}

// Auto-join if ?room= is present
(function init(){
  if (params.has('room')) {
    roomInput.value = params.get('room')
    if (joinBtn && typeof joinBtn.click === 'function') joinBtn.click()
    else onJoinClick()
  }
})();
