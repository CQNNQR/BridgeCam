// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 BridgeCam Contributors

import { buildConstraints, listVideoInputs, getCameraStream, getTestCameraStream } from './camera.js'
import { connectSignaling, joinRoom, sendSignal, leaveRoom } from './connection.js'

const video = document.getElementById('preview')
const cameraSelect = document.getElementById('cameraSelect')
const resolutionSelect = document.getElementById('resolutionSelect')
const frameRateSelect = document.getElementById('frameRateSelect')
const startBtn = document.getElementById('startBtn')
const stopBtn = document.getElementById('stopBtn')
const statusBadge = document.getElementById('status')
const errorEl = document.getElementById('error')
const wakeLockToggle = document.getElementById('wakeLockToggle')
const micToggle = document.getElementById('micToggle')
const disableAutoFallback = document.getElementById('disableAutoFallback')
const stealthToggle = document.getElementById('stealthToggle')
const installBtn = document.getElementById('installBtn')
const params = new URLSearchParams(location.search)
const testCamera = params.get('testCamera') === '1' && params.has('room') &&
  ['localhost', '127.0.0.1', '[::1]'].includes(location.hostname)

let localStream = null
let wakeLock = null
let ws = null
let roomId = null
let lastWorkingDeviceId = null      // track last camera that successfully started
const failedDeviceIds = new Set()   // cameras that always fail — mark as unavailable

// ── Advanced Camera Controls (Sprint 9) ─────────────────────────────
// Queries the active video track for supported capabilities and returns
// a serializable object the desktop can use to build dynamic UI controls.
function getCameraCapabilities() {
  if (!localStream) return null
  const track = localStream.getVideoTracks()[0]
  if (!track || track.readyState !== 'live') return null

  // getCapabilities() isn't supported everywhere — guard gracefully
  if (typeof track.getCapabilities !== 'function') {
    console.warn('⚠️ [SENDER] track.getCapabilities() not supported')
    return null
  }

  const caps = track.getCapabilities()
  const settings = track.getSettings()
  const result = {}

  // Zoom
  if (caps.zoom) {
    result.zoom = { min: caps.zoom.min, max: caps.zoom.max, step: caps.zoom.step || 0.1, current: settings.zoom ?? caps.zoom.min }
  }

  // Torch (flash)
  if (caps.torch) {
    result.torch = { supported: true, current: settings.torch ?? false }
  }

  // Focus mode
  if (caps.focusMode && caps.focusMode.length) {
    result.focusMode = { modes: caps.focusMode, current: settings.focusMode ?? caps.focusMode[0] }
  }

  // Focus distance (manual focus)
  if (caps.focusDistance) {
    result.focusDistance = { min: caps.focusDistance.min, max: caps.focusDistance.max, step: caps.focusDistance.step || 0.01, current: settings.focusDistance ?? caps.focusDistance.min }
  }

  // Exposure mode
  if (caps.exposureMode && caps.exposureMode.length) {
    result.exposureMode = { modes: caps.exposureMode, current: settings.exposureMode ?? caps.exposureMode[0] }
  }

  // Exposure compensation (brightness)
  if (caps.exposureCompensation) {
    result.exposureCompensation = { min: caps.exposureCompensation.min, max: caps.exposureCompensation.max, step: caps.exposureCompensation.step || 0.1, current: settings.exposureCompensation ?? 0 }
  }

  // Exposure time (shutter speed)
  if (caps.exposureTime) {
    result.exposureTime = { min: caps.exposureTime.min, max: caps.exposureTime.max, step: caps.exposureTime.step || 1, current: settings.exposureTime ?? caps.exposureTime.min }
  }

  // White balance mode
  if (caps.whiteBalanceMode && caps.whiteBalanceMode.length) {
    result.whiteBalanceMode = { modes: caps.whiteBalanceMode, current: settings.whiteBalanceMode ?? caps.whiteBalanceMode[0] }
  }

  // Color temperature
  if (caps.colorTemperature) {
    result.colorTemperature = { min: caps.colorTemperature.min, max: caps.colorTemperature.max, step: caps.colorTemperature.step || 50, current: settings.colorTemperature ?? 5500 }
  }

  // ISO
  if (caps.iso) {
    result.iso = { min: caps.iso.min, max: caps.iso.max, step: caps.iso.step || 1, current: settings.iso ?? caps.iso.min }
  }

  // Brightness (distinct from exposure compensation on some devices)
  if (caps.brightness) {
    result.brightness = { min: caps.brightness.min, max: caps.brightness.max, step: caps.brightness.step || 1, current: settings.brightness ?? 0 }
  }

  // Contrast
  if (caps.contrast) {
    result.contrast = { min: caps.contrast.min, max: caps.contrast.max, step: caps.contrast.step || 1, current: settings.contrast ?? 0 }
  }

  // Saturation
  if (caps.saturation) {
    result.saturation = { min: caps.saturation.min, max: caps.saturation.max, step: caps.saturation.step || 1, current: settings.saturation ?? 0 }
  }

  // Sharpness
  if (caps.sharpness) {
    result.sharpness = { min: caps.sharpness.min, max: caps.sharpness.max, step: caps.sharpness.step || 1, current: settings.sharpness ?? 0 }
  }

  console.log('📷 [SENDER] Camera capabilities:', result)
  return Object.keys(result).length > 0 ? result : null
}

// Send current camera capabilities to desktop via signaling relay
function sendCameraCapabilities() {
  if (!ws || ws.readyState !== WebSocket.OPEN) return
  const track = localStream?.getVideoTracks?.()[0]
  const ready = !!track && track.readyState === 'live'
  const hasGetCapabilities = ready && typeof track.getCapabilities === 'function'
  const caps = hasGetCapabilities ? getCameraCapabilities() : null

  sendSignal(ws, {
    type: 'camera-capabilities',
    capabilities: caps || {},
    ready,
    supported: !!caps
  })

  if (!ready) {
    console.log('📤 [SENDER] Camera capabilities deferred: track not ready')
  } else if (!hasGetCapabilities || !caps) {
    console.log('📤 [SENDER] Camera capabilities unsupported on this browser/device')
  } else {
    console.log('📤 [SENDER] Sent camera capabilities to desktop')
  }
}

// Apply a camera control command received from the desktop
async function applyCameraControl(control) {
  if (!localStream) return { success: false, error: 'No active stream' }
  const track = localStream.getVideoTracks()[0]
  if (!track || track.readyState !== 'live') return { success: false, error: 'No active video track' }

  try {
    const constraint = {}

    // Map control name to constraint — uses advanced constraints for
    // properties not in the basic constraint set
    const advancedProps = ['torch', 'zoom', 'focusMode', 'focusDistance',
      'exposureMode', 'exposureCompensation', 'exposureTime',
      'whiteBalanceMode', 'colorTemperature', 'iso',
      'brightness', 'contrast', 'saturation', 'sharpness']

    if (advancedProps.includes(control.name)) {
      constraint[control.name] = control.value
    } else {
      return { success: false, error: `Unknown control: ${control.name}` }
    }

    console.log(`🎛️ [SENDER] Applying camera control: ${control.name} = ${control.value}`)
    await track.applyConstraints({ advanced: [constraint] })

    // Read back the actual value after applying
    const settings = track.getSettings()
    const actual = settings[control.name]
    console.log(`✅ [SENDER] Control applied: ${control.name} = ${actual}`)
    return { success: true, name: control.name, value: actual }
  } catch (err) {
    console.error(`❌ [SENDER] Failed to apply control ${control.name}:`, err)
    return { success: false, error: err.message || String(err) }
  }
}

