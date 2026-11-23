// BridgeCam Shared WebRTC Utilities
// Common WebRTC utilities (SDP parsing, ICE config, codec preferences)

import { ICE_SERVERS, ICE_CANDIDATE_POOL_SIZE, BITRATE_1080P, BITRATE_720P, BITRATE_4K, BITRATE_ENCODER_FLOOR, DEGRADATION_PREFERENCE, DEFAULT_ENCODER_MAX_FRAMERATE } from './constants.js'

// Build ICE configuration
export function buildIceConfig(options = {}) {
  return {
    iceServers: options.iceServers || ICE_SERVERS,
    iceCandidatePoolSize: options.iceCandidatePoolSize ?? ICE_CANDIDATE_POOL_SIZE
  }
}

// Get target bitrate for a resolution
export function getTargetBitrate(resolution) {
  switch (resolution) {
    case '720': return BITRATE_720P
    case '1080': return BITRATE_1080P
    case '2160': return BITRATE_4K
    default: return BITRATE_1080P
  }
}

// Configure sender bitrate parameters
export function configureSenderBitrate(sender, resolution, degradationPreference = DEGRADATION_PREFERENCE) {
  if (!sender || typeof sender.getParameters !== 'function' || typeof sender.setParameters !== 'function') {
    return null
  }

  const params = sender.getParameters()
  if (!params.encodings || !params.encodings.length) params.encodings = [{}]

  const target = getTargetBitrate(resolution)
  params.encodings.forEach(e => {
    e.maxBitrate = target
    e.priority = 'high'
    e.networkPriority = 'high'
    e.maxFramerate = DEFAULT_ENCODER_MAX_FRAMERATE
    e.scaleResolutionDownBy = 1.0
  })
  params.degradationPreference = degradationPreference

  return params
}

// Set codec preferences on the video transceiver based on hardware hint
export function setCodecPreferences(connOrTransceiver, hasHWHint = true) {
  if (!connOrTransceiver) return

  const transceiver = typeof connOrTransceiver.setCodecPreferences === 'function'
    ? connOrTransceiver
    : connOrTransceiver.getTransceivers?.().find(t => t.sender?.track?.kind === 'video')

  if (!transceiver || typeof transceiver.setCodecPreferences !== 'function') return

  try {
    if (typeof RTCRtpSender !== 'undefined' && typeof RTCRtpSender.getCapabilities === 'function') {
      const caps = RTCRtpSender.getCapabilities('video') || { codecs: [] }
      const h264 = caps.codecs.find(c => /h264/i.test(c.mimeType))
      const vp8 = caps.codecs.find(c => /vp8/i.test(c.mimeType))

      if (h264 && hasHWHint) {
        const preferred = [h264].concat(caps.codecs.filter(c => c !== h264))
        transceiver.setCodecPreferences(preferred)
      } else if (vp8) {
        const preferred = [vp8].concat(caps.codecs.filter(c => c !== vp8))
        transceiver.setCodecPreferences(preferred)
      }
    }
  } catch (e) {
    console.warn('setCodecPreferences not available', e)
  }
}

// Check if hardware H.264 support is likely based on user agent
export function hasHWH264Hint() {
  const ua = (typeof navigator !== 'undefined' && navigator.userAgent) ? navigator.userAgent : ''
  return /iPhone|iPad|Android/i.test(ua) ||
         /Windows NT|Macintosh|Mac OS X|Linux/i.test(ua)
}

// Probe bitrate adjustment (factor > 1 = increase, < 1 = decrease)
export async function probeAdjustMaxBitrate(pc, factor) {
  const sender = pc?.getSenders()?.find(s => s.track && s.track.kind === 'video')
  if (!sender || typeof sender.getParameters !== 'function' || typeof sender.setParameters !== 'function') return

  try {
    const params = sender.getParameters()
    if (!params.encodings || !params.encodings.length) params.encodings = [{}]
    params.encodings.forEach(e => {
      if (!e.maxBitrate) e.maxBitrate = BITRATE_1080P
      e.maxBitrate = Math.max(BITRATE_ENCODER_FLOOR, Math.round(e.maxBitrate * factor))
    })
    await sender.setParameters(params)
  } catch (e) {
    console.warn('probeAdjustMaxBitrate failed', e)
  }
}

// Create peer connection with standard config and event handlers
export function createPeerConnection(iceConfig, handlers = {}) {
  const conn = new RTCPeerConnection(iceConfig)

  if (handlers.onIceCandidate) {
    conn.addEventListener('icecandidate', ev => {
      if (ev.candidate) handlers.onIceCandidate(ev.candidate)
    })
  }

  if (handlers.onConnectionStateChange) {
    conn.addEventListener('connectionstatechange', () => {
      handlers.onConnectionStateChange(conn.connectionState)
    })
  }

  if (handlers.onIceConnectionStateChange) {
    conn.addEventListener('iceconnectionstatechange', () => {
      handlers.onIceConnectionStateChange(conn.iceConnectionState)
    })
  }

  return conn
}

// Drain pending ICE candidates after remote description is set
export function drainPendingIceCandidates(conn, pendingIce) {
  return async () => {
    while (pendingIce.length) {
      const c = pendingIce.shift()
      try {
        await conn.addIceCandidate(c)
      } catch (e) {
        console.warn('addIceCandidate failed', e)
      }
    }
  }
}

// Minimize receiver-side buffering for low latency
export function tuneReceiverForLowLatency(conn) {
  try {
    const receivers = conn.getReceivers()
    for (const r of receivers) {
      if (r.track && r.track.kind === 'video') {
        if ('jitterBufferTarget' in r) r.jitterBufferTarget = 0
        if ('playoutDelayHint' in r) r.playoutDelayHint = 0
      }
    }
  } catch (e) {
    console.warn('tuneReceiverForLowLatency failed', e)
  }
}

// Parse SDP to extract video resolution info (utility for debugging)
export function parseSDPResolution(sdp) {
  if (!sdp || typeof sdp !== 'string') return null
  const resMatch = sdp.match(/a=fmtp:\d+\s+(\d+)x(\d+)/)
  if (resMatch) return { width: Number.parseInt(resMatch[1], 10), height: Number.parseInt(resMatch[2], 10) }
  return null
}