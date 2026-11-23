// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 BridgeCam Contributors
//
// BridgeCam Desktop Receiver
// Connects to the signaling server, creates a room, displays QR, and shows incoming WebRTC video

console.log('[DESKTOP] main.js loaded');

const STUN_SERVERS = [
  { urls: 'stun:stun.l.google.com:19302' },
  { urls: 'stun:stun1.l.google.com:19302' },
  { urls: 'stun:stun.cloudflare.com:3478' }
]
let turnServers = []

// DOM elements
const serverUrlInput = document.getElementById('serverUrl')
const createRoomBtn = document.getElementById('createRoomBtn')
const connectPanel = document.getElementById('connectPanel')
const viewerPanel = document.getElementById('viewerPanel')
const qrContainer = document.getElementById('qrContainer')
const qrCanvas = document.getElementById('qrCanvas')
const roomIdDisplay = document.getElementById('roomIdDisplay')
const mobileLinkEl = document.getElementById('mobileLink')
const video = document.getElementById('remote')
const statusBadge = document.getElementById('status')
const latencyEl = document.getElementById('latency')
const statsEl = document.getElementById('stats')
const diagEl = document.getElementById('senderDiagnostic')
const errorEl = document.getElementById('error')
const disconnectBtn = document.getElementById('disconnectBtn')
const startPipeBtn = document.getElementById('startPipeBtn')
const stopPipeBtn = document.getElementById('stopPipeBtn')
const shmInfo = document.getElementById('shmInfo')
const checkUpdateBtn = document.getElementById('checkUpdateBtn')
const updateStatusEl = document.getElementById('updateStatus')

// View Switcher Elements
const viewTabs = document.getElementById('viewTabs')
const tabRoom = document.getElementById('tabRoom')
const tabCamera = document.getElementById('tabCamera')

// CAPTCHA modal elements
const captchaModal    = document.getElementById('captchaModal')
const captchaQuestion = document.getElementById('captchaQuestion')
const captchaAnswer   = document.getElementById('captchaAnswer')
const captchaError    = document.getElementById('captchaError')
const captchaConfirm  = document.getElementById('captchaConfirm')
const captchaCancel   = document.getElementById('captchaCancel')

// Recent rooms elements
const recentRoomsSection = document.getElementById('recentRoomsSection')
const recentRoomsList    = document.getElementById('recentRoomsList')

// Sprint 9: Camera control elements
const controlsSidebar = document.getElementById('controlsSidebar')
const cameraControlsGrid = document.getElementById('cameraControlsGrid')
const refreshCapsBtn = document.getElementById('refreshCapsBtn')

// Resolution tier selector
const pipeTierSelect = document.getElementById('pipeTierSelect')
if (pipeTierSelect) {
  pipeTierSelect.addEventListener('change', () => {
    const newTier = pipeTierSelect.value
    if (newTier !== _pipeTier) {
      _pipeTier = newTier
      console.log(`[DESKTOP] pipe tier changed to: ${_pipeTier}`)
      // Restart the pipe to apply the new MAX_DIM
      if (pipeInterval) {
        stopFramePipe({ keepVirtualCamera: true })
        setTimeout(() => startFramePipe(), 100)
      }
    }
  })
}

// view management
function showView(view) {
  if (view === 'room') {
    connectPanel.hidden = false
    viewerPanel.hidden = true
    if (tabRoom) tabRoom.classList.add('active')
    if (tabCamera) tabCamera.classList.remove('active')
  } else if (view === 'camera') {
    connectPanel.hidden = true
    viewerPanel.hidden = false
    if (tabRoom) tabRoom.classList.remove('active')
    if (tabCamera) tabCamera.classList.add('active')
  }
}

if (tabRoom) tabRoom.addEventListener('click', () => showView('room'))
if (tabCamera) tabCamera.addEventListener('click', () => showView('camera'))

// sanity check – is the Tauri API object present yet?
console.log('[DESKTOP] initial __TAURI__ object:', window.__TAURI__)

// hide pipe controls until video is active
if (startPipeBtn) { startPipeBtn.hidden = true; console.log('[DESKTOP] hide startPipeBtn'); }
if (stopPipeBtn) { stopPipeBtn.hidden = true; console.log('[DESKTOP] hide stopPipeBtn'); }
if (shmInfo) { shmInfo.hidden = true; console.log('[DESKTOP] hide shmInfo'); }

let ws = null
let pc = null
let pendingIce = []
let latencyInterval = null
let statsInterval = null
let lastInboundStats = null

// Frame pipe state
let pipeInterval = null
let shmPath = null
let shmWidth = 0
let shmHeight = 0
let pipeWriting = false  // mutex: skip frame if previous IPC write is still in flight

// Resolution tier — declared early so settings init can reference it
let _pipeTier = 'balanced'

// Audio pipe state (Sprint 7 — mic pipe: AudioWorklet → WS → VB-Audio Cable Input)
let _audioCtx = null
let _audioWs = null
let _audioWorkletNode = null
let _audioPort = 0
let _audioPortResolve = null
let _audioPortPromise = new Promise(r => { _audioPortResolve = r })
let _audioWorkletLoaded = false
let _micMuted = false

// Sprint 9: Camera control state
let _cameraCapabilities = null  // last received capabilities from phone
let _cameraCapsRetryTimer = null
let _cameraCapsRetryCount = 0
const MAX_CAMERA_CAP_RETRIES = 6

// Sprint 10.1: Camera pause overlay state
let _cameraIsPaused = false

// Sprint 10.3: ICE restart (desktop side — handles ice-restart offers from phone)
let _pendingIceRestart = false

// Sprint 10.5: Connection quality state (signal bars)
// Quality is derived from inbound-rtp stats: fps + packet loss + decoded frames
let _qualityLevel = -1  // -1=unknown, 0=none, 1=poor, 2=fair, 3=good, 4=excellent

// ── CAPTCHA state ────────────────────────────────────────────────────
let _captchaA = 0, _captchaB = 0, _captchaOp = '+'
let _captchaResolve = null   // Promise resolve — called with true (pass) or false (cancel)
// Set to true for programmatic room creation (auto-init) that skips the UI puzzle
let _captchaSkip = false

// ── Room history (persisted in localStorage) ─────────────────────────
// Stores up to MAX_ROOM_HISTORY rooms most-recently-created, newest first.
const MAX_ROOM_HISTORY = 5
const ROOM_HISTORY_KEY = 'bridgecam-room-history'

function loadRoomHistory() {
  try { return JSON.parse(localStorage.getItem(ROOM_HISTORY_KEY) || '[]') } catch { return [] }
}

function saveRoomToHistory(roomId, serverUrl, mobileUrl) {
  const history = loadRoomHistory().filter(r => r.roomId !== roomId)
  history.unshift({ roomId, serverUrl, mobileUrl, createdAt: Date.now() })
  history.splice(MAX_ROOM_HISTORY) // keep only the 5 most recent
  localStorage.setItem(ROOM_HISTORY_KEY, JSON.stringify(history))
}

function removeRoomFromHistory(roomId) {
  const history = loadRoomHistory().filter(r => r.roomId !== roomId)
  localStorage.setItem(ROOM_HISTORY_KEY, JSON.stringify(history))
}

// Auto-reconnect state (Sprint 10.2)
let currentRoomId = null
let reconnectAttempts = 0
const MAX_RECONNECT_ATTEMPTS = 10
const RECONNECT_BASE_DELAY = 1000
let reconnectTimer = null
let intentionalDisconnect = false

// ── Settings ─────────────────────────────────────────────────────────
const SETTINGS_KEY = 'bridgecam-settings'
const SETTINGS_DEFAULTS = {
  defaultServer:      'wss://bridgecam.onrender.com/ws',
  autoReconnect:      true,
  maxReconnects:      10,
  icePolicy:          'all',
  defaultTier:        'balanced',
  targetFps:          60,
  doubleBuffer:       true,
  fastCopy:           true,
  rcvBuf:             64,
  showStats:          true,
  showQuality:        true,
  videoFit:           'contain',
  accentColor:        '#00e5b8',
  micAutoStart:       false,
  audioSampleRate:    48000,
  noiseSuppression:   true,
  saveHistory:        true,
  maxHistory:         5,
  // Motion detection defaults
  motionSensitivity:  20,
  motionAutoEnable:   false,
  // Recording defaults
  recordingSaveDir:   '',       // empty = browser download; otherwise Tauri saves to this directory
  recordingCodec:     'vp9',    // 'vp9' | 'vp8' | 'auto'
  // Time-lapse default
  timelapseInterval:  5,
}

function loadSettings() {
  try {
    const stored = JSON.parse(localStorage.getItem(SETTINGS_KEY) || '{}')
    return { ...SETTINGS_DEFAULTS, ...stored }
  } catch { return { ...SETTINGS_DEFAULTS } }
}

function saveSettings(patch) {
  const current = loadSettings()
  const next = { ...current, ...patch }
  localStorage.setItem(SETTINGS_KEY, JSON.stringify(next))
  return next
}

// Apply a settings object to the live UI / runtime values
function applySettings(s) {
  // Video fit
  const vid = document.getElementById('remote')
  if (vid) vid.style.objectFit = s.videoFit || 'contain'

  // Accent color
  if (s.accentColor) {
    document.documentElement.style.setProperty('--accent', s.accentColor)
    document.documentElement.style.setProperty('--accent-dim', hexToRgba(s.accentColor, 0.12))
    document.documentElement.style.setProperty('--accent-glow', `0 0 20px ${hexToRgba(s.accentColor, 0.28)}`)
  }

  // Stats & quality bars visibility — uses data attribute so CSS hides them
  const statsEl2 = document.getElementById('stats')
  const latEl    = document.getElementById('latency')
  const qBars    = document.getElementById('qualityBars')
  if (statsEl2) statsEl2.dataset.settingHidden = s.showStats ? '' : '1'
  if (latEl)    latEl.dataset.settingHidden    = s.showStats ? '' : '1'
  if (qBars)    qBars.dataset.settingHidden    = s.showQuality ? '' : '1'

  // Default tier for new pipes (safe — _pipeTier declared above)
  if (s.defaultTier && !pipeInterval) _pipeTier = s.defaultTier

  // Default server pre-fill
  if (s.defaultServer && serverUrlInput && !serverUrlInput.value) {
    serverUrlInput.value = s.defaultServer
  }

  // Pre-fill motion modal defaults from settings
  const motionSensInput = document.getElementById('motionSensitivity')
  if (motionSensInput && s.motionSensitivity) motionSensInput.value = s.motionSensitivity

  // Pre-fill timelapse modal default from settings
  const tlIntervalInput = document.getElementById('timelapseInterval')
  if (tlIntervalInput && s.timelapseInterval) tlIntervalInput.value = s.timelapseInterval

  // Update the save-dir display
  const saveDirDisplay = document.getElementById('settingRecSaveDirDisplay')
  if (saveDirDisplay) {
    saveDirDisplay.textContent = s.recordingSaveDir || 'Downloads (browser default)'
  }
}

// Tiny helper: "#rrggbb" → "rgba(r,g,b,a)"
function hexToRgba(hex, alpha) {
  const r = parseInt(hex.slice(1,3), 16)
  const g = parseInt(hex.slice(3,5), 16)
  const b = parseInt(hex.slice(5,7), 16)
  return `rgba(${r},${g},${b},${alpha})`
}

// ── Settings panel DOM wiring ─────────────────────────────────────────
const settingsBtn     = document.getElementById('settingsBtn')
const settingsOverlay = document.getElementById('settingsOverlay')
const settingsPanel   = document.getElementById('settingsPanel')
const settingsCloseBtn = document.getElementById('settingsCloseBtn')
const settingsSaveBtn  = document.getElementById('settingsSaveBtn')
const settingsSaveStatus = document.getElementById('settingsSaveStatus')

// Map: setting key → element id
const SETTING_FIELDS = {
  defaultServer:    'settingDefaultServer',
  autoReconnect:    'settingAutoReconnect',
  maxReconnects:    'settingMaxReconnects',
  icePolicy:        'settingIcePolicy',
  defaultTier:      'settingDefaultTier',
  targetFps:        'settingTargetFps',
  doubleBuffer:     'settingDoubleBuffer',
  fastCopy:         'settingFastCopy',
  rcvBuf:           'settingRcvBuf',
  showStats:        'settingShowStats',
  showQuality:      'settingShowQuality',
  videoFit:         'settingVideoFit',
  micAutoStart:     'settingMicAutoStart',
  audioSampleRate:  'settingAudioSampleRate',
  noiseSuppression: 'settingNoiseSuppression',
  saveHistory:      'settingSaveHistory',
  maxHistory:       'settingMaxHistory',
  // Motion
  motionSensitivity:    'settingMotionSensitivity',
  motionAutoEnable:     'settingMotionAutoEnable',
  // Recording
  recordingSaveDir:     'settingRecSaveDir',
  recordingCodec:       'settingRecCodec',
  // Time-lapse
  timelapseInterval:    'settingTimelapseInterval',
}

function populateSettingsPanel(s) {
  for (const [key, elId] of Object.entries(SETTING_FIELDS)) {
    const el = document.getElementById(elId)
    if (!el) continue
    if (el.type === 'checkbox') el.checked = !!s[key]
    else el.value = s[key] ?? ''
  }
  // Accent swatches
  document.querySelectorAll('.accent-swatch').forEach(sw => {
    sw.classList.toggle('active', sw.dataset.color === s.accentColor)
  })
  // Save directory display
  const dirDisplay = document.getElementById('settingRecSaveDirDisplay')
  if (dirDisplay) dirDisplay.textContent = s.recordingSaveDir || 'Downloads (browser default)'
}

function readSettingsPanel() {
  const patch = {}
  for (const [key, elId] of Object.entries(SETTING_FIELDS)) {
    const el = document.getElementById(elId)
    if (!el) continue
    if (el.type === 'checkbox') patch[key] = el.checked
    else if (el.type === 'number') patch[key] = Number(el.value)
    else patch[key] = el.value
  }
  // Accent from active swatch
  const activeSwatch = document.querySelector('.accent-swatch.active')
  if (activeSwatch) patch.accentColor = activeSwatch.dataset.color
  return patch
}

function openSettings() {
  const s = loadSettings()
  populateSettingsPanel(s)
  // Populate version
  const verEl = document.getElementById('settingsVersion')
  if (verEl && window.__TAURI__?.app?.getVersion) {
    window.__TAURI__.app.getVersion().then(v => { verEl.textContent = `v${v}` }).catch(() => {})
  }
  if (settingsSaveStatus) settingsSaveStatus.textContent = ''
  settingsOverlay.hidden = false
}

function closeSettings() {
  settingsOverlay.hidden = true
}

if (settingsBtn)      settingsBtn.addEventListener('click', openSettings)
if (settingsCloseBtn) settingsCloseBtn.addEventListener('click', closeSettings)

// Close on overlay backdrop click
if (settingsOverlay) {
  settingsOverlay.addEventListener('click', e => {
    if (e.target === settingsOverlay) closeSettings()
  })
}

// Close on Escape key
document.addEventListener('keydown', e => {
  if (e.key === 'Escape' && settingsOverlay && !settingsOverlay.hidden) closeSettings()
})

// Save button
if (settingsSaveBtn) {
  settingsSaveBtn.addEventListener('click', () => {
    const patch = readSettingsPanel()
    const saved = saveSettings(patch)
    applySettings(saved)
    if (settingsSaveStatus) {
      settingsSaveStatus.textContent = '✓ Saved'
      setTimeout(() => { if (settingsSaveStatus) settingsSaveStatus.textContent = '' }, 2200)
    }
  })
}