// Auto-reconnect state (Sprint 10.2)
let reconnectAttempts = 0
const MAX_RECONNECT_ATTEMPTS = 10
const RECONNECT_BASE_DELAY = 1000   // 1s initial, exponential backoff up to ~30s
let reconnectTimer = null
let intentionalDisconnect = false    // skip reconnect when user manually stops

function setStatus(s) {
  statusBadge.textContent = s
  if (s === 'Starting' || s === 'Joined room — starting negotiation' || s === 'Offer sent — waiting for answer' || s.startsWith('Connection: connecting') || s.startsWith('Connection: new')) {
    statusBadge.classList.add('pulsing')
  } else {
    statusBadge.classList.remove('pulsing')
  }
}
function showError(msg) { errorEl.hidden = false; errorEl.textContent = msg }
function clearError() { errorEl.hidden = true; errorEl.textContent = '' }

async function populateCameras() {
  if (testCamera) {
    cameraSelect.replaceChildren(new Option('Simulated camera', 'simulated'))
    cameraSelect.disabled = true
    return
  }
  try {
    const cams = await listVideoInputs()
    cameraSelect.innerHTML = ''
    cams.forEach((c, idx) => {
      const opt = document.createElement('option')
      opt.value = c.deviceId
      const label = c.label || `Camera ${idx + 1}`
      // mark cameras that have persistently failed as unavailable
      if (failedDeviceIds.has(c.deviceId)) {
        opt.textContent = `${label} (unavailable)`
        opt.disabled = true
        opt.style.color = '#888'
      } else {
        opt.textContent = label
      }
      cameraSelect.appendChild(opt)
    })

    // if we already have an active stream, try to select its deviceId
    if (localStream) {
      const [track] = localStream.getVideoTracks()
      if (track) {
        const settings = track.getSettings()
        if (settings && settings.deviceId) {
          const hasOption = Array.from(cameraSelect.options).some(o => o.value === settings.deviceId && !o.disabled)
          if (hasOption) cameraSelect.value = settings.deviceId
        }
      }
    }
  } catch (e) {
    showError('Unable to enumerate cameras — permission required')
  }
}

async function attemptGetCameraStream(deviceId, resolution, fps, maxAttempts = 4, withAudio = false) {
  if (testCamera) return getTestCameraStream()
  console.log(`📹 [SENDER] attemptGetCameraStream: deviceId=${deviceId || 'default'}, resolution=${resolution}, fps=${fps}, audio=${withAudio}, maxAttempts=${maxAttempts}`)
  let attempt = 0
  const backoffs = [500, 1000, 1500, 2000]
  while (attempt < maxAttempts) {
    try {
      console.log(`📹 [SENDER] Attempt ${attempt+1}/${maxAttempts}: calling getCameraStream...`)
      const stream = await getCameraStream(deviceId, resolution, fps, withAudio)
      console.log(`✅ [SENDER] getCameraStream succeeded on attempt ${attempt+1}/${maxAttempts}`)
      return stream
    } catch (err) {
      const msg = (err && err.message) || err
      console.error(`❌ [SENDER] getCameraStream failed (attempt ${attempt+1}/${maxAttempts}):`, err, `| errorName=${err.name}, message=${err.message}`)
      // retry for transient hardware/busy errors
      const transient = err && (err.name === 'NotReadableError' || err.name === 'TrackStartError' || err.name === 'OverconstrainedError' || /could not start video source/i.test(msg))
      console.log(`🔍 [SENDER] Error classified as transient=${transient}, will retry=${transient && attempt < maxAttempts - 1}`)
      if (transient && attempt < maxAttempts - 1) {
        // refresh device list and wait a bit before retrying
        console.log(`🔄 [SENDER] Refreshing device list before retry...`)
        try { await listVideoInputs() } catch(e){ console.warn('listVideoInputs failed during retry:', e) }
        const backoff = backoffs[Math.min(attempt, backoffs.length-1)]
        console.log(`⏳ [SENDER] Waiting ${backoff}ms before retry ${attempt+2}/${maxAttempts}...`)
        await new Promise(res => setTimeout(res, backoff))
        attempt++
        continue
      }
      console.error(`🛑 [SENDER] All retry attempts exhausted or non-transient error. Throwing.`)
      throw err
    }
  }
}

