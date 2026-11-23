// BridgeCam Shared Constants
// All magic numbers as named constants for maintainability

// ICE Configuration
export const ICE_SERVERS = [{ urls: 'stun:stun.l.google.com:19302' }]
export const ICE_CANDIDATE_POOL_SIZE = 1

// Signaling
export const DEFAULT_SIGNALING_PORT = 3000
export const SIGNALING_PATH = '/ws'

// Reconnect (Sprint 10.2)
export const MAX_RECONNECT_ATTEMPTS = 10
export const RECONNECT_BASE_DELAY_MS = 1000
export const MAX_RECONNECT_DELAY_MS = 30000

// Camera acquisition retries
export const CAMERA_BACKOFFS_MS = [500, 1000, 1500, 2000]
export const CAMERA_MAX_ATTEMPTS = 4

// Resolution dimensions (width x height)
export const RESOLUTION_720P = { width: 1280, height: 720 }
export const RESOLUTION_1080P = { width: 1920, height: 1080 }
export const RESOLUTION_2160P = { width: 3840, height: 2160 }

export const RESOLUTION_MAP = {
  '720': RESOLUTION_720P,
  '1080': RESOLUTION_1080P,
  '2160': RESOLUTION_2160P
}

// Target bitrates per resolution (bps)
export const BITRATE_720P = 6000000
export const BITRATE_1080P = 12000000
export const BITRATE_4K = 20000000
export const BITRATE_ENCODER_FLOOR = 4000000

// FPS limits
export const MIN_FPS = 10
export const MAX_FPS = 60
export const DEFAULT_FPS = 30
export const AUTO_FALLBACK_FPS = 30

// Stats intervals (ms)
export const SENDER_STATS_INTERVAL_MS = 2000
export const RECEIVER_STATS_INTERVAL_MS = 1000
export const LATENCY_PING_INTERVAL_MS = 2000

// Quality feedback thresholds
export const LOSS_THRESHOLD_HIGH = 0.05
export const LOSS_THRESHOLD_LOW = 0.02
export const DROPPED_FRAMES_THRESHOLD = 5
export const FPS_UNDERPERFORM_FACTOR = 0.65

// Bitrate probing
export const BITRATE_REDUCE_FACTOR = 0.9
export const BITRATE_INCREASE_FACTOR = 1.1
export const BITRATE_PROBE_INCREASE = 1.15
export const BITRATE_PROBE_DECREASE = 0.85

// Auto-fallback thresholds
export const FPS_HIGH_THRESHOLD = 50
export const BITRATE_LOW_THRESHOLD_60FPS = 2500000
export const BITRATE_LOW_THRESHOLD_30FPS = 1000000

// Encoder settings
export const DEGRADATION_PREFERENCE = 'maintain-resolution'
export const DEFAULT_ENCODER_MAX_FRAMERATE = 30

// Virtual camera
export const VIRTUAL_CAMERA_FRIENDLY_NAME = 'BridgeCam Source'
export const VIRTUAL_CAMERA_CLSID = '{B9EAAFE1-1234-5678-ABCD-1234567890AB}'

// Shared memory
export const SHM_FILE_PATH = 'C:\\ProgramData\\BridgeCam\\framebuffer.dat'
export const SHM_HEADER_SIZE = 12
export const MAX_FRAME_BYTES = 3840 * 2160 * 4  // 4K RGBA
export const MAX_MAPPING_BYTES = SHM_HEADER_SIZE + MAX_FRAME_BYTES

// Audio
export const AUDIO_SAMPLE_RATE = 48000
export const AUDIO_CHANNELS = 2
export const AUDIO_SAMPLES_PER_QUANTUM = 128
export const AUDIO_BUFFER_SIZE = AUDIO_SAMPLES_PER_QUANTUM * AUDIO_CHANNELS * 4  // 1024 bytes
export const AUDIO_RING_BUFFER_MAX_SAMPLES = 19200  // ~200ms

// Frame socket
export const MAX_WS_BUFFERED_BYTES = 8500000  // ~1 frame

// Output dimensions (fixed)
export const OUTPUT_WIDTH = 1920
export const OUTPUT_HEIGHT = 1080