// Accent swatch live preview + active toggle
document.querySelectorAll('.accent-swatch').forEach(sw => {
  sw.addEventListener('click', () => {
    document.querySelectorAll('.accent-swatch').forEach(s => s.classList.remove('active'))
    sw.classList.add('active')
    // Live preview accent
    const color = sw.dataset.color
    document.documentElement.style.setProperty('--accent', color)
    document.documentElement.style.setProperty('--accent-dim', hexToRgba(color, 0.12))
    document.documentElement.style.setProperty('--accent-glow', `0 0 20px ${hexToRgba(color, 0.28)}`)
  })
})

// Video fit live preview
const settingVideoFitEl = document.getElementById('settingVideoFit')
if (settingVideoFitEl) {
  settingVideoFitEl.addEventListener('change', () => {
    const vid = document.getElementById('remote')
    if (vid) vid.style.objectFit = settingVideoFitEl.value
  })
}

// Clear history button
const settingClearHistory = document.getElementById('settingClearHistory')
if (settingClearHistory) {
  settingClearHistory.addEventListener('click', () => {
    localStorage.removeItem(ROOM_HISTORY_KEY)
    renderRecentRooms()
    settingClearHistory.textContent = 'Cleared ✓'
    setTimeout(() => { settingClearHistory.textContent = 'Clear' }, 1800)
  })
}

// Reset all settings button
const settingResetAll = document.getElementById('settingResetAll')
if (settingResetAll) {
  settingResetAll.addEventListener('click', () => {
    localStorage.removeItem(SETTINGS_KEY)
    const defaults = { ...SETTINGS_DEFAULTS }
    populateSettingsPanel(defaults)
    applySettings(defaults)
    settingResetAll.textContent = 'Reset ✓'
    setTimeout(() => { settingResetAll.textContent = 'Reset' }, 1800)
  })
}

// Browse save directory button (Tauri dialog)
const settingRecBrowseBtn = document.getElementById('settingRecBrowse')
if (settingRecBrowseBtn) {
  settingRecBrowseBtn.addEventListener('click', async () => {
    try {
      // Use Tauri dialog plugin to pick a folder
      const result = await window.__TAURI__.dialog.open({
        directory: true,
        multiple: false,
        title: 'Choose recording save directory',
      })
      if (result) {
        const dirInput = document.getElementById('settingRecSaveDir')
        if (dirInput) dirInput.value = result
        const dirDisplay = document.getElementById('settingRecSaveDirDisplay')
        if (dirDisplay) dirDisplay.textContent = result
      }
    } catch (e) {
      console.warn('[DESKTOP] Folder picker failed:', e)
    }
  })
}

// Clear save directory button
const settingRecClearBtn = document.getElementById('settingRecClearDir')
if (settingRecClearBtn) {
  settingRecClearBtn.addEventListener('click', () => {
    const dirInput = document.getElementById('settingRecSaveDir')
    if (dirInput) dirInput.value = ''
    const dirDisplay = document.getElementById('settingRecSaveDirDisplay')
    if (dirDisplay) dirDisplay.textContent = 'Downloads (browser default)'
  })
}

// Boot: load and apply persisted settings
;(function initSettings() {
  const s = loadSettings()
  // Pre-fill server URL if empty
  if (serverUrlInput && !serverUrlInput.value && s.defaultServer) {
    serverUrlInput.value = s.defaultServer
  }
  applySettings(s)
})()

// ── Collapsible settings sections ─────────────────────────────────────
// All sections start collapsed; clicking the label toggles open/closed.
;(function initCollapsibleSections() {
  document.querySelectorAll('.settings-section-label').forEach(label => {
    label.addEventListener('click', () => {
      const section = label.closest('.settings-section')
      if (section) section.classList.toggle('open')
    })
  })
})()

// ── Advanced settings toggle ───────────────────────────────────────
;(function initAdvancedToggle() {
  const advBtn = document.getElementById('advancedToggleBtn')
  const settingsBody = document.querySelector('.settings-body')
  if (!advBtn || !settingsBody) return
  advBtn.addEventListener('click', () => {
    const showing = settingsBody.classList.toggle('show-advanced')
    advBtn.classList.toggle('active', showing)
    advBtn.textContent = showing ? 'Hide Advanced' : 'Advanced'
  })
})()

// ── Sidebar collapse toggle ───────────────────────────────────────
;(function initSidebarToggle() {
  const toggleBtn = document.getElementById('sidebarToggleBtn')
  const sidebar = document.getElementById('controlsSidebar')
  if (!toggleBtn || !sidebar) return
  toggleBtn.addEventListener('click', () => {
    sidebar.classList.toggle('collapsed')
  })
})()


// ── Helpers ──────────────────────────────────────────────────────────

// Shared memory helpers (Sprint 6 scaffolding)
// helpers that wait for the Tauri `invoke` function to be injected
async function ensureInvokeReady(timeout = 5000) {
  const start = Date.now()
  while (Date.now() - start < timeout) {
    if (window?.__TAURI__?.core?.invoke) return true
    await new Promise(r => setTimeout(r, 50))
  }
  console.warn('[DESKTOP] ensureInvokeReady timed out')
  return false
}

async function createSharedMemory(size) {
  if (await ensureInvokeReady()) {
    return await window.__TAURI__.core.invoke('create_shared_memory', { size })
  }
  throw new Error('Tauri APIs not available')
}

// helper: convert Uint8Array to base64 string — fast LUT-based encoder
// avoids the slow btoa(String.fromCharCode…) path for large buffers
const _b64Chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'
function uint8ToBase64(u8) {
  const len = u8.length
  let result = ''
  let i = 0
  for (; i + 2 < len; i += 3) {
    const a = u8[i], b = u8[i + 1], c = u8[i + 2]
    result += _b64Chars[a >> 2]
    result += _b64Chars[((a & 3) << 4) | (b >> 4)]
    result += _b64Chars[((b & 15) << 2) | (c >> 6)]
    result += _b64Chars[c & 63]
  }
  if (i < len) {
    const a = u8[i]
    result += _b64Chars[a >> 2]
    if (i + 1 < len) {
      const b = u8[i + 1]
      result += _b64Chars[((a & 3) << 4) | (b >> 4)]
      result += _b64Chars[(b & 15) << 2]
      result += '='
    } else {
      result += _b64Chars[(a & 3) << 4]
      result += '=='
    }
  }
  return result
}

async function writeSharedMemory(path, offset, data) {
  if (await ensureInvokeReady()) {
    const b64 = uint8ToBase64(data);
    return await window.__TAURI__.core.invoke('write_shared_memory_base64', { path, offset, dataB64: b64 });
  }
  throw new Error('Tauri APIs not available')
}

// Named Win32 shared memory — primary method on Windows.
// The DirectShow filter discovers this by the well-known name
// "Local\BridgeCamFrameBuffer" without needing any env vars.
async function createNamedSharedMemory(width, height) {
  if (await ensureInvokeReady()) {
    return await window.__TAURI__.core.invoke('create_named_shared_memory', { width, height })
  }
  throw new Error('Tauri APIs not available')
}

async function writeNamedSharedMemory(data, width, height) {
  if (await ensureInvokeReady()) {
    const dataB64 = uint8ToBase64(data)
    return await window.__TAURI__.core.invoke('write_named_shared_memory_base64', { dataB64, width, height })
  }
  throw new Error('Tauri APIs not available')
}

// Raw binary frame write — bypasses base64/JSON entirely.
// Tauri v2 delivers Uint8Array as InvokeBody::Raw on the Rust side.
// This is the hot path for 1080p 30/60fps.
async function writeFrameRaw(pixels) {
  return await window.__TAURI__.core.invoke('write_frame_raw', pixels)
}

// Windows Virtual Camera API — makes BridgeCam appear in NVIDIA Broadcast and
// all Media Foundation apps, not just legacy DirectShow consumers.
async function activateVirtualCamera() {
  try {
    if (await ensureInvokeReady()) {
      const result = await window.__TAURI__.core.invoke('activate_virtual_camera')
      virtualCameraActive = true
      console.log('[DESKTOP] IMFVirtualCamera activated —', result)
    }
  } catch (e) {
    // Non-fatal: filter still works for DirectShow apps without this
    console.warn('[DESKTOP] virtual camera activation failed (Win11 22H2+ required):', e)
  }
}

async function deactivateVirtualCamera() {
  try {
    if (window.__TAURI__?.core?.invoke) {
      await window.__TAURI__.core.invoke('deactivate_virtual_camera')
      console.log('[DESKTOP] IMFVirtualCamera deactivated')
    }
  } catch (e) {
    console.warn('[DESKTOP] virtual camera deactivation failed:', e)
  }
}

// Which shared-memory mode is active: 'named' (Win32 kernel object) or 'file' (legacy temp file)
let shmMode = 'none'
// Tracks whether IMFVirtualCamera has been activated so we don't Remove()/re-add
// on every resolution change (that causes NVIDIA Broadcast to miss the device).
let virtualCameraActive = false

function setStatus(s) {
  statusBadge.textContent = s
  if (s === 'Waiting…' || s === 'Connecting…' || s === 'Reconnecting…') {
    statusBadge.classList.add('pulsing')
  } else {
    statusBadge.classList.remove('pulsing')
  }
}

// Sprint 10.5: Update the signal-bars quality indicator in the toolbar.
// level: -1 = unknown, 0 = no signal, 1 = poor, 2 = fair, 3 = good, 4 = excellent
function setQualityLevel(level) {
  if (level === _qualityLevel) return
  _qualityLevel = level
  const el = document.getElementById('qualityBars')
  if (!el) return
  const bars = el.querySelectorAll('.q-bar')
  const labels = [null, 'Poor', 'Fair', 'Good', 'Excellent']
  const colors = [null, 'var(--danger)', 'var(--warning)', 'var(--accent)', 'var(--success)']
  bars.forEach((bar, i) => {
    // bar index 0-3 corresponds to signal strength 1-4
    const barLevel = i + 1
    bar.style.opacity = level >= barLevel ? '1' : '0.2'
    bar.style.background = level >= barLevel ? (colors[level] || 'var(--accent)') : 'var(--border)'
  })
  el.title = level <= 0 ? 'No signal' : (labels[level] || '')
  // Hide via data attribute so CSS rule works; the settingHidden attribute
  // controls whether the user wants quality bars visible at all
  if (level < 0) el.style.display = 'none'
  else el.style.display = ''
}

// Sprint 10.1: Show / hide the "Camera Paused" overlay on the video.
function setCameraPausedOverlay(paused) {
  _cameraIsPaused = paused
  let overlay = document.getElementById('cameraPausedOverlay')
  if (paused) {
    if (!overlay) {
      overlay = document.createElement('div')
      overlay.id = 'cameraPausedOverlay'
      overlay.className = 'camera-paused-overlay'
      overlay.innerHTML = '<span class="paused-icon">||</span><span class="paused-text">Camera Paused</span><span class="paused-sub">Phone switched apps or screen is locked</span>'
      const videoWrap = document.querySelector('.video-wrap')
      if (videoWrap) videoWrap.appendChild(overlay)
    }
    overlay.hidden = false
  } else {
    if (overlay) overlay.hidden = true
  }
}
function showError(msg) { errorEl.hidden = false; errorEl.textContent = msg }
function clearError() { errorEl.hidden = true; errorEl.textContent = '' }

// ── CAPTCHA ──────────────────────────────────────────────────────────
// A lightweight math puzzle (no external service) that guards room creation.
// Returns a Promise<boolean> — resolves true if the user passes, false if cancelled.
function showCaptcha() {
  // Generate a random arithmetic problem: (a op b) where result is always positive
  const ops = ['+', '+', '+', '-', '×']  // weight towards addition for friendliness
  _captchaOp = ops[Math.floor(Math.random() * ops.length)]
  _captchaA = Math.floor(Math.random() * 12) + 1
  _captchaB = Math.floor(Math.random() * 10) + 1
  // For subtraction ensure result ≥ 0
  if (_captchaOp === '-' && _captchaB > _captchaA) [_captchaA, _captchaB] = [_captchaB, _captchaA]

  captchaQuestion.textContent = `${_captchaA} ${_captchaOp} ${_captchaB}`
  captchaAnswer.value = ''
  captchaError.hidden = true
  captchaModal.hidden = false
  setTimeout(() => captchaAnswer.focus(), 50)

  return new Promise(resolve => { _captchaResolve = resolve })
}

function _captchaExpectedAnswer() {
  if (_captchaOp === '+') return _captchaA + _captchaB
  if (_captchaOp === '-') return _captchaA - _captchaB
  if (_captchaOp === '×') return _captchaA * _captchaB
  return 0
}

function _dismissCaptcha(passed) {
  captchaModal.hidden = true
  if (_captchaResolve) { _captchaResolve(passed); _captchaResolve = null }
}

captchaConfirm.addEventListener('click', () => {
  const answer = parseInt(captchaAnswer.value, 10)
  if (isNaN(answer) || answer !== _captchaExpectedAnswer()) {
    captchaError.hidden = false
    captchaAnswer.value = ''
    captchaAnswer.focus()
    return
  }
  _dismissCaptcha(true)
})

captchaCancel.addEventListener('click', () => _dismissCaptcha(false))

captchaAnswer.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') captchaConfirm.click()
  if (e.key === 'Escape') _dismissCaptcha(false)
})

// ── Recent Rooms UI ───────────────────────────────────────────────────

async function renderRecentRooms() {
  const history = loadRoomHistory()
  if (!recentRoomsSection || !recentRoomsList) return

  // Don't show the recent-rooms panel while a live session is in progress —
  // the user is already connected, and showing a Rejoin button for the active
  // room is confusing and caused an accidental double-join bug.
  if (currentRoomId) { recentRoomsSection.hidden = true; return }

  // Filter out the currently active room so it never appears in the list
  const pastRooms = history.filter(r => r.roomId !== currentRoomId)
  if (pastRooms.length === 0) { recentRoomsSection.hidden = true; return }

  recentRoomsSection.hidden = false
  recentRoomsList.innerHTML = ''

  for (const entry of pastRooms) {
    const li = document.createElement('li')
    li.className = 'recent-room-item'

    const idSpan = document.createElement('span')
    idSpan.className = 'recent-room-id'
    idSpan.textContent = entry.roomId

    const metaSpan = document.createElement('span')
    metaSpan.className = 'recent-room-meta'
    const age = Date.now() - entry.createdAt
    const hrs = Math.floor(age / 3_600_000)
    const mins = Math.floor((age % 3_600_000) / 60_000)
    metaSpan.textContent = hrs > 0 ? `${hrs}h ago` : `${mins}m ago`

    const statusSpan = document.createElement('span')
    statusSpan.className = 'recent-room-status'
    statusSpan.textContent = '…'

    const rejoinBtn = document.createElement('button')
    rejoinBtn.className = 'btn-rejoin'
    rejoinBtn.textContent = 'Rejoin'
    rejoinBtn.disabled = true

    li.appendChild(idSpan)
    li.appendChild(metaSpan)
    li.appendChild(statusSpan)
    li.appendChild(rejoinBtn)
    recentRoomsList.appendChild(li)

    // Asynchronously check if the room still exists on the server
    const httpUrl = getHttpUrl()
    fetch(`${httpUrl}/rooms/${entry.roomId}/check`, { signal: AbortSignal.timeout(6000) })
      .then(r => r.json())
      .then(data => {
        if (data.exists) {
          statusSpan.textContent = 'Live'
          statusSpan.className = 'recent-room-status live'
          rejoinBtn.disabled = false
          rejoinBtn.addEventListener('click', () => rejoinRoom(entry))
        } else {
          statusSpan.textContent = 'Gone'
          statusSpan.className = 'recent-room-status gone'
          // Room is gone — prune it from history automatically after a delay
          setTimeout(() => removeRoomFromHistory(entry.roomId), 2000)
        }
      })
      .catch(() => {
        statusSpan.textContent = '?'
        statusSpan.className = 'recent-room-status gone'
      })
  }
}