async function startCamera() {
  console.log(`🚀 [SENDER] startCamera called`)
  clearError()
  setStatus('Starting')
  startBtn.disabled = true
  intentionalDisconnect = false  // reset so auto-reconnect works
  cancelReconnect()
  const deviceId = cameraSelect.value || undefined
  const resolution = resolutionSelect.value || '1080'
  console.log(`📹 [SENDER] Selected camera: deviceId=${deviceId || 'default'}, resolution=${resolution}`)

  // enhanced capability checks
  const isSecureContext = window.isSecureContext
  if (!isSecureContext) {
    showError('⚠️ Insecure context (HTTP): getUserMedia is blocked by browser security policy. Use HTTPS or access via localhost/127.0.0.1.')
    setStatus('Insecure context')
    startBtn.disabled = false
    return
  }

  if (!testCamera && !navigator.mediaDevices?.getUserMedia) {
    showError('❌ getUserMedia API not available in this browser. Try Chrome/Edge/Safari.')
    setStatus('API unavailable')
    startBtn.disabled = false
    return
  }

  try {
    // If we're already in a room and have an active PeerConnection, perform a seamless camera switch
    const params = new URLSearchParams(location.search)
    const isInRoom = params.has('room') && ws && pc && pc.connectionState !== 'closed'
    console.log(`🔍 [SENDER] isInRoom=${isInRoom}, hasLocalStream=${!!localStream}, wsState=${ws?.readyState}, pcState=${pc?.connectionState}`)

    if (localStream && isInRoom) {
      console.log(`🔄 [SENDER] Seamless camera switch mode: deviceId=${deviceId || 'default'}`)
      
      const videoSender = pc.getSenders().find(s => s.track && s.track.kind === 'video')
      if (videoSender && typeof videoSender.replaceTrack === 'function') {
        // Remember current camera so we can revert if the new one fails
        const previousDeviceId = localStream.getVideoTracks()[0]?.getSettings()?.deviceId
        
        // CRITICAL FIX: Stop old tracks FIRST before acquiring new camera (mobile can't have 2 cameras active)
        const oldVideoTracks = localStream.getVideoTracks()
        console.log(`🛑 [SENDER] Stopping ${oldVideoTracks.length} old video track(s) BEFORE acquiring new camera...`)
        oldVideoTracks.forEach(t => {
          console.log(`  Stopping trackId=${t.id}, label=${t.label}, readyState=${t.readyState}`)
          t.stop()
        })
        localStream = null
        video.srcObject = null
        
        // Allow hardware to fully release (critical for mobile camera switching)
        // 1000ms gives iOS extra time to close the camera session before re-opening it
        console.log(`⏳ [SENDER] Waiting 1000ms for camera hardware release before acquiring new camera...`)
        await new Promise(res => setTimeout(res, 1000))
        
        // Now acquire new stream with retries
        const requestedFps = frameRateSelect ? parseInt(frameRateSelect.value, 10) : 30
        let newStream
        try {
          newStream = await attemptGetCameraStream(deviceId, resolution, requestedFps)
        } catch (switchErr) {
          console.error(`❌ [SENDER] New camera failed, reverting to previous: ${previousDeviceId}`)
          // Only permanently blacklist cameras that genuinely don't exist (NotFoundError).
          // NotReadableError / TrackStartError are transient hardware-busy errors — do NOT blacklist;
          // the camera may work again after a brief delay or on next selection.
          const isPermanentFailure = switchErr.name === 'NotFoundError'
          if (isPermanentFailure && deviceId) {
            failedDeviceIds.add(deviceId)
            console.log(`🚫 [SENDER] Marked device ${deviceId} as permanently unavailable (${switchErr.name})`)
          } else {
            console.log(`⚠️ [SENDER] Transient failure (${switchErr.name}) — NOT marking device as permanently unavailable`)
          }
          // Send diagnostic only on actual errors not temporary hardware-busy states
          if (ws && ws.readyState === WebSocket.OPEN && isPermanentFailure) {
            sendSignal(ws, { type: 'diagnostic', level: 'error', code: switchErr.name || 'Error', message: `Camera unavailable: ${switchErr.message}`, deviceId })
          }
          // Auto-revert to previous working camera
          if (previousDeviceId && previousDeviceId !== deviceId) {
            console.log(`🔄 [SENDER] Reverting to previous camera: ${previousDeviceId}`)
            // Extra delay before reverting — give OS time to release the failed camera
            await new Promise(res => setTimeout(res, 500))
            showError(`⚠️ Camera could not start. Reverting to previous camera. Try selecting it again.`)
            try {
              newStream = await attemptGetCameraStream(previousDeviceId, resolution, requestedFps)
            } catch (revertErr) {
              console.error(`❌ [SENDER] Revert also failed:`, revertErr)
              showError(`❌ Camera switch failed and could not revert. Tap "Start Camera".`)
              setStatus('Camera error')
              startBtn.disabled = false
              return
            }
          } else {
            showError(`⚠️ This camera is not available right now. Try again in a moment.`)
            setStatus('Camera unavailable')
            startBtn.disabled = false
            await populateCameras()
            return
          }
        }
        
        const newVideoTrack = newStream.getVideoTracks()[0]
        console.log(`✅ [SENDER] New stream acquired: trackId=${newVideoTrack.id}, readyState=${newVideoTrack.readyState}`)
        
        // Track this as last working camera
        const newSettings = newVideoTrack.getSettings()
        if (newSettings?.deviceId) lastWorkingDeviceId = newSettings.deviceId

        console.log(`🔁 [SENDER] Replacing video track on existing RTCRtpSender`)
        await videoSender.replaceTrack(newVideoTrack)
        console.log(`✅ [SENDER] Track replacement successful`)

        video.srcObject = newStream
        localStream = newStream
        stopBtn.disabled = false
        setStatus('Preview')
        await populateCameras()
        startBtn.disabled = false
        console.log(`✅ [SENDER] Seamless camera switch complete`)
        
        // send success diagnostic
        if (ws && ws.readyState === WebSocket.OPEN) {
          sendSignal(ws, { type: 'diagnostic', level: 'info', message: 'camera-switched', deviceId: newSettings?.deviceId || deviceId })
        }
        // Sprint 9: re-send capabilities — different camera may have different controls
        setTimeout(() => sendCameraCapabilities(), 300)
        // Sprint 10.1: attach pause listeners to new track
        attachTrackPauseListeners(newVideoTrack)
        _cameraPaused = false
        return
      }

      // fallback: if replaceTrack isn't available, fall through to full restart
      console.warn(`⚠️ [SENDER] replaceTrack not available — falling back to full camera restart`)
    }

    // stop any existing stream before acquiring a new one
    if (localStream) {
      console.log(`🛑 [SENDER] Stopping existing stream before acquiring new camera...`)
      const tracks = localStream.getTracks()
      console.log(`🛑 [SENDER] Stopping ${tracks.length} track(s)...`)
      tracks.forEach(t => {
        console.log(`  Stopping trackId=${t.id}, label=${t.label}, readyState=${t.readyState}`)
        t.stop()
        // ensure track is fully released
        if (t.readyState !== 'ended') {
          console.warn(`⚠️ [SENDER] Track not immediately ended after stop(): trackId=${t.id}, readyState=${t.readyState}`)
        }
      })
      localStream = null
      video.srcObject = null

      // allow the browser sufficient time to fully release the camera hardware (mobile devices need this)
      // 1000ms gives iOS extra time to close the camera session before re-opening it
      console.log(`⏳ [SENDER] Waiting 1000ms for camera hardware release...`)
      await new Promise(res => setTimeout(res, 1000))
      console.log(`✅ [SENDER] Hardware release delay complete`)
    }

    const requestedFps = frameRateSelect ? parseInt(frameRateSelect.value, 10) : 30
    const withAudio = micToggle ? micToggle.checked : false

    // try with retries for transient camera-hardware locking errors
    console.log(`🔄 [SENDER] Attempting to get camera stream with retries...`)
    localStream = await attemptGetCameraStream(deviceId, resolution, requestedFps, 4, withAudio)
    video.srcObject = localStream
    console.log(`✅ [SENDER] Camera stream acquired successfully, ${localStream.getVideoTracks().length} video track(s)`)

    // Track this as last working camera
    const startedTrack = localStream.getVideoTracks()[0]
    if (startedTrack) {
      const startedSettings = startedTrack.getSettings()
      if (startedSettings?.deviceId) lastWorkingDeviceId = startedSettings.deviceId
    }

    // if we successfully started, clear any previous sender diagnostic on remote receiver
    if (ws && ws.readyState === WebSocket.OPEN) {
      console.log(`📤 [SENDER] Sending success diagnostic to receiver: camera-started`)
      sendSignal(ws, { type: 'diagnostic', level: 'info', message: 'camera-started', deviceId })
    }
    // Sprint 9: send camera capabilities on fresh start
    setTimeout(() => sendCameraCapabilities(), 500)

    // Sprint 10.1: attach pause/resume/ended listeners to the new video track
    attachTrackPauseListeners(localStream.getVideoTracks()[0])
    _cameraPaused = false  // fresh stream means camera is active

    // Audio track setup — disable all browser processing for clean raw audio
    const audioTracks = localStream.getAudioTracks()
    if (audioTracks && audioTracks.length) {
      for (const at of audioTracks) {
        if (typeof at.applyConstraints === 'function') {
          at.applyConstraints({
            echoCancellation: false,
            noiseSuppression: false,
            autoGainControl: false,
            sampleRate: 48000
          }).catch(e => console.warn('applyConstraints(audio) failed', e))
        }
      }
      console.log('🎙️ [SENDER] audio track active — browser processing disabled')
      // Sync mute state to the toggle
      audioTracks.forEach(t => { t.enabled = micToggle ? micToggle.checked : true })
    }

    stopBtn.disabled = false
    setStatus('Preview')

    // If we're already connected (pc exists) but replaceTrack isn't available,
    // attach the new track and trigger a renegotiation so receivers keep receiving.
    if (pc && ws) {
      const newVideoTrack = localStream.getVideoTracks()[0]
      const videoSender = pc.getSenders().find(s => s.track && s.track.kind === 'video')
      try {
        if (videoSender) {
          if (typeof videoSender.replaceTrack === 'function') {
            await videoSender.replaceTrack(newVideoTrack)
          } else {
            // remove/add + renegotiate
            pc.removeTrack(videoSender)
            pc.addTrack(newVideoTrack, localStream)
            const offer = await pc.createOffer()
            await pc.setLocalDescription(offer)
            sendSignal(ws, pc.localDescription)
          }
        } else {
          pc.addTrack(newVideoTrack, localStream)
          const offer = await pc.createOffer()
          await pc.setLocalDescription(offer)
          sendSignal(ws, pc.localDescription)
        }
      } catch (e) { console.warn('camera-switch renegotiation failed', e) }
    }

    // refresh camera labels now that permission is granted
    await populateCameras()

    // connect signaling if ?room= present and start negotiation (only if not already connected)
    if (params.has('room') && !ws) {
      roomId = params.get('room')
      const activeWs = connectSignaling(msg => {
        if (ws === activeWs) handleSignalingMessage(msg)
      })
      ws = activeWs
      activeWs.addEventListener('open', () => {
        if (ws !== activeWs) return
        joinRoom(activeWs, roomId)
        setStatus('Joining room…')
      })
      activeWs.addEventListener('close', () => {
        if (ws !== activeWs) return
        console.log(`📡 [SENDER] WebSocket closed, intentionalDisconnect=${intentionalDisconnect}`)
        if (!intentionalDisconnect && localStream) scheduleReconnect()
      })
    }

    // Wake lock handling
    if (wakeLockToggle.checked) await requestWakeLock()
  } catch (err) {
    console.error(`❌ [SENDER] startCamera failed:`, err)

    // send diagnostic to remote receiver so you can see the failure there
    if (ws && ws.readyState === WebSocket.OPEN) {
      console.log(`📤 [SENDER] Sending error diagnostic to receiver: ${err.name} - ${err.message}`)
      try { sendSignal(ws, { type: 'diagnostic', level: 'error', code: err.name || 'Error', message: err.message || String(err), deviceId }) } catch(e){ console.warn('Failed to send diagnostic:', e) }
    }

    // more specific error messages
    if (err.name === 'NotAllowedError' || err.name === 'PermissionDeniedError') {
      showError('🚫 Camera permission denied. Tap "Start Camera" again and allow access.')
      setStatus('Permission denied')
    } else if (err.name === 'NotFoundError' || err.name === 'OverconstrainedError') {
      showError('📷 No camera found matching constraints. Try a different resolution.')
      setStatus('No camera')
    } else if (err.name === 'NotReadableError' || /could not start video source/i.test(err.message || '')) {
      showError('⚠️ Camera busy or could not start. Try "Rescan Devices" or wait a moment and try again.')
      setStatus('Camera busy')
    } else if (err.name === 'SecurityError') {
      showError('🔒 Security error — camera blocked. Check browser permissions.')
      setStatus('SecurityError')
    } else {
      showError(`❌ Camera error: ${err.message || 'unknown'}`)
      setStatus('Error')
    }
    startBtn.disabled = false
  }
}

