// BridgeCam Frame Worker v8 — high-performance pipeline for 4K@60fps
//
// Pipeline (two tiers, chosen automatically):
//   Tier A (fastest): VideoFrame.copyTo() → direct RGBA bytes → ws.send()
//     - Bypasses canvas entirely — no drawImage, no getImageData
//     - ~1-2ms at 1080p, ~3-5ms at 4K (GPU readback via VideoFrame API)
//     - Used when source fills the output (fullCoverage, matching dims)
//
//   Tier B (fallback): drawImage → OffscreenCanvas → getImageData → ws.send()
//     - Used when letterboxing/scaling needed or VideoFrame.copyTo unavailable
//     - ~8-15ms at 1080p, ~30-60ms at 4K
//
// v8 improvements over v7:
//   - VideoFrame.copyTo() fast path — bypasses canvas entirely when possible
//   - Pre-allocated output buffer — eliminates per-frame 3.7-31MB allocation
//   - Always signals completion so main thread unblocks even on errors
//   - Handles async copyTo without blocking the message loop for canvas path

let canvas = null
let ctx    = null
let lastW  = 0
let lastH  = 0

// Pre-allocated output buffer for copyTo path — reused across frames.
// Allocated once per resolution change.
let preallocBuf = null
let preallocSize = 0

// WebSocket to Rust frame socket (localhost only)
let ws = null
let wsPort = 0
let wsToken = ''
let wsConnecting = false
let wsReconnectTimer = null
let wsReconnectDelay = 250

// Back-pressure: drop frames when WS buffer exceeds ~1 frame + margin.
let MAX_BUFFERED = 4 * 1024 * 1024

// Track VideoFrame.copyTo support (tested once per session)
let _copyToTested = false
let _copyToWorks = false

function connectWs(port, token = '') {
  if (!port) return
  if (wsConnecting) return
  wsPort = port
  if (token) wsToken = token
  wsConnecting = true

  if (wsReconnectTimer) { clearTimeout(wsReconnectTimer); wsReconnectTimer = null }

  try {
    const qs = wsToken ? `?token=${encodeURIComponent(wsToken)}` : ''
    ws = new WebSocket(`ws://127.0.0.1:${port}${qs}`)
    ws.binaryType = 'arraybuffer'
    ws.onopen = () => {
      wsConnecting = false
      wsReconnectDelay = 250
      self.postMessage({ type: 'ws-status', connected: true })
    }
    ws.onmessage = () => {}
    ws.onclose = () => {
      ws = null
      wsConnecting = false
      self.postMessage({ type: 'ws-status', connected: false })
      scheduleReconnect()
    }
    ws.onerror = () => {
      ws = null
      wsConnecting = false
    }
  } catch (e) {
    ws = null
    wsConnecting = false
    scheduleReconnect()
  }
}

function scheduleReconnect() {
  if (!wsPort || wsReconnectTimer) return
  wsReconnectTimer = setTimeout(() => {
    wsReconnectTimer = null
    wsReconnectDelay = Math.min(wsReconnectDelay * 2, 5000)
    connectWs(wsPort)
  }, wsReconnectDelay)
}

// Ensure pre-allocated buffer exists at the right size
function ensureBuffer(byteSize) {
  if (preallocSize !== byteSize) {
    preallocBuf = new ArrayBuffer(byteSize)
    preallocSize = byteSize
  }
}

// Send raw RGBA buffer over WebSocket or fall back to IPC
function sendBuffer(buf) {
  if (ws && ws.readyState === 1) {
    if (ws.bufferedAmount < MAX_BUFFERED) {
      ws.send(buf)
      self.postMessage({ type: 'ok', buf: ws.bufferedAmount })
    } else {
      self.postMessage({ type: 'drop' })
    }
    return
  }
  // IPC fallback: must copy since we reuse preallocBuf
  const copy = new ArrayBuffer(buf.byteLength)
  new Uint8Array(copy).set(new Uint8Array(buf))
  self.postMessage(copy, [copy])
}

// ── Tier A: VideoFrame.copyTo() — bypasses canvas entirely ──────────
// Returns true if we handled the frame, false to fall through to canvas.
async function tryCopyTo(source, outW, outH) {
  if (!source.copyTo) return false

  const sw = source.displayWidth || source.codedWidth || 0
  const sh = source.displayHeight || source.codedHeight || 0
  if (sw !== outW || sh !== outH) return false

  const byteSize = outW * outH * 4
  ensureBuffer(byteSize)

  try {
    // Try RGBA first (Canvas2D spec guarantees this byte order)
    await source.copyTo(preallocBuf, { format: 'RGBA' })
    return true
  } catch (e1) {
    try {
      // RGBX fallback (alpha channel filled with 0xFF — same layout)
      await source.copyTo(preallocBuf, { format: 'RGBX' })
      return true
    } catch (e2) {
      return false
    }
  }
}

self.onmessage = async function (e) {
  if (e.data && e.data.type === 'init') {
    connectWs(e.data.wsPort, e.data.wsToken || '')
    return
  }

  const { dx, dy, dw, dh, outW, outH, fullCoverage } = e.data
  const source = e.data.frame || e.data.bmp
  if (!source) return

  try {
    // ── Tier A: VideoFrame.copyTo() when source fills output exactly ──
    if (fullCoverage && source.copyTo) {
      const ok = await tryCopyTo(source, outW, outH)
      if (ok) {
        if (source.close) source.close()
        sendBuffer(preallocBuf)
        return
      }
    }

    // ── Tier B: Canvas getImageData (letterboxing/scaling path) ──
    if (!canvas || outW !== lastW || outH !== lastH) {
      canvas = new OffscreenCanvas(outW, outH)
      ctx = canvas.getContext('2d', { willReadFrequently: true, alpha: false, desynchronized: true })
      if (!ctx) throw new Error('Failed to get 2D context')
      ctx.imageSmoothingEnabled = false
      lastW = outW
      lastH = outH
      MAX_BUFFERED = Math.ceil(outW * outH * 4 * 1.1)
      ctx.fillStyle = '#000'
      ctx.fillRect(0, 0, outW, outH)
    }

    if (!fullCoverage) {
      ctx.fillStyle = '#000'
      ctx.fillRect(0, 0, outW, outH)
    }

    ctx.drawImage(source, dx, dy, dw, dh)
    if (source.close) source.close()

    const imgData = ctx.getImageData(0, 0, outW, outH)
    sendBuffer(imgData.data.buffer)
  } catch (err) {
    if (source && source.close) try { source.close() } catch (_) {}
    console.error('[WORKER] frame processing error:', err)
    // Always signal completion so main thread unblocks _workerBusy
    self.postMessage({ type: 'drop' })
  }
}