// Rejoin a saved room: connect WS + join without creating a new room
async function rejoinRoom(entry) {
  clearError()
  currentRoomId = entry.roomId
  serverUrlInput.value = entry.serverUrl || getHttpUrl()
  localStorage.setItem('bridgecam-server-url', serverUrlInput.value)

  roomIdDisplay.textContent = entry.roomId
  if (entry.mobileUrl) {
    mobileLinkEl.textContent = entry.mobileUrl
    await renderQR(entry.mobileUrl)
    qrContainer.hidden = false
  }

  if (ws) { try { ws.close() } catch(e){} ws = null }
  if (pc) { try { pc.close() } catch(e){} pc = null }
  pendingIce = []

  ws = connectSignaling(handleSignalingMessage)
  ws.addEventListener('open', () => {
    joinRoom(entry.roomId)
    setStatus('Waiting for phone…')
    intentionalDisconnect = false
    reconnectAttempts = 0
    latencyInterval = setInterval(() => {
      sendSignal({ type: 'latency-ping', t: Date.now() })
    }, 2000)
  })
  ws.addEventListener('close', () => {
    if (latencyInterval) { clearInterval(latencyInterval); latencyInterval = null }
    setLatency(null)
    stopReceiverStats()
    // Only auto-reconnect if it was an unexpected drop, not a deliberate close
    // and not a permanent error (room-full/room-not-found sets intentionalDisconnect)
    if (!intentionalDisconnect && currentRoomId) scheduleReconnect()
  })
  console.log(`[DESKTOP] Rejoining room ${entry.roomId}`)
}

function setLatency(ms) {
  if (!latencyEl) return
  if (typeof ms === 'number') {
    latencyEl.textContent = `${ms} ms`
    latencyEl.style.display = ''
  } else {
    latencyEl.textContent = '-- ms'
    latencyEl.style.display = 'none'
  }
}

function setSenderDiagnostic(obj) {
  if (!diagEl) return
  if (!obj) { diagEl.hidden = true; diagEl.textContent = ''; return }
  const when = new Date().toLocaleTimeString()
  diagEl.textContent = `[${when}] ${obj.level || 'info'}: ${obj.code ? obj.code + ' - ' : ''}${obj.message || ''}`
  diagEl.hidden = false
}

// Utility to start/stop the shared-memory frame pipe
// ── Resolution tier system ──────────────────────────────────────────
// Users can select a quality tier; higher tiers send more pixels through
// the pipe but require more CPU/bandwidth.  The DLL upscales to 1920×1080
// output regardless, so the choice is: how many *source* pixels to preserve.
//   'balanced' = MAX_DIM 1280 (~3.7MB/frame) — smooth 30fps on most hardware
//   'quality'  = MAX_DIM 1920 (~8.3MB/frame) — native 1080p, needs fast CPU
//   'ultra'    = MAX_DIM 3840 (~31MB/frame)  — 4K passthrough, requires beefy pipe
// _pipeTier declared at top of file
function getMaxDimForTier(tier) {
  switch (tier) {
    case 'ultra':    return 3840
    case 'quality':  return 1920
    case 'balanced':
    default:         return 1280
  }
}

async function startFramePipe() {
  console.log('[DESKTOP] startFramePipe invoked; video size', video.videoWidth, video.videoHeight)
  if (!video.videoWidth || !video.videoHeight) {
    console.warn('[DESKTOP] video dimensions not ready, deferring frame pipe until loadedmetadata');
    video.addEventListener('loadedmetadata', () => startFramePipe(), { once: true });
    return
  }

  // ── Adaptive output resolution ─────────────────────────────────
  // Match the source aspect ratio so we don't waste pixels on black
  // letterbox bars.  Cap the long edge at MAX_DIM to keep per-frame
  // data manageable for the getImageData + WS pipeline.
  //   balanced (1280): Portrait 1080×1920 → 720×1280 (3.7MB), Landscape → 1280×720
  //   quality  (1920): Native 1080p (8.3MB) — no DLL upscaling needed
  //   ultra    (3840): 4K passthrough (31MB) — for high-end setups
  // The DLL scales the SHM image up to fill 1920×1080 output.
  // On orientation change, OUTPUT_W/H are recalculated and SHM is resized.
  const MAX_DIM = getMaxDimForTier(_pipeTier)

  // Compute adaptive output dimensions from current video size.
  // Extracted to a function so we can recalculate on orientation change.
  // Both landscape and portrait cap the long edge at MAX_DIM.
  function computeOutputDims(sw, sh) {
    const longEdge = Math.max(sw, sh)
    const scale = longEdge > MAX_DIM ? MAX_DIM / longEdge : 1
    return {
      w: Math.round(sw * scale / 2) * 2,
      h: Math.round(sh * scale / 2) * 2
    }
  }

  const initSrc = computeOutputDims(video.videoWidth, video.videoHeight)
  let OUTPUT_W = initSrc.w
  let OUTPUT_H = initSrc.h
  console.log(`[DESKTOP] adaptive output: src=${video.videoWidth}x${video.videoHeight} → output=${OUTPUT_W}x${OUTPUT_H} (${(OUTPUT_W*OUTPUT_H*4/1024/1024).toFixed(1)}MB/frame)`)
  shmWidth = OUTPUT_W
  shmHeight = OUTPUT_H

  // Activate the virtual camera FIRST so the Frame Server loads the DLL.
  if (!virtualCameraActive) {
    try {
      await activateVirtualCamera()
    } catch (e) {
      console.warn('[DESKTOP] virtual camera pre-activation failed (will retry later):', e)
    }
  }

  // Create SHM at the fixed output size — only done once per session.
  try {
    await createNamedSharedMemory(shmWidth, shmHeight)
    shmMode = 'named'
    shmPath = 'Local\\BridgeCamFrameBuffer'
    console.log('[DESKTOP] named Win32 shared memory active:', shmPath, shmWidth, 'x', shmHeight)
  } catch (e) {
    console.warn('[DESKTOP] named shared memory unavailable, falling back to file:', e)
    shmMode = 'file'
    const size = shmWidth * shmHeight * 4
    try {
      shmPath = await createSharedMemory(size)
    } catch (e2) {
      console.error('[DESKTOP] failed to create file-based shm', e2)
      return
    }
    console.log('[DESKTOP] file-based shared memory path:', shmPath)
  }

  const pathEl = document.getElementById('shmPath')
  if (pathEl) pathEl.textContent = shmPath
  shmInfo.hidden = false
  startPipeBtn.hidden = true
  stopPipeBtn.hidden = false
  if (pipeTierSelect) { pipeTierSelect.value = _pipeTier; pipeTierSelect.hidden = false }
  const pipeRuntime = document.getElementById('pipeRuntimeControls')
  if (pipeRuntime) pipeRuntime.hidden = false
  const pipeStatusDesc = document.getElementById('pipeStatusDesc')
  if (pipeStatusDesc) pipeStatusDesc.textContent = `Running — ${shmWidth}×${shmHeight}`

  // Detect whether the raw binary IPC path works (Tauri v2+ only).
  let useRawIPC = true

  // Feature detection — logged once for diagnostics
  const _hasVideoFrame = typeof VideoFrame !== 'undefined'
  const _hasOffscreen  = typeof OffscreenCanvas !== 'undefined'
  console.log(`[DESKTOP] capabilities: VideoFrame=${_hasVideoFrame}, OffscreenCanvas=${_hasOffscreen}`)

  // ── Frame delivery: Worker → WebSocket (primary) or Tauri IPC (fallback) ──
  // Worker connects WebSocket directly to Rust frame socket, eliminating
  // the 8.3MB postMessage hop to main thread entirely.
  let _wsPort = 0
  let _wsToken = ''
  let _wsConnected = false
  let _lastWsBuf = 0
  try {
    _wsPort = await window.__TAURI__.core.invoke('get_frame_socket_port')
    _wsToken = await window.__TAURI__.core.invoke('get_socket_auth_token')
    if (!_wsPort) throw new Error('frame socket not running')
    console.log(`[DESKTOP] frame socket port: ${_wsPort}`)
  } catch (e) {
    console.warn('[DESKTOP] frame socket unavailable:', e)
  }

  // Frame-pipe stats
  let _pipeFrames = 0, _pipeDrops = 0
  let _pipeTierA = 0, _pipeTierB = 0  // fast-path vs canvas-path counts
  let _pipeFpsTimer = setInterval(() => {
    if (_pipeFrames > 0 || _pipeDrops > 0) {
      const wsInfo = _wsConnected ? `ws (buf=${(_lastWsBuf / 1024).toFixed(0)}KB)` : 'ipc'
      const tierInfo = `A=${_pipeTierA} B=${_pipeTierB}`
      console.log(`[DESKTOP] frame pipe: ${_pipeFrames} fps, ${_pipeDrops} dropped [${wsInfo}] [${tierInfo}] [tier=${_pipeTier}]`)
      _pipeFrames = 0; _pipeDrops = 0; _pipeTierA = 0; _pipeTierB = 0
    }
  }, 1000)

  // ── Double-buffered worker pipeline ────────────────────────────────
  // Two workers operate in a ping-pong pattern so that while worker A is
  // reading pixels (getImageData or copyTo, ~5-15ms), worker B receives
  // the NEXT frame from RVFC immediately.  This breaks the single-worker
  // serialization that caps throughput at 1/(worker_time).
  //
  // At 1280×720 with getImageData (~5ms):   single=~33fps, double=~60fps
  // At 1920×1080 with getImageData (~12ms): single=~20fps, double=~40fps
  // At 1920×1080 with copyTo     (~2ms):    single=~60fps, double=~60fps
  //
  // Worker message protocol:
  //   Main → Worker: { frame/bmp, dx, dy, dw, dh, outW, outH, fullCoverage }
  //   Worker → Main: { type:'ok'|'drop' } — unblocks this worker slot
  let _workerA = null
  let _workerB = null
  let _workerABusy = false
  let _workerBBusy = false

  let _pipeInflight = 0           // IPC-fallback backpressure
  const IPC_MAX_IN_FLIGHT = 2

  // Cache letterbox geometry — only recalculate when video dimensions change.
  let _lastSrcW = 0, _lastSrcH = 0
  let _dx = 0, _dy = 0, _dw = OUTPUT_W, _dh = OUTPUT_H
  let _fullCoverage = true

  function updateGeometry() {
    const srcW = video.videoWidth || OUTPUT_W
    const srcH = video.videoHeight || OUTPUT_H
    if (srcW === _lastSrcW && srcH === _lastSrcH) return
    _lastSrcW = srcW; _lastSrcH = srcH

    // Detect orientation change (portrait↔landscape) and recalculate output
    // dimensions so landscape video fills the DLL's 1920×1080 output natively.
    const newDims = computeOutputDims(srcW, srcH)
    if (newDims.w !== OUTPUT_W || newDims.h !== OUTPUT_H) {
      const oldW = OUTPUT_W, oldH = OUTPUT_H
      OUTPUT_W = newDims.w
      OUTPUT_H = newDims.h
      shmWidth = OUTPUT_W
      shmHeight = OUTPUT_H
      console.log(`[DESKTOP] orientation change: output ${oldW}x${oldH} → ${OUTPUT_W}x${OUTPUT_H}`)
      // Update Rust FRAME_W/FRAME_H atomics + SHM header so the frame socket
      // accepts the new frame size and the DLL reads correct dimensions.
      createNamedSharedMemory(OUTPUT_W, OUTPUT_H).then(() => {
        console.log(`[DESKTOP] SHM resized to ${OUTPUT_W}x${OUTPUT_H}`)
      }).catch(e => {
        console.warn('[DESKTOP] SHM resize failed:', e)
      })
      // Resize fallback canvas if it exists
      if (_fallbackCanvas) {
        _fallbackCanvas.width = OUTPUT_W
        _fallbackCanvas.height = OUTPUT_H
      }
    }

    const scale = Math.min(OUTPUT_W / srcW, OUTPUT_H / srcH)
    _dw = Math.round(srcW * scale)
    _dh = Math.round(srcH * scale)
    _dx = Math.round((OUTPUT_W - _dw) / 2)
    _dy = Math.round((OUTPUT_H - _dh) / 2)
    _fullCoverage = (_dx === 0 && _dy === 0 && _dw === OUTPUT_W && _dh === OUTPUT_H)
    console.log(`[DESKTOP] geometry: src=${srcW}x${srcH} → dest=${_dw}x${_dh} @(${_dx},${_dy}) full=${_fullCoverage}`)
  }

  // ── Frame delivery (IPC fallback — worker sends frames via WS directly) ──
  function onPixelsReady(buf) {
    if (!buf || buf.byteLength === 0) { _pipeDrops++; return }
    if (_pipeInflight >= IPC_MAX_IN_FLIGHT) { _pipeDrops++; return }
    _pipeInflight++
    const pixels = new Uint8Array(buf)
    let writePromise
    if (useRawIPC && shmMode === 'named') {
      writePromise = writeFrameRaw(pixels)
        .catch(e => {
          const msg = String(e)
          if (msg.includes('busy')) { _pipeDrops++; return }
          console.warn('[DESKTOP] raw IPC failed, falling back to base64:', e)
          useRawIPC = false
          return writeNamedSharedMemory(pixels, OUTPUT_W, OUTPUT_H)
        })
    } else if (shmMode === 'named') {
      writePromise = writeNamedSharedMemory(pixels, OUTPUT_W, OUTPUT_H)
    } else {
      writePromise = writeSharedMemory(shmPath, 0, pixels)
    }
    writePromise
      .then(() => { _pipeFrames++ })
      .catch(e => console.error('pipe write failed', e))
      .finally(() => { _pipeInflight-- })
  }

  // Worker crash recovery: if a worker dies, restart it and reconnect WS.
  let _workerRestarts = 0
  const MAX_WORKER_RESTARTS = 5

  function makeWorkerMessageHandler(isWorkerA) {
    return (e) => {
      const d = e.data
      if (d instanceof ArrayBuffer) {
        if (isWorkerA) _workerABusy = false; else _workerBBusy = false
        onPixelsReady(d)
        return
      }
      if (d && d.type === 'ok') {
        if (isWorkerA) _workerABusy = false; else _workerBBusy = false
        _pipeFrames++
        _lastWsBuf = d.buf || 0
        if (d.tier === 'A') _pipeTierA++; else _pipeTierB++
        return
      }
      if (d && d.type === 'drop') {
        if (isWorkerA) _workerABusy = false; else _workerBBusy = false
        _pipeDrops++
        return
      }
      if (d && d.type === 'ws-status') {
        // Only track connection status from worker A (both connect to same port)
        if (isWorkerA) {
          _wsConnected = d.connected
          console.log(`[DESKTOP] frame socket ${d.connected ? 'connected' : 'disconnected'}`)
        }
        return
      }
    }
  }

  function createFrameWorker(isWorkerA) {
    if (!_hasOffscreen || typeof Worker === 'undefined') return null
    const label = isWorkerA ? 'A' : 'B'
    try {
      const worker = new Worker('./frame-worker.js')
      if (_wsPort) worker.postMessage({ type: 'init', wsPort: _wsPort, wsToken: _wsToken })
      worker.onmessage = makeWorkerMessageHandler(isWorkerA)
      worker.onerror = (err) => {
        console.warn(`[DESKTOP] frame worker ${label} error:`, err)
        _workerRestarts++
        try { worker.terminate() } catch (_) {}
        if (_workerRestarts <= MAX_WORKER_RESTARTS) {
          console.log(`[DESKTOP] restarting frame worker ${label} (attempt ${_workerRestarts}/${MAX_WORKER_RESTARTS})`)
          if (isWorkerA) { _workerABusy = false; _workerA = createFrameWorker(true) }
          else            { _workerBBusy = false; _workerB = createFrameWorker(false) }
        } else {
          console.error(`[DESKTOP] frame workers failed ${MAX_WORKER_RESTARTS} times, falling back to main thread`)
          _workerA = null; _workerB = null
        }
      }
      console.log(`[DESKTOP] frame worker ${label} created`)
      return worker
    } catch (e) {
      console.warn(`[DESKTOP] Worker ${label} creation failed:`, e)
      return null
    }
  }

  _workerA = createFrameWorker(true)
  _workerB = createFrameWorker(false)

  // Fallback: main-thread canvas (used when Worker/OffscreenCanvas unavailable)
  let _fallbackCanvas = null, _fallbackCtx = null
  function ensureFallbackCanvas() {
    if (!_fallbackCanvas) {
      _fallbackCanvas = document.createElement('canvas')
      _fallbackCanvas.width = OUTPUT_W
      _fallbackCanvas.height = OUTPUT_H
      _fallbackCtx = _fallbackCanvas.getContext('2d', {
        willReadFrequently: true,
        alpha: false
      })
      _fallbackCtx.imageSmoothingQuality = 'low'
    }
    return _fallbackCtx
  }

  // ── Capture and dispatch ──────────────────────────────────────────
  // Double-buffered worker dispatch:
  //   Round-robin between worker A and B.  If the chosen worker is busy,
  //   try the other one.  If both are busy, drop the frame.
  //
  // This allows two frames to be in-flight simultaneously:
  //   t=0ms:  worker A receives frame N   → starts getImageData
  //   t=5ms:  worker B receives frame N+1 → starts getImageData
  //   t=10ms: worker A finishes           → sends frame N
  //   t=12ms: worker B finishes           → sends frame N+1
  //   → effectively doubles throughput over single-worker approach
  let _useWorkerA = true  // which worker gets the next frame

  function dispatchToWorker(worker, msgPayload, transferables) {
    worker.postMessage(msgPayload, transferables)
  }

  function captureAndSend() {
    updateGeometry()

    const hasWorkers = _workerA || _workerB
    if (hasWorkers) {
      // Pick next available worker (round-robin with fallback)
      let worker = null
      if (_useWorkerA) {
        if (_workerA && !_workerABusy)      { worker = _workerA; _workerABusy = true; _useWorkerA = false }
        else if (_workerB && !_workerBBusy) { worker = _workerB; _workerBBusy = true }
      } else {
        if (_workerB && !_workerBBusy)      { worker = _workerB; _workerBBusy = true; _useWorkerA = true }
        else if (_workerA && !_workerABusy) { worker = _workerA; _workerABusy = true }
      }

      if (!worker) {
        // Both workers busy — drop frame to avoid queue buildup
        _pipeDrops++
        return
      }

      const payload = { dx: _dx, dy: _dy, dw: _dw, dh: _dh,
                        outW: OUTPUT_W, outH: OUTPUT_H, fullCoverage: _fullCoverage }

      // ── Tier 1: VideoFrame transfer (sync, ~0.1ms) ──
      if (_hasVideoFrame) {
        try {
          const frame = new VideoFrame(video, { timestamp: 0 })
          dispatchToWorker(worker, { ...payload, frame }, [frame])
          return
        } catch (_) {
          // VideoFrame unavailable — fall through to Tier 2
        }
      }

      // ── Tier 2: createImageBitmap (async, ~1-5ms main thread) ──
      createImageBitmap(video).then(bmp => {
        if (!_workerA && !_workerB) { bmp.close(); return }
        dispatchToWorker(worker, { ...payload, bmp }, [bmp])
      }).catch(e => {
        // Release the busy flag we set above so the worker isn't stuck
        if (worker === _workerA) _workerABusy = false
        else _workerBBusy = false
        console.warn('[DESKTOP] createImageBitmap failed:', e)
      })
    } else {
      // ── Tier 3: main-thread canvas (last resort, blocks RVFC) ──
      const ctx = ensureFallbackCanvas()
      if (!_fullCoverage) { ctx.fillStyle = '#000'; ctx.fillRect(0, 0, OUTPUT_W, OUTPUT_H) }
      ctx.drawImage(video, _dx, _dy, _dw, _dh)
      const buf = ctx.getImageData(0, 0, OUTPUT_W, OUTPUT_H).data.buffer
      onPixelsReady(buf)
    }
  }

  // ── Frame scheduling ──────────────────────────────────────────────
  // CRITICAL: register RVFC BEFORE doing work so callbacks are never starved.
  if ('requestVideoFrameCallback' in HTMLVideoElement.prototype) {
    console.log(`[DESKTOP] Using requestVideoFrameCallback (${OUTPUT_W}x${OUTPUT_H}, workers=A+B, tier=${_pipeTier})`)
    let _rvfcActive = true
    let _lastPresentedFrames = -1
    function onVideoFrame(now, metadata) {
      if (!_rvfcActive) return
      video.requestVideoFrameCallback(onVideoFrame)  // register FIRST
      // Skip if the decoder hasn't produced a new frame — avoids
      // redundant pixel extraction for the same decoded frame.
      if (metadata && metadata.presentedFrames !== undefined) {
        if (metadata.presentedFrames === _lastPresentedFrames) return
        _lastPresentedFrames = metadata.presentedFrames
      }
      captureAndSend()
    }
    video.requestVideoFrameCallback(onVideoFrame)
    pipeInterval = {
      _rvfc: true,
      _fpsTimer: _pipeFpsTimer,
      cancel() {
        _rvfcActive = false
        clearInterval(_pipeFpsTimer)
        if (_workerA) { _workerA.terminate(); _workerA = null }
        if (_workerB) { _workerB.terminate(); _workerB = null }
      }
    }
  } else {
    console.log('[DESKTOP] Using setInterval fallback for frame pipe (16ms)')
    pipeInterval = setInterval(() => captureAndSend(), 16)
    pipeInterval._fpsTimer = _pipeFpsTimer
  }
}
if (copyPathBtn) {
  copyPathBtn.addEventListener('click', () => {
    if (shmPath) {
      navigator.clipboard.writeText(shmPath).then(() => {
        copyPathBtn.textContent = 'Copied'
        setTimeout(() => { copyPathBtn.textContent = 'Copy' }, 1500)
      }).catch(() => {
        alert('Failed to copy path to clipboard')
      })
    }
  })
}

