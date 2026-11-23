// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 BridgeCam Contributors

export async function listVideoInputs() {
  const devices = await navigator.mediaDevices.enumerateDevices()
  return devices.filter(d => d.kind === 'videoinput')
}

export function buildConstraints(deviceId, resolution, fps = 30, withAudio = false) {
  const widths = { '720': 1280, '1080': 1920, '2160': 3840 }
  const heightMap = { '720': 720, '1080': 1080, '2160': 2160 }

  const w = widths[resolution] || 1920
  const h = heightMap[resolution] || 1080

  // clamp fps to sensible range (10-60)
  const requestedFps = Math.min(Math.max(parseInt(fps || 30, 10) || 30, 10), 60)

  const videoConstraints = {
    deviceId: deviceId ? { exact: deviceId } : undefined,
    width: { min: Math.min(w, 1280), ideal: w },
    height: { min: Math.min(h, 720), ideal: h },
    frameRate: { ideal: requestedFps, max: requestedFps }
  }

  // audio constraints (when enabled) — explicitly disable browser audio processing
  const audioConstraints = withAudio ? {
    echoCancellation: false,
    noiseSuppression: false,
    autoGainControl: false
  } : false

  return {
    audio: audioConstraints,
    video: videoConstraints
  }
}

export async function getCameraStream(deviceId, resolution, fps, withAudio = false) {
  const constraints = buildConstraints(deviceId, resolution, fps, withAudio)
  return navigator.mediaDevices.getUserMedia(constraints)
}

export function getTestCameraStream() {
  const canvas = document.createElement('canvas')
  canvas.width = 1280
  canvas.height = 720
  const context = canvas.getContext('2d')
  const draw = () => {
    context.fillStyle = '#132638'
    context.fillRect(0, 0, canvas.width, canvas.height)
    context.fillStyle = '#52e3b1'
    context.font = 'bold 64px sans-serif'
    context.fillText('BridgeCam simulated camera', 86, 260)
    context.fillRect(0, 550, (Date.now() % 4000) / 4000 * canvas.width, 15)
    context.fillStyle = '#f3f5f8'
    context.font = '36px monospace'
    context.fillText(new Date().toLocaleTimeString(), 86, 340)
  }
  draw()
  const stream = canvas.captureStream(30)
  const track = stream.getVideoTracks()[0]
  const timer = setInterval(draw, 33)
  const stop = track.stop.bind(track)
  track.stop = () => {
    clearInterval(timer)
    stop()
  }
  return stream
}