function stopCamera() {
  console.log(`🛑 [SENDER] stopCamera called`)
  intentionalDisconnect = true
  _cameraPaused = false
  _iceRestartPending = false
  cancelReconnect()
  if (localStream) {
    const tracks = localStream.getTracks()
    console.log(`🛑 [SENDER] Stopping ${tracks.length} track(s)...`)
    tracks.forEach(t => {
      console.log(`  Stopping trackId=${t.id}, label=${t.label}, readyState=${t.readyState}`)
      t.stop()
      // verify track cleanup
      if (t.readyState !== 'ended') {
        console.warn(`⚠️ [SENDER] Track not immediately ended after stop(): trackId=${t.id}, readyState=${t.readyState}`)
      }
    })
    localStream = null
    video.srcObject = null
  }
  
  resetPeerConnection()
  
  if (ws) {
    leaveRoom(ws)
    ws.close()
    ws = null
  }
  releaseWakeLock()
  setStatus('Idle')
  stopBtn.disabled = true
  startBtn.disabled = false
  console.log(`✅ [SENDER] stopCamera complete`)
}

async function requestWakeLock() {
  if ('wakeLock' in navigator) {
    try {
      wakeLock = await navigator.wakeLock.request('screen')
      wakeLock.addEventListener('release', () => console.log('wakeLock released'))
      console.log('Wake lock active')
    } catch (err) {
      console.warn('Wake lock failed', err)
    }
  }
}

function releaseWakeLock() {
  if (wakeLock) {
    wakeLock.release().catch(()=>{})
    wakeLock = null
  }
}

// WebRTC (Sprint 3) — sender-side negotiation + ICE handling
let pc = null
let pendingIceCandidates = []
const STUN_SERVERS = [
  { urls: 'stun:stun.l.google.com:19302' },
  { urls: 'stun:stun1.l.google.com:19302' },
  { urls: 'stun:stun.cloudflare.com:3478' }
]
let turnServers = []

let disconnectGraceTimer = null

function resetPeerConnection() {
  if (disconnectGraceTimer) clearTimeout(disconnectGraceTimer)
  disconnectGraceTimer = null
  const oldPc = pc
  pc = null
  oldPc?.close()
  pendingIceCandidates = []
  stopSenderStats()
}