function stopFramePipe({ keepVirtualCamera = false } = {}) {
  if (pipeInterval) {
    if (pipeInterval._rvfc) {
      pipeInterval.cancel()
    } else {
      clearInterval(pipeInterval)
    }
    if (pipeInterval._fpsTimer) clearInterval(pipeInterval._fpsTimer)
    pipeInterval = null
  }
  pipeWriting = false
  if (!keepVirtualCamera) {
    deactivateVirtualCamera() // remove from OS virtual camera list
    virtualCameraActive = false
  }
  shmMode = 'none'
  shmPath = null
  const pathEl = document.getElementById('shmPath')
  if (pathEl) pathEl.textContent = ''
  shmInfo.hidden = true
  startPipeBtn.hidden = false
  stopPipeBtn.hidden = true
  if (pipeTierSelect) pipeTierSelect.hidden = true
  const pipeRuntime = document.getElementById('pipeRuntimeControls')
  if (pipeRuntime) pipeRuntime.hidden = true
  const pipeStatusDesc = document.getElementById('pipeStatusDesc')
  if (pipeStatusDesc) pipeStatusDesc.textContent = 'Not running'
  stopAudioPipe()
}
// ── Audio pipe (Sprint 7) — mic: AudioWorklet → localhost WS → Rust → VB-Audio ───
// Browser AudioWorklet captures PCM from the WebRTC audio track (48kHz, f32, stereo)
// and fires postMessage per 128-sample quantum (≈2.67ms).  Main thread sends the
// ArrayBuffer directly over a second localhost WebSocket to the Rust audio_socket,
// which writes to VB-Audio Cable Input via cpal/WASAPI.  Zoom/Teams/etc then use
// “CABLE Output” as their microphone source.
async function startAudioPipe(audioTrack) {
  stopAudioPipe()
  const micStatusEl = document.getElementById('micStatus')
  const _s = loadSettings()
  const sampleRate = Number(_s.audioSampleRate) || 48000

  // Wait for the audio port to be fetched (may still be in-flight at startup)
  if (!_audioPort) {
    console.log('[DESKTOP] audio pipe: waiting for audio socket port...')
    if (micStatusEl) { micStatusEl.textContent = 'Audio: waiting for socket...'; micStatusEl.hidden = false }
    const timeoutMs = 8000
    const result = await Promise.race([
      _audioPortPromise,
      new Promise(r => setTimeout(() => r(0), timeoutMs))
    ])
    if (!result && !_audioPort) {
      console.warn('[DESKTOP] audio socket port not available after timeout -- mic pipe skipped')
      if (micStatusEl) { micStatusEl.textContent = 'Audio: socket unavailable'; micStatusEl.hidden = false }
      return
    }
  }
  try {
    // Create (or reuse) an AudioContext at the configured sample rate
    if (!_audioCtx || _audioCtx.state === 'closed') {
      _audioCtx = new AudioContext({ sampleRate, latencyHint: 'interactive' })
    }
    if (_audioCtx.state === 'suspended') await _audioCtx.resume()

    // Load the AudioWorklet processor module (once per context)
    if (!_audioWorkletLoaded) {
      await _audioCtx.audioWorklet.addModule('./audio-processor.js')
      _audioWorkletLoaded = true
    }
    _audioWorkletNode = new AudioWorkletNode(_audioCtx, 'bridgecam-audio')

    // Route: WebRTC audio track -> source -> worklet (NOT to speakers)
    const srcStream = new MediaStream([audioTrack])
    const src = _audioCtx.createMediaStreamSource(srcStream)
    src.connect(_audioWorkletNode)
    // Do NOT connect to _audioCtx.destination -- audio goes to VB-Audio, not speakers

    // Connect WebSocket to Rust audio_socket (with per-session auth token)
    let audioToken = ''
    try {
      if (window.__TAURI__?.core?.invoke) {
        audioToken = await window.__TAURI__.core.invoke('get_socket_auth_token')
      }
    } catch (_) {}
    const audioQs = audioToken ? `?token=${encodeURIComponent(audioToken)}` : ''
    _audioWs = new WebSocket(`ws://127.0.0.1:${_audioPort}${audioQs}`)
    _audioWs.binaryType = 'arraybuffer'
    _audioWs.onopen  = () => {
      console.log('[DESKTOP] audio socket connected')
      if (micStatusEl) { micStatusEl.textContent = `Audio: active (${sampleRate}Hz)`; micStatusEl.hidden = false }
    }
    _audioWs.onclose = () => {
      _audioWs = null
      if (micStatusEl) { micStatusEl.textContent = 'Audio: disconnected'; micStatusEl.hidden = false }
    }
    _audioWs.onerror = (e) => {
      console.warn('[DESKTOP] audio socket error:', e)
      _audioWs = null
      if (micStatusEl) { micStatusEl.textContent = 'Audio: error'; micStatusEl.hidden = false }
    }

    // Forward PCM chunks from worklet to Rust (zero-copy ArrayBuffer transfer)
    _audioWorkletNode.port.onmessage = (e) => {
      if (_micMuted) return
      if (_audioWs && _audioWs.readyState === WebSocket.OPEN) {
        _audioWs.send(e.data)
      }
    }

    console.log(`[DESKTOP] mic pipe started -- ${sampleRate}Hz -> audio socket :${_audioPort}`)
    if (micStatusEl) { micStatusEl.textContent = `Audio: active (${sampleRate}Hz)`; micStatusEl.hidden = false }
  } catch (e) {
    console.warn('[DESKTOP] mic pipe start failed:', e)
    if (micStatusEl) { micStatusEl.textContent = `Audio: failed (${e.message})`; micStatusEl.hidden = false }
  }
}

function stopAudioPipe() {
  if (_audioWorkletNode) { _audioWorkletNode.disconnect(); _audioWorkletNode = null }
  if (_audioCtx)  { _audioWorkletLoaded = false; _audioCtx.close().catch(() => {}); _audioCtx = null }
  if (_audioWs)   { _audioWs.close(); _audioWs = null }
  const micStatusEl = document.getElementById('micStatus')
  if (micStatusEl) { micStatusEl.textContent = ''; micStatusEl.hidden = true }
}

// ── QR Code (inline using qrcode-generator) ──────────────────────────

// Add frame pipe button handlers
startPipeBtn.addEventListener('click', () => startFramePipe())
stopPipeBtn.addEventListener('click', () => stopFramePipe())

async function renderQR(text) {
  if (!window._qrLoaded) {
    await new Promise((resolve, reject) => {
      const s = document.createElement('script')
      // load the bundled copy from our assets folder to avoid privacy warnings
      s.src = './assets/qrcode.min.js'
      s.onload = resolve
      s.onerror = reject
      document.head.appendChild(s)
    })
    window._qrLoaded = true
  }

  const qr = qrcode(0, 'M')
  qr.addData(text)
  qr.make()
  const cellSize = 6
  const margin = 8
  const count = qr.getModuleCount()
  const size = count * cellSize + margin * 2
  qrCanvas.width = size
  qrCanvas.height = size
  const ctx = qrCanvas.getContext('2d')
  ctx.fillStyle = '#111'
  ctx.fillRect(0, 0, size, size)
  for (let row = 0; row < count; row++) {
    for (let col = 0; col < count; col++) {
      ctx.fillStyle = qr.isDark(row, col) ? '#00ffcc' : '#111'
      ctx.fillRect(col * cellSize + margin, row * cellSize + margin, cellSize, cellSize)
    }
  }
}

// ── Signaling ────────────────────────────────────────────────────────

function getWsUrl() {
  let url = serverUrlInput.value.trim()
  if (!url) url = 'ws://localhost:3000/ws'
  url = url.replace(/^http/, 'ws')
  if (!url.endsWith('/ws')) url = url.replace(/\/?$/, '/ws')
  return url
}

function getHttpUrl() {
  let url = serverUrlInput.value.trim() || 'http://localhost:3000'
  url = url.replace(/^ws/, 'http')
  url = url.replace(/\/ws\/?$/, '')
  return url
}

function connectSignaling(onMessage) {
  const url = getWsUrl()
  console.log(`[DESKTOP] Connecting to signaling: ${url}`)
  const socket = new WebSocket(url)
  socket.addEventListener('open', () => console.log('[DESKTOP] signaling: open'))
  socket.addEventListener('message', (ev) => {
    if (ws !== socket) return
    try { const msg = JSON.parse(ev.data); onMessage(msg) } catch (e) { console.warn('invalid message', e) }
  })
  socket.addEventListener('close', () => console.log('[DESKTOP] signaling: closed'))
  socket.addEventListener('error', (e) => console.error('[DESKTOP] signaling error', e))
  return socket
}

function sendSignal(payload) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ action: 'signal', payload }))
  }
}

function joinRoom(roomId) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ action: 'join', roomId }))
  }
}

// ── WebRTC ───────────────────────────────────────────────────────────

function createPC() {
  const conn = new RTCPeerConnection({ iceServers: [...STUN_SERVERS, ...turnServers] })

  conn.addEventListener('track', (ev) => {
    if (pc !== conn) return
    // Audio track — pipe to VB-Audio Cable Input via AudioWorklet + WebSocket
    if (ev.track.kind === 'audio') {
      console.log('[DESKTOP] [OK] received track audio — starting mic pipe')
      startAudioPipe(ev.track)
      return
    }

    console.log('[DESKTOP] [OK] received track', ev.track.kind)
    const stream = (ev.streams && ev.streams[0]) ? ev.streams[0] : new MediaStream([ev.track])
    video.srcObject = stream

    try { video.latencyHint = 'interactive' } catch(_) {}
    try { video.disableRemotePlayback = true } catch(_) {}
    video.playsInline = true
    video.muted = true

    const waitOverlay = document.getElementById('videoWaitingOverlay')
    const waitText = document.getElementById('videoWaitingText')
    if (waitOverlay) {
      if (waitText) waitText.textContent = 'Connecting video stream…'
      waitOverlay.hidden = false
    }
    const hideWaitOverlay = () => {
      if (waitOverlay && video.videoWidth > 0) waitOverlay.hidden = true
    }

    const tryPlay = () => {
      video.play().then(hideWaitOverlay).catch(e => console.warn('[DESKTOP] video.play() failed:', e))
    }
    tryPlay()
    video.addEventListener('loadedmetadata', tryPlay, { once: true })
    video.addEventListener('loadeddata', hideWaitOverlay, { once: true })
    video.addEventListener('playing', hideWaitOverlay, { once: true })
    video.addEventListener('resize', hideWaitOverlay)

    setStatus('Connecting video…')
    if (viewTabs) viewTabs.hidden = false
    showView('camera')
    showRecordingControls(true)
    setQualityLevel(-1)

    // Keep low-latency jitter buffer without starving keyframes on WiFi/mobile
    try {
      const receivers = conn.getReceivers()
      for (const r of receivers) {
        if (r.track && r.track.kind === 'video') {
          if ('jitterBufferTarget' in r) r.jitterBufferTarget = 30
          if ('playoutDelayHint' in r)   r.playoutDelayHint = 0.03
        }
      }
    } catch (e) { console.warn('[DESKTOP] receiver tuning failed:', e) }

    startFramePipe()
  })

  conn.addEventListener('icecandidate', (ev) => {
    if (pc === conn && ev.candidate) {
      sendSignal({ type: 'ice', candidate: ev.candidate })
    }
  })

  conn.addEventListener('connectionstatechange', () => {
    if (pc !== conn) return
    console.log('[DESKTOP] connection state:', conn.connectionState)
    if (conn.connectionState === 'connected') {
      cancelReconnect()
      setStatus('Connected')
      _cameraCapabilities = null
      _cameraCapsRetryCount = 0
      if (_cameraCapsRetryTimer) { clearTimeout(_cameraCapsRetryTimer); _cameraCapsRetryTimer = null }
      // Sprint 9: Request camera capabilities once connection is stable
      setTimeout(() => requestCameraCapabilities(), 800)

      // Auto-enable motion detection if setting is on
      const _s = loadSettings()
      if (_s.motionAutoEnable && !_motionEnabled) {
        setTimeout(() => {
          enableMotionDetection(_s.motionSensitivity || 20)
        }, 1200)
      }

      // Sprint 11.1: Verify DTLS-SRTP encryption is active on all transceivers.
      // WebRTC mandates DTLS-SRTP by spec — this audit confirms it's actually running.
      setTimeout(() => verifyDtlsEncryption(conn), 1500)
    } else if (conn.connectionState === 'disconnected' || conn.connectionState === 'failed') {
      setStatus(`[!] ${conn.connectionState}`)
      setCameraPausedOverlay(false)
      setQualityLevel(0)
      // Reset camera controls when connection drops
      if (cameraControlsGrid) cameraControlsGrid.innerHTML = '<p id="cameraControlsEmpty" class="muted small sidebar-empty">Waiting for phone…</p>'
    }
  })

  conn.addEventListener('iceconnectionstatechange', () => {
    console.log('[DESKTOP] ICE state:', conn.iceConnectionState)
    const waitOverlay = document.getElementById('videoWaitingOverlay')
    const waitText = document.getElementById('videoWaitingText')
    if (waitOverlay && !waitOverlay.hidden && waitText) {
      if (conn.iceConnectionState === 'failed') {
        waitText.textContent = 'Video connection blocked (ICE failed). Ensure phone and PC are on the same WiFi network.'
      } else if (conn.iceConnectionState === 'checking') {
        waitText.textContent = 'Negotiating video connection (ICE checking)…'
      } else if (conn.iceConnectionState === 'connected' || conn.iceConnectionState === 'completed') {
        waitText.textContent = 'Connected — waiting for first video frame…'
      }
    }
  })

  conn._drainPending = async () => {
    while (pendingIce.length) {
      const c = pendingIce.shift()
      try { await conn.addIceCandidate(c) } catch (e) { console.warn('addIceCandidate failed', e) }
    }
  }

  return conn
}

// ── Sprint 11.1: DTLS-SRTP encryption audit ──────────────────────────
// WebRTC mandates DTLS-SRTP for all media streams (RFC 5764).
// This function verifies the transport is actually connected with DTLS
// and logs the negotiated cipher suite.  If something is wrong (e.g. a
// misconfigured proxy stripping TLS), it shows a warning in the UI.
async function verifyDtlsEncryption(conn) {
  try {
    const stats = await conn.getStats()
    const dtlsReports = []
    stats.forEach(r => {
      if (r.type === 'transport') {
        dtlsReports.push(r)
      }
    })

    if (dtlsReports.length === 0) {
      console.warn('[DESKTOP] [DTLS] audit: no transport stats available yet')
      return
    }

    let allEncrypted = true
    for (const t of dtlsReports) {
      const state = t.dtlsState || 'unknown'
      const cipher = t.selectedCandidatePairId ? (t.tlsVersion || '') : ''
      const role = t.dtlsRole || 'unknown'
      console.log(`[DESKTOP] [DTLS] transport: state=${state} role=${role} cipher=${t.srtpCipher || 'n/a'} version=${t.tlsVersion || 'n/a'}`)
      if (state !== 'connected') {
        allEncrypted = false
        console.warn(`[DESKTOP] [!] DTLS transport not connected — state: ${state}`)
      }
    }

    // Also check transceivers via RTCDtlsTransport if available
    if (conn.getTransceivers) {
      for (const transceiver of conn.getTransceivers()) {
        const sender = transceiver.sender
        const transport = sender?.transport
        if (transport) {
          const dtlsState = transport.state
          const iceState = transport.iceTransport?.state
          console.log(`[DESKTOP] [DTLS] transport (${transceiver.mid}): dtls=${dtlsState} ice=${iceState}`)
          if (dtlsState !== 'connected') allEncrypted = false
        }
      }
    }

    if (allEncrypted) {
      console.log('[DESKTOP] [OK] DTLS-SRTP encryption verified — all streams encrypted')
    } else {
      console.error('[DESKTOP] [FAIL] DTLS-SRTP NOT verified — stream may be unencrypted!')
      // Show a visible warning — security regression should not go unnoticed
      showError('[!] Encryption warning: DTLS transport not fully connected. Stream security may be degraded.')
    }
  } catch (e) {
    console.warn('[DESKTOP] [DTLS] audit failed (non-fatal):', e)
  }
}

// ── Stats ────────────────────────────────────────────────────────────

function startReceiverStats() {
  if (!pc || statsInterval) return
  lastInboundStats = null
  // Sprint 10.4/10.5: graceful degradation counters
  let _lowFpsStreak = 0        // consecutive intervals with fps < 15
  let _poorQualityStreak = 0   // consecutive intervals with loss > 5%
  statsInterval = setInterval(async () => {
    try {
      const s = await pc.getStats()
      s.forEach(r => {
        if (r.type === 'inbound-rtp' && (r.kind === 'video' || r.mediaType === 'video')) {
          const frames = r.framesDecoded || 0
          const dropped = r.framesDropped || 0
          const packetsLost = r.packetsLost || 0
          const packetsReceived = r.packetsReceived || 0
          if (lastInboundStats && lastInboundStats.frames != null) {
            const dt = (r.timestamp - lastInboundStats.ts) / 1000
            const fps = dt > 0 ? Math.round((frames - lastInboundStats.frames) / dt) : 0
            const droppedDelta = dropped - (lastInboundStats.dropped || 0)
            if (statsEl) {
              statsEl.textContent = `fps: ${fps} | dropped: ${droppedDelta}`
            }
            const lossRatio = (packetsReceived + packetsLost) > 0 ? (packetsLost / (packetsReceived + packetsLost)) : 0
            sendSignal({ type: 'quality-feedback', fps, dropped: droppedDelta, loss: lossRatio })

            // ── Sprint 10.5: Update signal-bar quality indicator ──────────────────
            let quality
            if (!pc || pc.connectionState !== 'connected') {
              quality = 0
            } else if (fps >= 25 && lossRatio < 0.01 && droppedDelta <= 1) {
              quality = 4  // excellent
            } else if (fps >= 20 && lossRatio < 0.03 && droppedDelta <= 3) {
              quality = 3  // good
            } else if (fps >= 12 && lossRatio < 0.08) {
              quality = 2  // fair
            } else if (fps > 0) {
              quality = 1  // poor
            } else {
              quality = 0  // no signal
            }
            setQualityLevel(quality)

            // ── Sprint 10.4: Graceful degradation — request lower quality from sender ─
            // If fps stays very low for 3 consecutive intervals, nudge the
            // sender to reduce its target bitrate / fps via quality-feedback.
            // The sender's probeAdjustMaxBitrate already handles this, but we make it
            // explicit so the desktop can also show a degradation warning.
            if (fps < 15 && lossRatio > 0.03) {
              _lowFpsStreak++
              if (_lowFpsStreak >= 3) {
                console.warn(`[DESKTOP] [!] Sustained poor quality: ${fps}fps loss=${(lossRatio*100).toFixed(1)}% — requesting aggressive degradation`)
                // Send an explicit quality-feedback with high loss to force sender reduction
                sendSignal({ type: 'quality-feedback', fps, dropped: droppedDelta + 10, loss: 0.1 })
                _lowFpsStreak = 0
              }
            } else {
              _lowFpsStreak = 0
            }

            if (lossRatio > 0.05) {
              _poorQualityStreak++
              if (_poorQualityStreak >= 5) {
                console.warn(`[DESKTOP] [!] Sustained packet loss ${(lossRatio*100).toFixed(1)}% — requesting bitrate reduction`)
                sendSignal({ type: 'quality-feedback', fps, dropped: droppedDelta, loss: 0.08 })
                _poorQualityStreak = 0
              }
            } else {
              _poorQualityStreak = 0
            }
          }
          lastInboundStats = { frames, dropped, ts: r.timestamp }
        }
      })
    } catch (e) { /* ignore */ }
  }, 2000)
}

function stopReceiverStats() {
  if (statsInterval) { clearInterval(statsInterval); statsInterval = null }
  setQualityLevel(-1)
}

// ════════════════════════════════════════════════════════════════════
// POST-RELEASE SECRET WEAPONS
// ════════════════════════════════════════════════════════════════════

// ── Shared save helper ───────────────────────────────────────────────
// If the user configured a save directory in Settings, write the blob to
// disk via Tauri raw binary IPC.  Otherwise fall back to browser download.
async function saveBlob(blob, filename) {
  const s = loadSettings()
  const dir = s.recordingSaveDir
  if (dir && window.__TAURI__?.core?.invoke) {
    try {
      const sep = dir.includes('/') ? '/' : '\\'
      const fullPath = `${dir}${sep}${filename}`
      const buf = await blob.arrayBuffer()
      const bytes = new Uint8Array(buf)
      // Use raw binary IPC — sends Uint8Array directly to Rust without
      // base64 encoding.  The file path is passed via a request header.
      await window.__TAURI__.core.invoke('save_file_raw', bytes, {
        headers: { 'x-file-path': fullPath }
      })
      console.log(`[DESKTOP] Saved to disk: ${fullPath} (${(blob.size/1024/1024).toFixed(1)} MB)`)
      return fullPath
    } catch (e) {
      console.warn('[DESKTOP] Disk save failed, falling back to download:', e)
    }
  }
  // Fallback: browser download
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  a.click()
  setTimeout(() => URL.revokeObjectURL(url), 10_000)
  return null
}

// Helper: pick the best codec mimeType based on user preference
function _pickRecordingMimeType() {
  const s = loadSettings()
  const pref = s.recordingCodec || 'vp9'
  if (pref === 'vp9') {
    const t = 'video/webm;codecs=vp9,opus'
    if (MediaRecorder.isTypeSupported(t)) return t
  }
  if (pref === 'vp8' || pref === 'vp9') {
    const t = 'video/webm;codecs=vp8,opus'
    if (MediaRecorder.isTypeSupported(t)) return t
  }
  // auto / fallback
  const types = ['video/webm;codecs=vp9,opus', 'video/webm;codecs=vp8,opus', 'video/webm']
  return types.find(t => MediaRecorder.isTypeSupported(t)) || ''
}

// ── P.6: Screenshot capture ──────────────────────────────────────────
const screenshotBtn = document.getElementById('screenshotBtn')

function takeScreenshot() {
  if (!video.srcObject || video.videoWidth === 0) return
  const c = document.createElement('canvas')
  c.width = video.videoWidth
  c.height = video.videoHeight
  const ctx = c.getContext('2d')
  ctx.drawImage(video, 0, 0)
  c.toBlob(async blob => {
    if (!blob) return
    const filename = `bridgecam-${new Date().toISOString().replace(/[:.]/g, '-')}.png`
    await saveBlob(blob, filename)
    console.log('[DESKTOP] Screenshot saved')
  }, 'image/png')
}

if (screenshotBtn) screenshotBtn.addEventListener('click', takeScreenshot)

// ── P.4: Recording to local disk ─────────────────────────────────────
// Uses the MediaRecorder API on the live <video> srcObject.
// Records to VP8/WebM, collects chunks, then triggers a file download on stop.
const recordBtn    = document.getElementById('recordBtn')
const stopRecordBtn = document.getElementById('stopRecordBtn')
const recIndicator = document.getElementById('recIndicator')

let _mediaRecorder = null
let _recChunks = []
let _recStartedAt = 0

function startRecording({ label = 'bridgecam', mimeType = '' } = {}) {
  if (!video.srcObject) { console.warn('[DESKTOP] [REC] No stream to record'); return }
  if (_mediaRecorder && _mediaRecorder.state !== 'inactive') return

  const chosenType = mimeType || _pickRecordingMimeType()

  try {
    _mediaRecorder = new MediaRecorder(video.srcObject, chosenType ? { mimeType: chosenType } : {})
  } catch (e) {
    console.error('[DESKTOP] [REC] MediaRecorder creation failed:', e)
    return
  }

  _recChunks = []
  _recStartedAt = Date.now()

  _mediaRecorder.ondataavailable = (ev) => {
    if (ev.data && ev.data.size > 0) _recChunks.push(ev.data)
  }

  _mediaRecorder.onstop = async () => {
    const blob = new Blob(_recChunks, { type: chosenType || 'video/webm' })
    const filename = `${label}-${new Date().toISOString().replace(/[:.]/g, '-')}.webm`
    await saveBlob(blob, filename)
    _recChunks = []
    console.log(`[DESKTOP] [REC] Recording saved (${(blob.size / 1024 / 1024).toFixed(1)} MB)`)
  }

  _mediaRecorder.start(1000)  // collect chunks every 1s for smooth download
  _recStartedAt = Date.now()

  if (recIndicator) recIndicator.hidden = false
  if (recordBtn) recordBtn.hidden = true
  if (stopRecordBtn) stopRecordBtn.hidden = false
  console.log(`[DESKTOP] [REC] Recording started (${chosenType || 'browser default'})`)
}

function stopRecording() {
  if (!_mediaRecorder || _mediaRecorder.state === 'inactive') return
  _mediaRecorder.stop()
  if (recIndicator) recIndicator.hidden = true
  if (recordBtn) recordBtn.hidden = false
  if (stopRecordBtn) stopRecordBtn.hidden = true
}

if (recordBtn)     recordBtn.addEventListener('click', () => startRecording())
if (stopRecordBtn) stopRecordBtn.addEventListener('click', stopRecording)