function createPeerConnection() {
  const conn = new RTCPeerConnection({ iceServers: testCamera ? [] : [...STUN_SERVERS, ...turnServers] })

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
      if (disconnectGraceTimer) { clearTimeout(disconnectGraceTimer); disconnectGraceTimer = null }
      cancelReconnect()
      clearError()
      sendCameraCapabilities()
      return
    }

    if (conn.connectionState === 'disconnected' && !intentionalDisconnect && localStream) {
      // Wait 4s for transient Wi-Fi hiccups to self-recover before triggering reconnect
      if (!disconnectGraceTimer) {
        disconnectGraceTimer = setTimeout(() => {
          disconnectGraceTimer = null
          if (conn === pc && conn.connectionState === 'disconnected' && !intentionalDisconnect && localStream) {
            console.log('🔄 [SENDER] Still disconnected after 4s — scheduling reconnect')
            scheduleReconnect()
          }
        }, 4000)
      }
      return
    }

    if (conn.connectionState === 'failed' && !intentionalDisconnect && localStream) {
      if (disconnectGraceTimer) { clearTimeout(disconnectGraceTimer); disconnectGraceTimer = null }
      console.log('🔄 [SENDER] Peer connection failed — scheduling reconnect')
      scheduleReconnect()
    }
  })

  conn.addEventListener('iceconnectionstatechange', () => {
    console.log('🧊 ICE state:', conn.iceConnectionState)
  })

  // add local tracks
  if (localStream) {
    for (const track of localStream.getTracks()) {
      console.log('📹 adding local track:', track.kind)
      conn.addTrack(track, localStream)
    }

    // best-effort: request higher maxBitrate for LAN connections (Sprint 4.4)
    try {
      const videoSender = conn.getSenders().find(s => s.track && s.track.kind === 'video')
      if (videoSender && typeof videoSender.getParameters === 'function' && typeof videoSender.setParameters === 'function') {
        const params = videoSender.getParameters()
        if (!params.encodings || !params.encodings.length) params.encodings = [{}]
        // LAN has plenty of bandwidth — use aggressive bitrates for
        // near-lossless quality and set priority to minimize encode delay.
        let target = 12000000
        const res = (typeof resolutionSelect !== 'undefined') ? resolutionSelect.value : '1080'
        if (res === '720') target = 8000000
        else if (res === '1080') target = 16000000
        else target = 40000000  // 4K — LAN can handle 40 Mbps
        params.encodings.forEach(e => {
          e.maxBitrate = target
          e.priority = 'high'
          e.networkPriority = 'high'
          // Support up to 60fps — encoder will use whatever the source provides
          e.maxFramerate = 60
          // CRITICAL: prevent the encoder from downscaling resolution.
          // Without this, WebRTC freely drops to 270x480 etc.
          e.scaleResolutionDownBy = 1.0
        })
        // degradationPreference: maintain framerate over resolution.
        // The desktop receiver rescales to its output buffer anyway, so
        // lower source resolution is fine — but dropping below 30fps
        // makes the virtual camera visibly laggy.
        params.degradationPreference = 'maintain-framerate'
        videoSender.setParameters(params).catch(err => console.warn('setParameters not supported', err))
        console.log(`🔧 requested maxBitrate=${target}bps, degradation=maintain-framerate`)
      }

      // Codec preference: prefer VP8 + Constrained Baseline H.264 (42e01f) while
      // keeping all codecs and RTX intact. Forcing an arbitrary H.264 High/Main
      // profile ahead of VP8 can cause black video on Windows WebView2 decoders.
      try {
        if (typeof RTCRtpSender !== 'undefined' && typeof RTCRtpSender.getCapabilities === 'function') {
          const caps = RTCRtpSender.getCapabilities('video') || { codecs: [] }
          const vp8 = caps.codecs.filter(c => /video\/vp8/i.test(c.mimeType))
          const h264Baseline = caps.codecs.filter(
            c => /video\/h264/i.test(c.mimeType) && /profile-level-id=42e0/i.test(c.sdpFmtpLine || '')
          )
          const rest = caps.codecs.filter(c => !vp8.includes(c) && !h264Baseline.includes(c))
          const ordered = [...vp8, ...h264Baseline, ...rest]

          const transceiver = conn.getTransceivers().find(t => t.sender && t.sender.track && t.sender.track.kind === 'video')
          if (transceiver && typeof transceiver.setCodecPreferences === 'function' && ordered.length > 0) {
            transceiver.setCodecPreferences(ordered)
            console.log('⚙️ codec preference set: VP8 → H.264 Baseline → fallback')
          }
        }
      } catch (e) { console.warn('codec preference not available', e) }

    } catch (e) { console.warn('Failed to configure sender bitrate', e) }
  }

  // apply any queued remote ICE candidates after remote description set
  conn._drainPending = async () => {
    console.log(`🚰 draining ${pendingIceCandidates.length} pending ICE candidates`)
    while (pendingIceCandidates.length) {
      const c = pendingIceCandidates.shift()
      try { await conn.addIceCandidate(c) } catch (e) { console.warn('addIceCandidate failed', e) }
    }
  }

  return conn
}

async function startNegotiation() {
  if (!ws || !localStream) {
    console.warn('⚠️ cannot start negotiation: ws or localStream missing')
    return
  }
  if (pc && pc.signalingState !== 'closed') {
    console.log('ℹ️ negotiation already in progress or complete')
    return
  }

  console.log('🚀 starting negotiation as sender')
  const activeWs = ws
  const conn = createPeerConnection()
  pc = conn

  try {
    const offer = await conn.createOffer({ offerToReceiveVideo: false, offerToReceiveAudio: false })
    await conn.setLocalDescription(offer)
    if (pc !== conn || ws !== activeWs) return
    console.log('📤 sending offer')
    // send the RTCSessionDescriptionInit directly (type + sdp string)
    sendSignal(activeWs, conn.localDescription)
    setStatus('Offer sent — waiting for answer')

    // start sender stats monitor to detect encoder overloads and auto-fallback
    startSenderStats()
  } catch (err) {
    if (pc !== conn || ws !== activeWs) return
    console.error('❌ failed to create/send offer', err)
    showError('Failed to start WebRTC negotiation')
  }
}

async function handleSignalPayload(payload) {
  if (!payload) return

  // latency ping/pong for RTT overlay (Sprint 4.5)
  if (payload.type === 'latency-ping') {
    if (ws) sendSignal(ws, { type: 'latency-pong', t: payload.t || Date.now() })
    return
  }
  if (payload.type === 'latency-pong') {
    // ignore on sender
    return
  }

  // ── Sprint 9: Camera control signals from desktop ─────────────────
  // Desktop requests current camera capabilities (zoom, torch, focus, etc.)
  if (payload.type === 'camera-capabilities-request') {
    console.log('📥 [SENDER] Desktop requested camera capabilities')
    sendCameraCapabilities()
    return
  }

  // Desktop sends a camera control command (e.g. set zoom, toggle torch)
  if (payload.type === 'camera-control') {
    const result = await applyCameraControl(payload.control)
    // Send result back so desktop can update its UI with the actual value
    if (ws && ws.readyState === WebSocket.OPEN) {
      sendSignal(ws, { type: 'camera-control-result', result })
    }
    // Also re-send full capabilities since applying one control can affect others
    // (e.g. switching to manual focus enables focusDistance)
    setTimeout(() => sendCameraCapabilities(), 200)
    return
  }

  // quality feedback from receiver (receiver-driven adaptive tuning)
  if (payload.type === 'quality-feedback') {
    try {
      const loss = payload.loss || 0
      const dropped = payload.dropped || 0
      const fps = payload.fps || 0
      console.log('📣 quality-feedback from receiver:', { fps, dropped, loss })

      // if receiver reports >5% loss or >5 dropped frames in last interval, be conservative
      if (!disableAutoFallback || !disableAutoFallback.checked) {
        if (loss > 0.05 || dropped >= 5) {
          // reduce bitrate gently — floor in probeAdjust prevents resolution collapse
          probeAdjustMaxBitrate(0.9)
          if (frameRateSelect && parseInt(frameRateSelect.value, 10) > 30) {
            console.log('⚙️ receiver requested lower quality — dropping FPS to 30')
            frameRateSelect.value = '30'
            const track = localStream && localStream.getVideoTracks()[0]
            if (track && typeof track.applyConstraints === 'function') track.applyConstraints({ frameRate: { ideal: 30 } }).catch(()=>{})
          }
        } else if (loss < 0.02 && fps >= (parseInt(frameRateSelect.value,10) || 30)) {
          // signal is healthy — attempt gentle bitrate bump
          probeAdjustMaxBitrate(1.1)
        }
      }
    } catch (e) { console.warn('handle quality-feedback failed', e) }
    return
  }

  if (!pc && payload.type === 'answer') {
    console.warn('⚠️ received answer but no pc exists')
    return
  }

  if (payload.type === 'answer') {
    const conn = pc
    try {
      console.log('📥 setting remote description (answer)')
      await conn.setRemoteDescription(payload)
      if (conn !== pc) return
      await conn._drainPending()
      if (conn === pc && conn.connectionState === 'connected' && !_cameraPaused) {
        setStatus('Connection: connected')
      }
    } catch (e) { console.error('❌ setRemoteDescription(answer) failed', e) }
    return
  }

  if (payload.type === 'offer') {
    // unlikely on sender, but support for role-reversal
    console.log('📥 received offer (sender role-reversal)')
    if (!pc) pc = createPeerConnection()
    try {
      await pc.setRemoteDescription(payload)
      const answer = await pc.createAnswer()
      await pc.setLocalDescription(answer)
      console.log('📤 sending answer')
      // send RTCSessionDescriptionInit directly
      sendSignal(ws, pc.localDescription)
    } catch (e) { console.error('❌ handle incoming offer failed', e) }
    return
  }

  if (payload.type === 'ice') {
    const candidate = payload.candidate
    if (!pc || !pc.remoteDescription) {
      console.log('⏳ queueing ICE candidate (no remote description yet)')
      pendingIceCandidates.push(candidate)
    } else {
      console.log('📥 adding ICE candidate:', candidate.type)
      try { await pc.addIceCandidate(candidate) } catch (e) { console.warn('addIceCandidate failed', e) }
    }
    return
  }
}