// ── P.5: Time-lapse mode ─────────────────────────────────────────────
// Captures one full-resolution PNG frame every N seconds.
// On stop, compiles all frames into a WebM at a fast playback rate and downloads it.
const timelapseTriggerBtn = document.getElementById('timelapseTriggerBtn')
const timelapseModal    = document.getElementById('timelapseModal')
const timelapseCancel   = document.getElementById('timelapseCancel')
const timelapseStart    = document.getElementById('timelapseStart')
const timelapseInterval = document.getElementById('timelapseInterval')

let _tlFrames = []           // Array of ImageData blobs
let _tlTimer = null
let _tlIntervalSecs = 5
let _tlCanvas = null, _tlCtx = null

function _ensureTlCanvas() {
  if (!_tlCanvas) {
    _tlCanvas = document.createElement('canvas')
    _tlCtx = _tlCanvas.getContext('2d', { willReadFrequently: true, alpha: false })
  }
  _tlCanvas.width = video.videoWidth || 1280
  _tlCanvas.height = video.videoHeight || 720
  return _tlCtx
}

function captureTimelapseFrame() {
  if (!video.srcObject || video.videoWidth === 0) return
  const ctx = _ensureTlCanvas()
  ctx.drawImage(video, 0, 0)
  // Store as Blob to avoid holding 8MB ArrayBuffers in memory for long sessions
  _tlCanvas.toBlob(blob => { if (blob) _tlFrames.push(blob) }, 'image/webp', 0.92)
  console.log(`[DESKTOP] [TL] Time-lapse frame ${_tlFrames.length} captured`)
}

async function compileTimelapse() {
  if (_tlFrames.length === 0) { console.warn('[DESKTOP] [TL] No frames to compile'); return }

  const w = _tlCanvas?.width || 1280
  const h = _tlCanvas?.height || 720
  const stream = _tlCanvas.captureStream(30)
  const chunks = []
  const types = ['video/webm;codecs=vp9', 'video/webm;codecs=vp8', 'video/webm']
  const mimeType = types.find(t => MediaRecorder.isTypeSupported(t)) || 'video/webm'
  const mr = new MediaRecorder(stream, { mimeType, videoBitsPerSecond: 6_000_000 })
  mr.ondataavailable = (e) => { if (e.data.size > 0) chunks.push(e.data) }

  await new Promise((resolve) => {
    mr.onstop = resolve
    mr.start()

    let i = 0
    const ctx = _tlCtx || _ensureTlCanvas()
    function paintNext() {
      if (i >= _tlFrames.length) {
        setTimeout(() => mr.stop(), 100)
        return
      }
      const url = URL.createObjectURL(_tlFrames[i++])
      const img = new Image()
      img.onload = () => {
        ctx.drawImage(img, 0, 0, w, h)
        URL.revokeObjectURL(url)
        setTimeout(paintNext, 33)  // ~30fps playback regardless of capture interval
      }
      img.src = url
    }
    paintNext()
  })

  const blob = new Blob(chunks, { type: mimeType })
  const filename = `timelapse-${new Date().toISOString().replace(/[:.]/g, '-')}.webm`
  await saveBlob(blob, filename)
  console.log(`[DESKTOP] [TL] Time-lapse compiled: ${_tlFrames.length} frames → ${(blob.size/1024/1024).toFixed(1)} MB`)
  _tlFrames = []
}

function startTimelapse(intervalSecs) {
  _tlFrames = []
  _tlIntervalSecs = intervalSecs
  _tlTimer = setInterval(captureTimelapseFrame, intervalSecs * 1000)
  if (recIndicator) { recIndicator.hidden = false; recIndicator.title = `Time-lapse (${intervalSecs}s interval)` }
  if (timelapseTriggerBtn) { timelapseTriggerBtn.textContent = '■ Stop Lapse'; timelapseTriggerBtn.title = 'Stop time-lapse and download' }
  console.log(`[DESKTOP] [TL] Time-lapse started (1 frame every ${intervalSecs}s)`)
}

async function stopTimelapse() {
  if (_tlTimer) { clearInterval(_tlTimer); _tlTimer = null }
  if (recIndicator) recIndicator.hidden = true
  if (timelapseTriggerBtn) { timelapseTriggerBtn.textContent = '◷'; timelapseTriggerBtn.title = 'Time-lapse capture' }
  if (_tlFrames.length > 0) await compileTimelapse()
}

if (timelapseTriggerBtn) {
  timelapseTriggerBtn.addEventListener('click', () => {
    if (_tlTimer) {
      stopTimelapse()
    } else {
      if (timelapseModal) timelapseModal.hidden = false
    }
  })
}
if (timelapseCancel) timelapseCancel.addEventListener('click', () => { if (timelapseModal) timelapseModal.hidden = true })
if (timelapseStart) {
  timelapseStart.addEventListener('click', () => {
    const secs = Math.max(1, parseInt(timelapseInterval?.value || '5', 10))
    if (timelapseModal) timelapseModal.hidden = true
    startTimelapse(secs)
  })
}

// ── P.2 + P.7: Motion Detection + Motion-triggered recording ────────
// Compares consecutive video frames by computing the mean absolute pixel
// difference (MAD) in luma across a downsampled grid.  When MAD exceeds
// the sensitivity threshold the recorder fires automatically.
//
// Design:
//  • Zero external deps — pure canvas pixel math
//  • Recording starts on first motion frame
//  • Recording continues while motion is detected
//  • Recording stops 5 seconds after the last detected movement
//  • Motion indicator badge on the video overlay

const MOTION_SILENCE_SECS = 5   // hardcoded: stop 5s after last motion

const motionToggleBtn  = document.getElementById('motionToggleBtn')
const motionModal      = document.getElementById('motionModal')
const motionCancel     = document.getElementById('motionCancel')
const motionConfirm    = document.getElementById('motionConfirm')
const motionSensEl    = document.getElementById('motionSensitivity')

// Motion detection state
let _motionEnabled = false
let _motionSensitivity = 20     // 1–100 scale; higher = more sensitive (smaller threshold)
let _motionCanvas = null, _motionCtx = null
let _motionPrevPixels = null    // previous frame sample pixels
let _motionTimer = null         // setInterval for frame sampling
let _motionRecording = false    // currently recording due to motion?
let _motionLastMotionAt = 0     // timestamp of last motion event
let _motionSilenceTimer = null  // timer to stop recording after silence
let _motionIndicator = null     // DOM badge

// Sensitivity threshold: convert 1-100 scale to a mean luma difference (0-255).
// Low sensitivity (1) = only detect large movements (threshold ~80).
// High sensitivity (100) = detect subtle motion (threshold ~2).
function _motionThreshold() {
  // Exponential mapping so small sensitivity values are still reasonable
  return Math.round(82 * Math.pow(0.96, _motionSensitivity - 1)) + 2
}

function _ensureMotionCanvas() {
  if (!_motionCanvas) {
    _motionCanvas = document.createElement('canvas')
    // Downsample to 160×90 — enough for motion detection, 56× less work than 1080p
    _motionCanvas.width = 160
    _motionCanvas.height = 90
    _motionCtx = _motionCanvas.getContext('2d', { willReadFrequently: true, alpha: false })
    _motionCtx.imageSmoothingEnabled = false
  }
}

function _showMotionIndicator(active) {
  if (!_motionIndicator) {
    _motionIndicator = document.createElement('div')
    _motionIndicator.id = 'motionIndicator'
    _motionIndicator.className = 'motion-indicator'
    const wrap = document.querySelector('.video-wrap')
    if (wrap) wrap.appendChild(_motionIndicator)
  }
  _motionIndicator.textContent = active ? '\u25cf Motion' : '\u25c9 Watching'
  _motionIndicator.className = `motion-indicator ${active ? 'active' : ''}`
  _motionIndicator.hidden = false
}

function _hideMotionIndicator() {
  if (_motionIndicator) _motionIndicator.hidden = true
}

// Start a single fresh MediaRecorder — no preroll mixing, clean WebM output
function _startMotionRecording() {
  if (_motionRecording) return
  _motionRecording = true
  if (recIndicator) recIndicator.hidden = false

  const mimeType = _pickRecordingMimeType()
  try {
    _mediaRecorder = new MediaRecorder(video.srcObject, { mimeType, videoBitsPerSecond: 4_000_000 })
  } catch (e) {
    console.warn('[DESKTOP] [MOT] Motion recorder failed:', e)
    _motionRecording = false
    return
  }
  _recChunks = []

  _mediaRecorder.ondataavailable = (ev) => {
    if (ev.data && ev.data.size > 0) _recChunks.push(ev.data)
  }
  _mediaRecorder.onstop = async () => {
    const blob = new Blob(_recChunks, { type: mimeType })
    const filename = `motion-${new Date().toISOString().replace(/[:.]/g, '-')}.webm`
    await saveBlob(blob, filename)
    _recChunks = []
    console.log(`[DESKTOP] [MOT] Motion clip saved (${(blob.size/1024/1024).toFixed(1)} MB)`)
  }
  _mediaRecorder.start(1000)
  console.log('[DESKTOP] [MOT] Motion-triggered recording started')
}

function _stopMotionRecording() {
  if (!_motionRecording) return
  _motionRecording = false
  if (_mediaRecorder && _mediaRecorder.state !== 'inactive') _mediaRecorder.stop()
  if (recIndicator) recIndicator.hidden = true
  console.log('[DESKTOP] [MOT] Motion recording stopped')
}

function _checkMotion() {
  if (!video.srcObject || video.videoWidth === 0) return
  _ensureMotionCanvas()
  _motionCtx.drawImage(video, 0, 0, 160, 90)
  const pixels = _motionCtx.getImageData(0, 0, 160, 90).data

  if (_motionPrevPixels) {
    // Compute mean absolute luma difference (Y = 0.299R + 0.587G + 0.114B)
    const len = pixels.length
    let sumDiff = 0
    for (let i = 0; i < len; i += 4) {
      const lumaNew = (pixels[i] * 299 + pixels[i+1] * 587 + pixels[i+2] * 114) / 1000
      const lumaOld = (_motionPrevPixels[i] * 299 + _motionPrevPixels[i+1] * 587 + _motionPrevPixels[i+2] * 114) / 1000
      sumDiff += Math.abs(lumaNew - lumaOld)
    }
    const mad = sumDiff / (len / 4)
    const threshold = _motionThreshold()

    if (mad > threshold) {
      _motionLastMotionAt = Date.now()
      _showMotionIndicator(true)

      if (!_motionRecording) {
        console.log(`[DESKTOP] [MOT] Motion detected (MAD=${mad.toFixed(1)} > ${threshold})`)
        _startMotionRecording()
      }

      // Reset / extend the 5-second silence timer
      if (_motionSilenceTimer) { clearTimeout(_motionSilenceTimer); _motionSilenceTimer = null }
      _motionSilenceTimer = setTimeout(() => {
        _showMotionIndicator(false)
        _stopMotionRecording()
        _motionSilenceTimer = null
      }, MOTION_SILENCE_SECS * 1000)
    }
  }

  // Store current frame pixels for next comparison
  _motionPrevPixels = new Uint8ClampedArray(pixels)
}

function enableMotionDetection(sensitivity) {
  if (_motionEnabled) return
  _motionEnabled = true
  _motionSensitivity = sensitivity

  // Sample frames at 5fps — sufficient for security cam motion detection
  _motionTimer = setInterval(_checkMotion, 200)
  _showMotionIndicator(false)
  if (motionToggleBtn) {
    motionToggleBtn.textContent = '\u25cf Motion ON'
    motionToggleBtn.title = 'Disable motion detection'
    motionToggleBtn.classList.add('active')
  }
  console.log(`[DESKTOP] [MOT] Motion detection enabled (sensitivity=${sensitivity}, silence=${MOTION_SILENCE_SECS}s, threshold=${_motionThreshold()})`)
}

function disableMotionDetection() {
  if (!_motionEnabled) return
  _motionEnabled = false
  if (_motionTimer) { clearInterval(_motionTimer); _motionTimer = null }
  if (_motionSilenceTimer) { clearTimeout(_motionSilenceTimer); _motionSilenceTimer = null }
  _stopMotionRecording()
  _hideMotionIndicator()
  _motionPrevPixels = null
  if (motionToggleBtn) {
    motionToggleBtn.textContent = '\u25c9 Motion'
    motionToggleBtn.title = 'Motion-triggered recording'
    motionToggleBtn.classList.remove('active')
  }
  console.log('[DESKTOP] [MOT] Motion detection disabled')
}

if (motionToggleBtn) {
  motionToggleBtn.addEventListener('click', () => {
    if (_motionEnabled) {
      disableMotionDetection()
    } else {
      if (motionModal) motionModal.hidden = false
    }
  })
}
if (motionCancel) motionCancel.addEventListener('click', () => { if (motionModal) motionModal.hidden = true })
if (motionConfirm) {
  motionConfirm.addEventListener('click', () => {
    const sens = Math.min(100, Math.max(1, parseInt(motionSensEl?.value || '20', 10)))
    if (motionModal) motionModal.hidden = true
    enableMotionDetection(sens)
  })
}

// Show/hide recording controls when streaming starts/stops
function showRecordingControls(visible) {
  const el = document.getElementById('recordingControls')
  if (el) el.hidden = !visible
}

// Cleanup all post-release state on disconnect
function stopAllPostReleaseFeatures() {
  if (_tlTimer) stopTimelapse().catch(() => {})
  if (_motionEnabled) disableMotionDetection()
  stopRecording()
  if (recIndicator) recIndicator.hidden = true
  showRecordingControls(false)
  if (timelapseTriggerBtn) { timelapseTriggerBtn.textContent = '◷'; timelapseTriggerBtn.title = 'Time-lapse capture' }
}

// ════════════════════════════════════════════════════════════════════
// END POST-RELEASE SECTION
// ════════════════════════════════════════════════════════════════════


function getReconnectDelay() {
  return Math.min(RECONNECT_BASE_DELAY * Math.pow(2, reconnectAttempts), 30000)
}

function scheduleReconnect(minimumDelay = 0) {
  if (reconnectTimer) return
  if (intentionalDisconnect || reconnectAttempts >= MAX_RECONNECT_ATTEMPTS) {
    if (reconnectAttempts >= MAX_RECONNECT_ATTEMPTS) {
      showError(`Connection lost after ${MAX_RECONNECT_ATTEMPTS} attempts. Click "Create Room" to start fresh.`)
      setStatus('Disconnected')
      showView('room')
    }
    return
  }

  const delay = Math.max(minimumDelay, getReconnectDelay())
  reconnectAttempts++
  console.log(`[DESKTOP] Scheduling reconnect ${reconnectAttempts}/${MAX_RECONNECT_ATTEMPTS} in ${delay}ms`)
  setStatus(minimumDelay ? `Server busy — retrying in ${Math.ceil(delay / 1000)} seconds` :
    `Reconnecting (${reconnectAttempts}/${MAX_RECONNECT_ATTEMPTS})…`)

  reconnectTimer = setTimeout(() => {
    reconnectTimer = null
    if (intentionalDisconnect || !currentRoomId) return
    reconnectToRoom(currentRoomId)
  }, delay)
}

function cancelReconnect() {
  if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null }
  reconnectAttempts = 0
}