function handleSignalingMessage(msg) {
  console.log('signal action:', msg.action)

  if (msg.action === 'joined' || msg.action === 'peer-joined') {
    turnServers = Array.isArray(msg.iceServers) ? msg.iceServers : []
  }

  if (msg.action === 'error') {
    const m = msg.message || 'Signaling error'
    console.warn('⚠️ [SENDER] server error:', m)
    if (m === 'too-many-connections') {
      scheduleReconnect(Number(msg.retryAfter) * 1000 || 30_000)
    } else if (m === 'room-not-found') {
      intentionalDisconnect = true
      cancelReconnect()
      showError('Room expired or not found. Scan the latest QR code on your PC.')
      setStatus('Room expired')
    } else if (m === 'room-full') {
      intentionalDisconnect = true
      cancelReconnect()
      showError('Room already has a connected device. Create a new room on your PC.')
      setStatus('Room full')
    } else {
      showError(`Signaling error: ${m}`)
    }
    return
  }

  if (msg.action === 'joined') {
    if (msg.peerCount === 1) {
      setStatus('Waiting for receiver…')
    } else {
      setStatus('Joined room — connecting video…')
      startNegotiation()
    }
  }

  if (msg.action === 'peer-joined') {
    setStatus('PC detected — starting video…')
    startNegotiation()
  }

  if (msg.action === 'peer-left') {
    if (reconnectTimer) clearTimeout(reconnectTimer)
    reconnectTimer = null
    resetPeerConnection()
    setStatus('Waiting for receiver…')
  }

  if (msg.action === 'signal') {
    handleSignalPayload(msg.payload)
  }
}

// SENDER STATS MONITOR — detect encoder overload and auto-fallback to lower FPS
let senderStatsInterval = null
let lastSenderStats = null
let senderOverloadCounter = 0

function startSenderStats() {
  if (!pc || senderStatsInterval) return
  lastSenderStats = null
  senderOverloadCounter = 0
  senderStatsInterval = setInterval(async () => {
    try {
      const stats = await pc.getStats()
      let outbound = null
      stats.forEach(s => {
        if (!outbound && s.type === 'outbound-rtp' && (s.kind === 'video' || s.mediaType === 'video' || s.trackId)) {
          outbound = s
        }
        // some browsers expose frames on 'track' entries
        if (!outbound && s.type === 'track' && s.kind === 'video') {
          outbound = s
        }
      })

      if (!outbound) return

      const frames = outbound.framesEncoded || outbound.framesSent || outbound.framesDecoded || 0
      const bytes = outbound.bytesSent || outbound.bytes || 0
      const packetsSent = outbound.packetsSent || 0
      const packetsLost = outbound.packetsLost || 0
      const ts = outbound.timestamp || Date.now()

      if (lastSenderStats && lastSenderStats.frames != null) {
        const dt = (ts - lastSenderStats.ts) / 1000
        const measuredFps = dt > 0 ? (frames - lastSenderStats.frames) / dt : 0
        const bitrate = dt > 0 ? Math.round((bytes - (lastSenderStats.bytes||0)) * 8 / dt) : 0
        const packetLossRatio = (packetsSent - (lastSenderStats.packetsSent||0)) > 0
          ? ((packetsLost - (lastSenderStats.packetsLost||0)) / (packetsSent - (lastSenderStats.packetsSent||0))) : 0

        const requestedFps = frameRateSelect ? parseInt(frameRateSelect.value, 10) : 30

        const source = stats.get(outbound.mediaSourceId)
        console.log(`sender-stats capture=${source?.framesPerSecond ?? '?'}fps encoded=${Math.round(measuredFps)}fps bitrate=${bitrate}bps loss=${(packetLossRatio*100).toFixed(2)}% enc=${outbound.frameWidth||'?'}x${outbound.frameHeight||'?'} limited=${outbound.qualityLimitationReason ?? '?'}`)

        // respect manual override checkbox
        if (disableAutoFallback && disableAutoFallback.checked) {
          senderOverloadCounter = 0
        } else {
          // fallback logic: be less aggressive — require sustained underperformance + packet issues
          const fpsUnderperform = requestedFps >= 50 && measuredFps < Math.max(30, Math.floor(requestedFps * 0.65))
          const lossBad = packetLossRatio > 0.05 || bitrate < (requestedFps === 60 ? 2500000 : 1000000)

          if (fpsUnderperform && lossBad) {
            senderOverloadCounter++
            console.warn('Encoder underperf detected:', Math.round(measuredFps), 'fps loss%', (packetLossRatio*100).toFixed(2), 'counter=', senderOverloadCounter)
            if (senderOverloadCounter >= 4) {
              // auto-fallback to 30fps
              console.log('⚙️ Auto-lowering frameRate to 30 due to sustained encoder/network issues')
              frameRateSelect.value = '30'
              const track = localStream && localStream.getVideoTracks()[0]
              if (track && typeof track.applyConstraints === 'function') {
                track.applyConstraints({ frameRate: { ideal: 30 } }).catch(()=>{})
              }
              // reduce maxBitrate gently — floor prevents resolution collapse
              try { probeAdjustMaxBitrate(0.85) } catch(e){/*ignore*/}
              senderOverloadCounter = 0
            }
          } else {
            // successful encoding; consider gentle probing to raise bitrate if underutilized
            senderOverloadCounter = 0
            if (measuredFps >= requestedFps * 0.9 && packetLossRatio < 0.02 && bitrate < (requestedFps === 60 ? 8000000 : 4000000)) {
              // attempt small bitrate increase probe
              console.log('⚙️ probing bitrate increase after stable period')
              try { probeAdjustMaxBitrate(1.15) } catch(e){/*ignore*/}
            }
          }
        }
      }

      lastSenderStats = { frames, bytes, packetsSent, packetsLost, ts }
    } catch (e) { console.warn('sender stats failed', e) }
  }, 2000)
}

function stopSenderStats() { if (senderStatsInterval) { clearInterval(senderStatsInterval); senderStatsInterval = null } }

// ── Auto-reconnect (Sprint 10.2) ─────────────────────────────────────

function getReconnectDelay() {
  // Exponential backoff: 1s, 2s, 4s, 8s, 16s, capped at 30s
  return Math.min(RECONNECT_BASE_DELAY * Math.pow(2, reconnectAttempts), 30000)
}

function scheduleReconnect(minimumDelay = 0) {
  if (reconnectTimer) return
  if (intentionalDisconnect || reconnectAttempts >= MAX_RECONNECT_ATTEMPTS) {
    if (reconnectAttempts >= MAX_RECONNECT_ATTEMPTS) {
      showError(`Connection lost after ${MAX_RECONNECT_ATTEMPTS} reconnect attempts. Tap "Start Camera" to try again.`)
      setStatus('Disconnected')
    }
    return
  }

  const delay = Math.max(minimumDelay, getReconnectDelay())
  reconnectAttempts++
  console.log(`🔄 [SENDER] Scheduling reconnect attempt ${reconnectAttempts}/${MAX_RECONNECT_ATTEMPTS} in ${delay}ms`)
  setStatus(minimumDelay ? `Server busy — retrying in ${Math.ceil(delay / 1000)} seconds` :
    `Reconnecting (${reconnectAttempts}/${MAX_RECONNECT_ATTEMPTS})…`)

  reconnectTimer = setTimeout(async () => {
    reconnectTimer = null
    if (intentionalDisconnect) return

    try {
      // Close stale connections
      resetPeerConnection()
      if (ws) { try { ws.close() } catch(e){} ws = null }

      // Reconnect signaling and restart negotiation
      const params = new URLSearchParams(location.search)
      const rid = roomId || params.get('room')
      if (!rid) { showError('No room to reconnect to'); return }

      const newWs = connectSignaling(msg => {
        if (ws === newWs) handleSignalingMessage(msg)
      })
      ws = newWs
      newWs.addEventListener('open', () => {
        if (ws !== newWs) return
        console.log('🔄 [SENDER] Reconnected to signaling server')
        joinRoom(newWs, rid)
        setStatus('Reconnected — joining room…')
        // Negotiation starts automatically when server replies with 'joined'
      })
      newWs.addEventListener('close', () => {
        if (ws !== newWs) return
        if (!intentionalDisconnect) scheduleReconnect()
      })
      newWs.addEventListener('error', () => {
        // will trigger close, which triggers reconnect
      })
    } catch (err) {
      console.error('🔄 [SENDER] Reconnect failed:', err)
      scheduleReconnect()
    }
  }, delay)
}

function cancelReconnect() {
  if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null }
  reconnectAttempts = 0
}

// helper: scale current sender parameters (factor >1 increase, <1 decrease)
async function probeAdjustMaxBitrate(factor) {
  if (!pc) return
  const sender = pc.getSenders().find(s => s.track && s.track.kind === 'video')
  if (!sender || typeof sender.getParameters !== 'function' || typeof sender.setParameters !== 'function') return
  try {
    const params = sender.getParameters()
    if (!params.encodings || !params.encodings.length) params.encodings = [{}]
    params.encodings.forEach(e => {
      if (!e.maxBitrate) e.maxBitrate = 8000000
      // Floor at 4Mbps — below this the encoder aggressively drops resolution
      e.maxBitrate = Math.max(4000000, Math.round(e.maxBitrate * factor))
    })
    await sender.setParameters(params)
    console.log('🔧 probeAdjustMaxBitrate applied, factor=', factor, params.encodings.map(e=>e.maxBitrate))
  } catch (e) { console.warn('probeAdjustMaxBitrate failed', e) }
}

// ── Sprint 10.1: iOS app-switching / camera pause detection ─────────────────────────────
// On iOS, switching apps or locking the screen fires:
//   1. visibilitychange (document.hidden = true)
//   2. pagehide
//   3. The camera track fires 'mute' (camera hardware released by OS)
//   4. On resume: visibilitychange (document.hidden = false) + track 'unmute'
// We detect all of these and notify the desktop via camera-paused / camera-resumed signals.
let _cameraPaused = false

function notifyCameraPaused() {
  if (_cameraPaused) return
  _cameraPaused = true
  console.log('⏸️ [SENDER] Camera paused (app switched / screen locked)')
  setStatus('Paused')
  if (ws && ws.readyState === WebSocket.OPEN) {
    sendSignal(ws, { type: 'camera-paused' })
  }
}

function notifyCameraResumed() {
  if (!_cameraPaused) return
  const track = localStream?.getVideoTracks()[0]
  if (!track || track.muted || track.readyState !== 'live') return
  _cameraPaused = false
  console.log('▶️ [SENDER] Camera resumed')
  setStatus('Resumed')
  if (ws && ws.readyState === WebSocket.OPEN) {
    sendSignal(ws, { type: 'camera-resumed' })
  }
  // Re-acquire wake lock if it was active before suspension
  if (wakeLockToggle && wakeLockToggle.checked) {
    requestWakeLock().catch(() => {})
  }
}

// Attach mute/unmute/ended listeners to the active video track
function attachTrackPauseListeners(track) {
  if (!track) return
  track.addEventListener('mute', () => {
    // OS took the camera (app switched, screen locked, incoming call)
    notifyCameraPaused()
  })
  track.addEventListener('unmute', () => {
    notifyCameraResumed()
  })
  track.addEventListener('ended', () => {
    if (localStream?.getVideoTracks()[0] !== track) return
    notifyCameraPaused()
    showError('The camera stopped. Tap Start Camera to resume video.')
    startBtn.disabled = false
  })
}

// Page visibility — catches iOS background + Android background
document.addEventListener('visibilitychange', () => {
  if (document.hidden) {
    if (localStream?.getVideoTracks()[0]?.muted) notifyCameraPaused()
  } else {
    if (_cameraPaused) notifyCameraResumed()
  }
})

// pagehide — extra safety for iOS Safari (fires slightly after visibilitychange)
window.addEventListener('pagehide', () => {
  if (localStream) notifyCameraPaused()
})

// ── Sprint 10.3: Network change detection — ICE restart ─────────────────────────────────
// When the phone switches from WiFi to cellular, the ICE candidates become invalid.
// pc.restartIce() / createOffer({ iceRestart: true }) triggers fresh candidate gathering
// so the call can recover without a full page reload.
let _lastNetworkType = null
let _iceRestartPending = false