async function reconnectToRoom(roomId) {
  try {
    if (pc) { try { pc.close() } catch(e){} pc = null }
    if (ws) { try { ws.close() } catch(e){} ws = null }
    pendingIce = []

    const activeWs = connectSignaling(handleSignalingMessage)
    ws = activeWs
    activeWs.addEventListener('open', () => {
      if (ws !== activeWs) return
      console.log('[DESKTOP] Reconnected to signaling')
      joinRoom(roomId)
      setStatus('Reconnected — waiting for phone…')
      if (latencyInterval) clearInterval(latencyInterval)
      latencyInterval = setInterval(() => {
        sendSignal({ type: 'latency-ping', t: Date.now() })
      }, 2000)
    })
    activeWs.addEventListener('close', () => {
      if (ws !== activeWs) return
      if (latencyInterval) { clearInterval(latencyInterval); latencyInterval = null }
      setLatency(null)
      stopReceiverStats()
      if (!intentionalDisconnect && currentRoomId) scheduleReconnect()
    })
  } catch (err) {
    console.error('[DESKTOP] Reconnect failed:', err)
    scheduleReconnect()
  }
}

// ── Sprint 9: Camera Controls ────────────────────────────────────────

// Build dynamic UI controls based on phone's reported capabilities
function populateCameraControls(capabilities) {
  if (!cameraControlsGrid) return

  const safeCapabilities = capabilities && typeof capabilities === 'object' ? capabilities : {}
  _cameraCapabilities = safeCapabilities
  cameraControlsGrid.innerHTML = ''

  // Control builders — each returns a DOM element
  const buildSlider = (name, cap, label, formatVal) => {
    const row = document.createElement('div')
    row.className = 'cam-control-row'
    row.dataset.control = name

    const lbl = document.createElement('span')
    lbl.className = 'cam-control-label'
    lbl.textContent = label

    const inputWrap = document.createElement('div')
    inputWrap.className = 'cam-control-input'

    const slider = document.createElement('input')
    slider.type = 'range'
    slider.min = cap.min
    slider.max = cap.max
    slider.step = cap.step
    slider.value = cap.current ?? cap.min
    slider.id = `camCtrl_${name}`

    const valSpan = document.createElement('span')
    valSpan.className = 'cam-control-value'
    valSpan.id = `camVal_${name}`
    valSpan.textContent = formatVal ? formatVal(slider.value) : slider.value

    // Debounced input — send on change, update display on input
    slider.addEventListener('input', () => {
      valSpan.textContent = formatVal ? formatVal(slider.value) : slider.value
    })
    slider.addEventListener('change', () => {
      sendCameraControl(name, parseFloat(slider.value))
    })

    inputWrap.appendChild(slider)
    inputWrap.appendChild(valSpan)
    row.appendChild(lbl)
    row.appendChild(inputWrap)
    return row
  }

  const buildToggle = (name, cap, label) => {
    const row = document.createElement('div')
    row.className = 'cam-control-row'
    row.dataset.control = name

    const lbl = document.createElement('span')
    lbl.className = 'cam-control-label'
    lbl.textContent = label

    const inputWrap = document.createElement('div')
    inputWrap.className = 'cam-control-input'

    const toggleWrap = document.createElement('label')
    toggleWrap.className = 'cam-toggle-switch'

    const checkbox = document.createElement('input')
    checkbox.type = 'checkbox'
    checkbox.checked = cap.current ?? false
    checkbox.id = `camCtrl_${name}`

    const track = document.createElement('span')
    track.className = 'cam-toggle-track'

    checkbox.addEventListener('change', () => {
      sendCameraControl(name, checkbox.checked)
    })

    toggleWrap.appendChild(checkbox)
    toggleWrap.appendChild(track)

    const valSpan = document.createElement('span')
    valSpan.className = 'cam-control-value'
    valSpan.id = `camVal_${name}`
    valSpan.textContent = checkbox.checked ? 'ON' : 'OFF'

    checkbox.addEventListener('change', () => {
      valSpan.textContent = checkbox.checked ? 'ON' : 'OFF'
    })

    inputWrap.appendChild(toggleWrap)
    inputWrap.appendChild(valSpan)
    row.appendChild(lbl)
    row.appendChild(inputWrap)
    return row
  }

  const buildSelect = (name, cap, label) => {
    const row = document.createElement('div')
    row.className = 'cam-control-row'
    row.dataset.control = name

    const lbl = document.createElement('span')
    lbl.className = 'cam-control-label'
    lbl.textContent = label

    const inputWrap = document.createElement('div')
    inputWrap.className = 'cam-control-input'

    const select = document.createElement('select')
    select.className = 'cam-control-select'
    select.id = `camCtrl_${name}`

    for (const mode of cap.modes) {
      const opt = document.createElement('option')
      opt.value = mode
      opt.textContent = mode
      if (mode === cap.current) opt.selected = true
      select.appendChild(opt)
    }

    select.addEventListener('change', () => {
      sendCameraControl(name, select.value)
    })

    inputWrap.appendChild(select)
    row.appendChild(lbl)
    row.appendChild(inputWrap)
    return row
  }

  // Build controls in a logical order
  const controlOrder = [
    { key: 'torch', label: 'Torch', type: 'toggle' },
    { key: 'zoom', label: 'Zoom', type: 'slider', format: v => `${parseFloat(v).toFixed(1)}×` },
    { key: 'focusMode', label: 'Focus Mode', type: 'select' },
    { key: 'focusDistance', label: 'Focus Dist.', type: 'slider', format: v => `${parseFloat(v).toFixed(2)}` },
    { key: 'exposureMode', label: 'Exp. Mode', type: 'select' },
    { key: 'exposureCompensation', label: 'Exposure', type: 'slider', format: v => `${parseFloat(v) >= 0 ? '+' : ''}${parseFloat(v).toFixed(1)}` },
    { key: 'exposureTime', label: 'Shutter', type: 'slider', format: v => `${parseInt(v)}μs` },
    { key: 'iso', label: 'ISO', type: 'slider', format: v => `${parseInt(v)}` },
    { key: 'whiteBalanceMode', label: 'WB Mode', type: 'select' },
    { key: 'colorTemperature', label: 'Color Temp', type: 'slider', format: v => `${parseInt(v)}K` },
    { key: 'brightness', label: 'Brightness', type: 'slider' },
    { key: 'contrast', label: 'Contrast', type: 'slider' },
    { key: 'saturation', label: 'Saturation', type: 'slider' },
    { key: 'sharpness', label: 'Sharpness', type: 'slider' },
  ]

  let count = 0
  for (const ctrl of controlOrder) {
    const cap = safeCapabilities[ctrl.key]
    if (!cap) continue

    let el
    if (ctrl.type === 'toggle') {
      el = buildToggle(ctrl.key, cap, ctrl.label)
    } else if (ctrl.type === 'select') {
      el = buildSelect(ctrl.key, cap, ctrl.label)
    } else {
      el = buildSlider(ctrl.key, cap, ctrl.label, ctrl.format)
    }
    cameraControlsGrid.appendChild(el)
    count++
  }

  if (count > 0) {
    console.log(`[DESKTOP] [CTRL] Built ${count} camera controls`)
  } else {
    cameraControlsGrid.innerHTML = '<p id="cameraControlsEmpty" class="muted small sidebar-empty">No controls available</p>'
    console.log('[DESKTOP] [CTRL] No camera controls available')
  }
}

function scheduleCameraCapabilitiesRetry() {
  if (_cameraCapsRetryTimer || _cameraCapabilities !== null) return
  if (!ws || ws.readyState !== WebSocket.OPEN) return

  _cameraCapsRetryTimer = setTimeout(() => {
    _cameraCapsRetryTimer = null
    if (_cameraCapabilities !== null) return

    if (_cameraCapsRetryCount >= MAX_CAMERA_CAP_RETRIES) {
      console.warn('[DESKTOP] [CTRL] Camera capabilities timed out')
      if (cameraControlsGrid) {
        cameraControlsGrid.innerHTML = '<p id="cameraControlsEmpty" class="muted small sidebar-empty">Camera controls unavailable on this device</p>'
      }
      return
    }

    _cameraCapsRetryCount++
    console.log(`[DESKTOP] [CTRL] Retrying camera capabilities (${_cameraCapsRetryCount}/${MAX_CAMERA_CAP_RETRIES})`)
    requestCameraCapabilities()
  }, 1200)
}

// Send a camera control command to the phone
function sendCameraControl(name, value) {
  console.log(`[DESKTOP] [CTRL] Sending camera control: ${name} = ${value}`)
  sendSignal({ type: 'camera-control', control: { name, value } })
}

// Request capabilities from the phone
function requestCameraCapabilities() {
  console.log('[DESKTOP] [CTRL] Requesting camera capabilities from phone')
  if (_cameraCapabilities === null) scheduleCameraCapabilitiesRetry()
  sendSignal({ type: 'camera-capabilities-request' })
}

// Update a single control's displayed value (after phone confirms)
function updateControlValue(name, value) {
  const valEl = document.getElementById(`camVal_${name}`)
  const ctrlEl = document.getElementById(`camCtrl_${name}`)
  if (ctrlEl) {
    if (ctrlEl.type === 'checkbox') {
      ctrlEl.checked = !!value
      if (valEl) valEl.textContent = value ? 'ON' : 'OFF'
    } else if (ctrlEl.tagName === 'SELECT') {
      ctrlEl.value = value
    } else if (ctrlEl.type === 'range') {
      ctrlEl.value = value
      // re-format the value label using the original format function
      if (valEl) {
        const ctrl = [
          { key: 'zoom', format: v => `${parseFloat(v).toFixed(1)}×` },
          { key: 'exposureCompensation', format: v => `${parseFloat(v) >= 0 ? '+' : ''}${parseFloat(v).toFixed(1)}` },
          { key: 'exposureTime', format: v => `${parseInt(v)}μs` },
          { key: 'iso', format: v => `${parseInt(v)}` },
          { key: 'colorTemperature', format: v => `${parseInt(v)}K` },
          { key: 'focusDistance', format: v => `${parseFloat(v).toFixed(2)}` },
        ].find(c => c.key === name)
        valEl.textContent = ctrl?.format ? ctrl.format(value) : value
      }
    }
  }
}

// Wire up refresh capabilities button
if (refreshCapsBtn) {
  refreshCapsBtn.addEventListener('click', () => requestCameraCapabilities())
}

// ── Message handler ──────────────────────────────────────────────────

async function handleSignalingMessage(msg) {
  // Log only flat strings — never serialize the full msg object.
  // DevTools object serialization blocks the main thread and causes RVFC frame drops.
  // ICE candidates, quality-feedback, and latency pings fire at 1-4 Hz and are
  // handled silently; only important state-change events are logged.
  const tag = msg.action === 'signal'
    ? `signal:${msg.payload?.type ?? '?'}`
    : (msg.action ?? 'unknown')
  if (!/^signal:(ice|quality-feedback|latency-ping|latency-pong|sender-stats|mic-mute|camera-control-result|camera-paused|camera-resumed)$/.test(tag)) {
    console.log('[DESKTOP] signal:', tag)
  }

  if (msg.action === 'error') {
    const m = msg.message || 'Signaling error'
    if (m === 'too-many-connections') {
      scheduleReconnect(Number(msg.retryAfter) * 1000 || 30_000)
    } else if (m === 'room-full' || m === 'room-not-found') {
      // These are permanent errors for this session — don't loop-reconnect.
      // room-full   = desktop already has 2 peers (duplicate WS from a bug)
      // room-not-found = room expired on server restart
      console.warn(`[DESKTOP] WS: ${m} — cancelling reconnect`)
      cancelReconnect()
      intentionalDisconnect = true   // prevent scheduleReconnect from re-triggering
      if (m === 'room-not-found') {
        showError('Room expired (server restarted). Click “Create Room” to start a new session.')
        setStatus('Room expired')
        showView('room')
        renderRecentRooms()
      }
    } else {
      showError(m)
    }
    return
  }

  if (msg.action === 'joined' || msg.action === 'peer-joined') {
    turnServers = Array.isArray(msg.iceServers) ? msg.iceServers : []
    clearError()
  }
  if (msg.action === 'joined') setStatus('Joined room — waiting for phone')
  if (msg.action === 'peer-joined') setStatus('Phone detected — waiting for offer')
  if (msg.action === 'peer-left') {
    const oldPc = pc
    pc = null
    oldPc?.close()
    pendingIce = []
    stopReceiverStats()
    stopFramePipe({ keepVirtualCamera: true })
    video.srcObject = null
    setStatus('Waiting for phone…')
  }

  if (msg.action === 'signal') {
    const payload = msg.payload
    if (!payload) return

    if (payload.type === 'latency-pong') { setLatency(Date.now() - (payload.t || Date.now())); return }
    if (payload.type === 'latency-ping') { sendSignal({ type: 'latency-pong', t: payload.t || Date.now() }); return }
    if (payload.type === 'diagnostic') { console.log('[DESKTOP] Sender diagnostic:', payload); setSenderDiagnostic(payload); return }
    if (payload.type === 'quality-feedback') return

    // Mic mute/unmute from sender
    if (payload.type === 'mic-mute') {
      _micMuted = payload.muted
      console.log(`[DESKTOP] [MIC] mic ${_micMuted ? 'muted' : 'unmuted'} by sender`)
      const el = document.getElementById('micStatus')
      if (el) { el.textContent = _micMuted ? '[x] Mic muted' : ''; el.hidden = !_micMuted }
      return
    }

    // Sprint 10.1: Camera paused/resumed (iOS app-switching, screen lock)
    if (payload.type === 'camera-paused') {
      console.log('[DESKTOP] Phone camera paused')
      setStatus('Camera paused')
      setCameraPausedOverlay(true)
      setQualityLevel(0)
      return
    }
    if (payload.type === 'camera-resumed') {
      console.log('[DESKTOP] Phone camera resumed')
      setStatus('Streaming')
      setCameraPausedOverlay(false)
      return
    }

    // Sprint 9: Camera capabilities received from phone
    if (payload.type === 'camera-capabilities') {
      const ready = payload.ready !== false
      const supported = payload.supported !== false
      const capabilities = payload.capabilities && typeof payload.capabilities === 'object' ? payload.capabilities : {}

      if (!ready) {
        console.log('[DESKTOP] [CTRL] Sender track not ready for capabilities yet')
        scheduleCameraCapabilitiesRetry()
        return
      }

      if (_cameraCapsRetryTimer) {
        clearTimeout(_cameraCapsRetryTimer)
        _cameraCapsRetryTimer = null
      }

      if (!supported || Object.keys(capabilities).length === 0) {
        _cameraCapabilities = {}
        console.log('[DESKTOP] [CTRL] Camera controls unsupported or unavailable on sender')
        if (cameraControlsGrid) {
          cameraControlsGrid.innerHTML = '<p id="cameraControlsEmpty" class="muted small sidebar-empty">Camera controls not supported by this phone/browser</p>'
        }
        return
      }

      console.log('[DESKTOP] [CTRL] Received camera capabilities:', capabilities)
      populateCameraControls(capabilities)
      return
    }

    // Sprint 9: Camera control result from phone (confirms applied value)
    if (payload.type === 'camera-control-result') {
      const r = payload.result
      if (r && r.success && r.name != null) {
        updateControlValue(r.name, r.value)
      } else if (r && !r.success) {
        console.warn(`[DESKTOP] [CTRL] Camera control failed: ${r.error}`)
      }
      return
    }

    // Handle SDP offer (recreate pc cleanly if prior connection failed/reconnected)
    if (payload.type === 'offer') {
      if (pc && (pc.connectionState === 'failed' || pc.connectionState === 'disconnected' || pc.connectionState === 'closed' || pc.signalingState !== 'stable')) {
        try { pc.close() } catch (_) {}
        pc = null
        pendingIce = []
      }
      if (!pc) pc = createPC()
      const conn = pc
      try {
        await conn.setRemoteDescription(payload)
        const answer = await conn.createAnswer()
        await conn.setLocalDescription(answer)
        if (pc !== conn) return
        sendSignal(conn.localDescription)

        // Tell the sender we want low-latency delivery without starving keyframes
        try {
          for (const recv of conn.getReceivers()) {
            if (recv.track && recv.track.kind === 'video') {
              if ('jitterBufferTarget' in recv) recv.jitterBufferTarget = 30
              if ('playoutDelayHint' in recv)   recv.playoutDelayHint = 0.03
            }
          }
        } catch (_) {}
        if (conn.connectionState !== 'connected') setStatus('Answer sent')
        await conn._drainPending()
        if (pc === conn) startReceiverStats()
      } catch (e) {
        if (pc === conn) showError('Failed to handle offer')
        console.error(e)
      }
      return
    }

    // ICE candidate
    if (payload.type === 'ice') {
      const candidate = payload.candidate
      if (!pc || !pc.remoteDescription) {
        pendingIce.push(candidate)
      } else {
        try { await pc.addIceCandidate(candidate) } catch (e) { console.warn('addIceCandidate failed', e) }
      }
    }
  }
}