function triggerIceRestart() {
  const conn = pc
  const activeWs = ws
  if (!conn || conn.signalingState !== 'stable' || activeWs?.readyState !== WebSocket.OPEN) return
  if (_iceRestartPending) return
  _iceRestartPending = true
  console.log('🔄 [SENDER] Network changed — triggering ICE restart')
  setStatus('Network changed — reconnecting…')
  conn.createOffer({ iceRestart: true })
    .then(offer => conn.setLocalDescription(offer))
    .then(() => {
      if (pc === conn && ws === activeWs) {
        sendSignal(activeWs, conn.localDescription)
        console.log('📤 [SENDER] ICE restart offer sent')
      }
    })
    .catch(err => {
      console.warn('⚠️ [SENDER] ICE restart failed, falling back to reconnect:', err)
      if (pc === conn && ws === activeWs) scheduleReconnect()
    })
    .finally(() => { _iceRestartPending = false })
}

// Only an interface change calls for fresh ICE, not a bandwidth estimate change.
if (navigator.connection?.type) {
  navigator.connection.addEventListener('change', () => {
    const newType = navigator.connection.type
    console.log(`📶 [SENDER] Network type changed: ${_lastNetworkType} → ${newType}`)
    if (_lastNetworkType !== null && _lastNetworkType !== newType) {
      triggerIceRestart()
    }
    _lastNetworkType = newType
  })
  _lastNetworkType = navigator.connection.type
}

// online / offline events — broader support across all browsers
window.addEventListener('online', () => {
  console.log('📶 [SENDER] Network came back online')
  if (_cameraPaused) notifyCameraResumed()
  if (pc && (pc.connectionState === 'disconnected' || pc.connectionState === 'failed')) {
    scheduleReconnect()
  } else {
    triggerIceRestart()
  }
})
window.addEventListener('offline', () => {
  console.log('📶 [SENDER] Network went offline')
  setStatus('No network')
  if (ws && ws.readyState === WebSocket.OPEN) {
    sendSignal(ws, { type: 'camera-paused', reason: 'network-offline' })
  }
})

// PWA install prompt handling
let deferredPrompt = null
window.addEventListener('beforeinstallprompt', (e) => {
  e.preventDefault()
  deferredPrompt = e
  installBtn.hidden = false
})
installBtn.addEventListener('click', async () => {
  if (!deferredPrompt) return
  deferredPrompt.prompt()
  const choice = await deferredPrompt.userChoice
  deferredPrompt = null
  installBtn.hidden = true
  console.log('PWA install choice', choice)
})

// UI bindings
startBtn.addEventListener('click', startCamera)
stopBtn.addEventListener('click', stopCamera)
const rescanBtn = document.getElementById('rescanBtn')
rescanBtn.addEventListener('click', async () => {
  // Clear transient failures so cameras can be retried after rescanning
  failedDeviceIds.clear()
  await populateCameras()
  setStatus('Devices rescanned')
})
cameraSelect.addEventListener('change', async () => {
  if (localStream) await startCamera()
})

async function applyVideoSettings() {
  const track = localStream?.getVideoTracks()[0]
  if (testCamera || track?.readyState !== 'live') return
  const { video: constraints } = buildConstraints(undefined, resolutionSelect.value, frameRateSelect.value)
  try {
    await track.applyConstraints(constraints)
    if (localStream?.getVideoTracks()[0] === track) clearError()
  } catch (error) {
    if (localStream?.getVideoTracks()[0] === track) {
      showError('The camera could not apply those video settings. The current stream is still active.')
    }
    console.warn('Camera settings could not be applied', error)
  }
}

resolutionSelect.addEventListener('change', applyVideoSettings)
frameRateSelect.addEventListener('change', applyVideoSettings)
wakeLockToggle.addEventListener('change', async (ev) => {
  if (ev.target.checked) await requestWakeLock(); else releaseWakeLock()
})

// Mic toggle — instant mute/unmute without restarting the stream
if (micToggle) {
  micToggle.addEventListener('change', async (ev) => {
    const enabled = ev.target.checked
    if (localStream) {
      localStream.getAudioTracks().forEach(t => { t.enabled = enabled })
      console.log(`🎙️ [SENDER] mic ${enabled ? 'unmuted' : 'muted'}`)
    }
    // Notify desktop so it can show a mic-mute badge
    if (ws && ws.readyState === WebSocket.OPEN) {
      sendSignal(ws, { type: 'mic-mute', muted: !enabled })
    }
  })
}

// Re-acquire wake lock on visibility resume
document.addEventListener('visibilitychange', async () => {
  if (document.visibilityState === 'visible' && wakeLockToggle.checked && localStream) {
    await requestWakeLock()
  }
})

// ── P.3: Stealth Mode ────────────────────────────────────────────────
// Hides the camera preview with a solid black overlay so the phone screen
// can dim/turn off while the WebRTC stream continues in the background.
// The wake lock is intentionally RELEASED in stealth mode so the OS may
// blank the screen — which actually saves battery.  The camera track stays
// alive because we only hide the <video> element, not the underlying stream.
let _stealthOverlay = null

function applyStealthMode(enabled) {
  if (enabled) {
    if (!_stealthOverlay) {
      _stealthOverlay = document.createElement('div')
      _stealthOverlay.id = 'stealthOverlay'
      // Full-screen black cover — GPU composited, zero CPU after paint
      Object.assign(_stealthOverlay.style, {
        position: 'fixed', inset: '0', background: '#000',
        zIndex: '9999', touchAction: 'none', userSelect: 'none'
      })
      const hint = document.createElement('p')
      hint.textContent = '🕵️ Stealth Mode — stream is still running'
      Object.assign(hint.style, {
        position: 'absolute', bottom: '1.5rem', left: '0', right: '0',
        textAlign: 'center', color: '#333', fontSize: '0.75rem',
        fontFamily: 'monospace', pointerEvents: 'none'
      })
      _stealthOverlay.appendChild(hint)
      document.body.appendChild(_stealthOverlay)
    }
    _stealthOverlay.hidden = false
    // Release wake lock so screen can naturally dim/turn off
    releaseWakeLock()
    console.log('🕵️ [SENDER] Stealth mode ON — screen blanked, stream alive')
  } else {
    if (_stealthOverlay) _stealthOverlay.hidden = true
    // Re-acquire wake lock if the user had it checked before
    if (wakeLockToggle && wakeLockToggle.checked && localStream) {
      requestWakeLock().catch(() => {})
    }
    console.log('🕵️ [SENDER] Stealth mode OFF')
  }
}

if (stealthToggle) {
  stealthToggle.addEventListener('change', (ev) => {
    applyStealthMode(ev.target.checked)
  })
}

// Initial setup
(async function init(){
  await populateCameras()
  if (testCamera) {
    micToggle.disabled = true
    document.title = 'BridgeCam — Test Camera'
    await startCamera()
  }

  // check secure context on load and show warning if insecure
  const params = new URLSearchParams(location.search)
  if (params.has('room') && !window.isSecureContext) {
    showError('⚠️ Insecure HTTP page: camera will be blocked. Use HTTPS or access via localhost.')
    setStatus('Insecure context')
  } else if (!testCamera) {
    setStatus('Ready')
  }

  // register service worker
  if ('serviceWorker' in navigator) {
    try { await navigator.serviceWorker.register('/sw.js') } catch(e){ console.warn('sw reg failed', e) }
  }
})();