// ── Update check / Auto-update (simple, self-hosted manifest) ─────────────────────────────────

async function getAppVersion() {
  try {
    if (window.__TAURI__?.core?.invoke) {
      return await window.__TAURI__.core.invoke('get_app_version')
    }
  } catch (e) {
    console.warn('get_app_version failed', e)
  }
  return '0.1.0'
}

function isNewerVersion(remote, local) {
  const r = remote.split('.').map(n => parseInt(n||'0', 10))
  const l = local.split('.').map(n => parseInt(n||'0', 10))
  for (let i = 0; i < Math.max(r.length, l.length); i++) {
    const ri = r[i] || 0
    const li = l[i] || 0
    if (ri > li) return true
    if (ri < li) return false
  }
  return false
}

async function checkForUpdates({ manual = false } = {}) {
  if (!updateStatusEl || !checkUpdateBtn) return
  updateStatusEl.textContent = manual ? 'Checking for updates…' : 'Checking updates…'
  checkUpdateBtn.disabled = true

  // Helper: render update status safely using DOM APIs (no innerHTML)
  function renderUpdatePrompt(remoteVersion, buttonLabel, onClick) {
    updateStatusEl.textContent = ''
    updateStatusEl.append('Update available: ')
    const strong = document.createElement('strong')
    strong.textContent = `v${remoteVersion}`
    updateStatusEl.append(strong, ' — ')
    const btn = document.createElement('button')
    btn.id = 'updateBtn'
    btn.className = 'primary'
    btn.textContent = buttonLabel
    btn.addEventListener('click', onClick)
    updateStatusEl.append(btn)
  }

  // Try official Tauri v2 signed updater via Rust backend (verifies minisign signature,
  // downloads in-place, installs, and restarts automatically without opening GitHub)
  try {
    if (window.__TAURI__?.core?.invoke) {
      const update = await window.__TAURI__.core.invoke('check_update_available')
      if (update && update.version) {
        renderUpdatePrompt(update.version, 'Install & Restart', async () => {
          try {
            updateStatusEl.textContent = `Downloading & installing v${update.version}…`
            await window.__TAURI__.core.invoke('download_and_install_update')
          } catch (err) {
            console.warn('download_and_install_update failed', err)
            updateStatusEl.textContent = `Update failed: ${err}`
          }
        })
        checkUpdateBtn.disabled = false
        return
      } else {
        const current = await getAppVersion()
        updateStatusEl.textContent = manual ? `Up to date (v${current})` : ''
        checkUpdateBtn.disabled = false
        if (!manual) setTimeout(() => { updateStatusEl.textContent = '' }, 4000)
        return
      }
    }
  } catch (e) {
    console.warn('tauri updater check failed', e)
  }

  // Fallback: query server /update/latest manifest (opens verified HTTPS release page in browser)
  try {
    const httpUrl = getHttpUrl()
    const resp = await fetch(`${httpUrl}/update/latest`)
    if (resp.status === 204 || resp.status === 404) {
      updateStatusEl.textContent = manual ? 'Up to date' : ''
      return
    }
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`)
    const data = await resp.json()
    const remoteVersion = String(data.version || '0.0.0')
    const current = await getAppVersion()

    if (isNewerVersion(remoteVersion, current)) {
      const downloadUrl = data.url || data.windows || data.platforms?.windows || null
      renderUpdatePrompt(remoteVersion, 'Download', async (e) => {
        e.preventDefault()
        if (!downloadUrl) {
          updateStatusEl.textContent = 'No download URL available'
          return
        }
        try {
          const parsed = new URL(downloadUrl)
          if (parsed.protocol !== 'https:') {
            updateStatusEl.textContent = 'Blocked non-HTTPS download URL'
            return
          }
        } catch {
          updateStatusEl.textContent = 'Invalid download URL'
          return
        }

        let launched = false
        try {
          if (window.__TAURI__?.core?.invoke) {
            await window.__TAURI__.core.invoke('plugin:opener|open_url', { url: downloadUrl })
            launched = true
          }
        } catch (err) { console.warn('opener.invoke failed', err) }

        if (!launched) {
          try { window.open(downloadUrl, '_blank', 'noopener,noreferrer'); launched = true } catch (err) { console.warn('window.open failed', err) }
        }

        if (!launched) {
          try { await navigator.clipboard.writeText(downloadUrl); updateStatusEl.textContent = 'Download URL copied to clipboard.'; launched = true } catch (err) { console.warn('clipboard write failed', err) }
        }

        if (!launched) updateStatusEl.textContent = 'Unable to open release page'
      })
    } else {
      updateStatusEl.textContent = `Up to date (v${current})`
    }
  } catch (err) {
    if (manual) console.warn('update check failed', err)
    updateStatusEl.textContent = manual ? 'Update check failed' : ''
  } finally {
    checkUpdateBtn.disabled = false
    setTimeout(() => { if (!manual) updateStatusEl.textContent = '' }, 4000)
  }
}

// ── Room creation ────────────────────────────────────────────────────

async function createRoom() {
  clearError()
  intentionalDisconnect = false
  cancelReconnect()

  // Clean up any active connection before creating a new room
  if (latencyInterval) { clearInterval(latencyInterval); latencyInterval = null }
  if (pc) { try { pc.close() } catch (_) {} pc = null }
  if (ws) { try { ws.close() } catch (_) {} ws = null }

  createRoomBtn.disabled = true
  createRoomBtn.textContent = 'Creating…'

  try {
    const httpUrl = getHttpUrl()
    console.log(`[DESKTOP] Creating room via ${httpUrl}/create-room`)
    const resp = await fetch(`${httpUrl}/create-room`, { method: 'POST' })
    if (!resp.ok) {
      const body = await resp.json().catch(() => ({}))
      throw new Error(resp.status === 429
        ? 'Rate limit reached. Please wait a moment or use a Recent Room.'
        : (body.error || `HTTP ${resp.status}`))
    }
    const data = await resp.json()

    const roomId = data.roomId
    currentRoomId = roomId
    roomIdDisplay.textContent = roomId

    // Persist room for auto-rejoin on next launch
    localStorage.setItem('bridgecam-room-id', roomId)
    localStorage.setItem('bridgecam-room-server', getHttpUrl())

    // Prefer mobileUrl if publicly reachable or LAN HTTPS; fall back to lanJoinUrl
    let mobileUrl = data.mobileUrl || data.lanJoinUrl || `${httpUrl}/?room=${encodeURIComponent(roomId)}`
    try {
      const parsed = new URL(mobileUrl)
      const isInternal = /localhost|127\.\d+\.\d+\.\d+|10\.\d+|192\.168\.|172\.(1[6-9]|2\d|3[01])\./.test(parsed.hostname)
      if (isInternal && parsed.protocol !== 'https:') {
        mobileUrl = data.lanJoinUrl || `${httpUrl}/?room=${encodeURIComponent(roomId)}`
      }
    } catch (_) {
      mobileUrl = data.lanJoinUrl || `${httpUrl}/?room=${encodeURIComponent(roomId)}`
    }
    mobileLinkEl.textContent = mobileUrl

    // Save to room history so user can rejoin after disconnecting
    saveRoomToHistory(roomId, httpUrl, mobileUrl)

    await renderQR(mobileUrl)
    qrContainer.hidden = false

    const activeWs = connectSignaling(handleSignalingMessage)
    ws = activeWs
    activeWs.addEventListener('open', () => {
      if (ws !== activeWs) return
      joinRoom(roomId)
      setStatus('Waiting for phone…')
      if (latencyInterval) clearInterval(latencyInterval)
      latencyInterval = setInterval(() => {
        sendSignal({ type: 'latency-ping', t: Date.now() })
      }, 2000)
    })
    activeWs.addEventListener('close', () => {
      if (ws !== activeWs) return
      if (latencyInterval) { clearInterval(latencyInterval); latencyInterval = null }
      setLatency(null)
      stopReceiverStats()
      if (!intentionalDisconnect && currentRoomId) {
        scheduleReconnect()
      }
    })
  } catch (err) {
    console.error('[DESKTOP] create-room failed:', err)
    showError(`${err.message}`)
    throw err
  } finally {
    createRoomBtn.disabled = false
    createRoomBtn.textContent = 'Create Room'
  }
}

// ── Disconnect ───────────────────────────────────────────────────────

function disconnect() {
  intentionalDisconnect = true
  cancelReconnect()
  _cameraCapabilities = null
  _cameraCapsRetryCount = 0
  if (_cameraCapsRetryTimer) { clearTimeout(_cameraCapsRetryTimer); _cameraCapsRetryTimer = null }
  setCameraPausedOverlay(false)
  setQualityLevel(-1)
  stopAllPostReleaseFeatures()
  stopFramePipe()
  if (pc) { pc.close(); pc = null }
  if (ws) { ws.close(); ws = null }
  if (latencyInterval) { clearInterval(latencyInterval); latencyInterval = null }
  stopReceiverStats()
  pendingIce = []
  currentRoomId = null
  // Clear saved room so next launch creates a fresh one
  localStorage.removeItem('bridgecam-room-id')
  localStorage.removeItem('bridgecam-room-server')
  video.srcObject = null
  setStatus('Idle')
  setSenderDiagnostic(null)
  setLatency(null)
  if (statsEl) { statsEl.textContent = ''; statsEl.dataset.settingHidden = '1' }
  if (viewTabs) viewTabs.hidden = true
  showView('room')
  qrContainer.hidden = true
  // Refresh recent rooms list so user can rejoin
  renderRecentRooms()
}

// Global view switching for external callers
window.showView = showView;

// ── Event listeners ──────────────────────────────────────────────────

createRoomBtn.addEventListener('click', () => createRoom().catch(() => {}))  // error already shown in UI
disconnectBtn.addEventListener('click', disconnect)
if (checkUpdateBtn) checkUpdateBtn.addEventListener('click', () => checkForUpdates({ manual: true }))

// Render recent rooms on startup so returning users can rejoin instantly
renderRecentRooms()

// Persist server URL
const savedUrl = localStorage.getItem('bridgecam-server-url')
if (savedUrl) serverUrlInput.value = savedUrl
serverUrlInput.addEventListener('change', () => {
  localStorage.setItem('bridgecam-server-url', serverUrlInput.value.trim())
})

// Auto-check for updates shortly after startup (non-blocking)
setTimeout(() => { if (checkUpdateBtn) checkForUpdates().catch(() => {}) }, 1500)

// ── Auto-activate virtual camera on startup ──────────────────────────
// The virtual camera should be visible to NVB/Zoom/Teams even before a phone
// connects.  Frame Server will show the test pattern from frame_writer until
// real WebRTC frames arrive.
;(async () => {
  try {
    if (!(await ensureInvokeReady())) return
    // Create the shared memory at a sensible default size if not already active
    if (shmMode === 'none') {
      const defaultW = 1280, defaultH = 720
      await createNamedSharedMemory(defaultW, defaultH)
      shmMode = 'named'
      console.log('[DESKTOP] Auto-created named SHM', defaultW, 'x', defaultH)
    }
    if (!virtualCameraActive) {
      await activateVirtualCamera()
      console.log('[DESKTOP] Auto-activated virtual camera on startup')
    }
    // Pre-fetch audio socket port for the mic pipe (non-blocking)
    window.__TAURI__.core.invoke('get_audio_socket_port')
      .then(p => {
        _audioPort = p
        console.log(`[DESKTOP] audio socket port: ${p}`)
        if (_audioPortResolve) { _audioPortResolve(p); _audioPortResolve = null }
      })
      .catch(e => {
        console.warn('[DESKTOP] audio socket port unavailable:', e)
        if (_audioPortResolve) { _audioPortResolve(0); _audioPortResolve = null }
      })

    // Sprint 14: Check VB-Audio Cable availability and show optional install banner if absent
    window.__TAURI__.core.invoke('check_vb_audio')
      .then(present => {
        const banner = document.getElementById('vbAudioBanner')
        const dismiss = document.getElementById('vbAudioDismiss')
        if (banner && !present && localStorage.getItem('bridgecam-vbaudio-dismissed') !== '1') {
          banner.hidden = false
          if (dismiss) {
            dismiss.addEventListener('click', () => {
              banner.hidden = true
              localStorage.setItem('bridgecam-vbaudio-dismissed', '1')
            }, { once: true })
          }
        }
      })
      .catch(() => {})
  } catch (e) {
    console.warn('[DESKTOP] Auto-activation failed (Win11 22H2+ required):', e)
  }
})()

// ── Auto-init: start server + create room on launch ──────────────────
// The signaling server is now hosted on Render (HTTPS, always-on).
// The desktop app connects directly to the cloud server — no need to
// start a local Node.js process or wait for an ngrok tunnel.
// The cloud server provides HTTPS automatically, so the QR code URL
// works on phones without any extra setup.
const CLOUD_SERVER_URL = 'https://bridgecam.onrender.com'

;(async () => {
  try {
    // Respect custom Default Server URL from Settings if configured; otherwise use cloud server
    const savedSettings = loadSettings()
    const targetServer = (savedSettings.defaultServer && savedSettings.defaultServer.trim())
      ? savedSettings.defaultServer.trim().replace(/^wss?:\/\//, (m) => m.startsWith('wss') ? 'https://' : 'http://').replace(/\/ws\/?$/, '')
      : CLOUD_SERVER_URL
    serverUrlInput.value = targetServer
    localStorage.setItem('bridgecam-server-url', targetServer)
    console.log('[DESKTOP] autoInit: using server', targetServer)

    // ── Wait for the server to be reachable ──────────────────
    // Render free tier may cold-start (~30s), so we retry patiently.
    const MAX_RETRIES = 12
    const RETRY_DELAY = 3000

    async function serverReachable() {
      try {
        const resp = await fetch(`${targetServer}/health`, { signal: AbortSignal.timeout(8000) })
        return resp.ok
      } catch { return false }
    }

    let serverUp = false
    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
      setStatus(`Connecting to server… (${attempt}/${MAX_RETRIES})`)
      serverUp = await serverReachable()
      if (serverUp) break
      console.warn(`[DESKTOP] autoInit: server not ready (attempt ${attempt}/${MAX_RETRIES})`)
      if (attempt < MAX_RETRIES) await new Promise(r => setTimeout(r, RETRY_DELAY))
    }

    if (!serverUp) {
      console.error('[DESKTOP] autoInit: cloud server unreachable after retries')
      showError('Could not reach BridgeCam server. It may be waking up — click "Create Room" to retry.')
      setStatus('Server unreachable')
      return
    }

    // ── Create a fresh room on the cloud server ────────────────────
    console.log('[DESKTOP] autoInit: creating room on cloud server')
    _captchaSkip = true   // auto-init skips the UI CAPTCHA
    await createRoom()
    console.log('[DESKTOP] autoInit: room created, currentRoomId =', currentRoomId)
  } catch (e) {
    console.warn('[DESKTOP] autoInit failed:', e)
    showError('Auto-init failed. Click "Create Room" to retry.')
  }
})()

