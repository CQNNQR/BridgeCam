// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 BridgeCam Contributors

import express from 'express'
import http from 'http'
import https from 'https'
import { WebSocketServer } from 'ws'
import ngrok from '@ngrok/ngrok'
import QRCode from 'qrcode'
import path from 'path'
import fs from 'fs'
import { fileURLToPath } from 'url'
import { attachSignaling, getClientIp } from './signaling.js'
import * as rooms from './room.js'
import { logger, generateRequestId, createRequestLogger } from './logger.js'
import { config } from './config.js'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

const SERVER_VERSION = '1.0.0'
const PORT = config.port
const SIGNALING_PATH = config.signalingPath
const WS_MAX_PAYLOAD = 64 * 1024 // 64 KB — plenty for SDP/ICE, blocks DoS

let ngrokUrl = null
let ngrokListener = null
let tunnelReady = false
let tunnelReadyResolve = null
const tunnelReadyPromise = new Promise(r => { tunnelReadyResolve = r })

const app = express()

const staticDir = path.resolve(__dirname, '..', '..', 'mobile', 'public')
const sharedDir = path.resolve(__dirname, '..', '..', 'shared', 'src')

// ── Security headers (applied before ALL routes & static files) ─────
app.use((req, res, next) => {
  res.setHeader('Content-Security-Policy',
    "default-src 'self'; " +
    "script-src 'self' 'unsafe-inline'; " +
    "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; " +
    "style-src-elem 'self' 'unsafe-inline' https://fonts.googleapis.com; " +
    "font-src 'self' https://fonts.gstatic.com; " +
    "img-src 'self' data: blob:; " +
    "connect-src 'self' ws: wss: http: https:; " +
    "media-src 'self' blob:; " +
    "worker-src 'self' blob:; " +
    "frame-src 'self'; " +
    "frame-ancestors 'self'; " +
    "object-src 'none';"
  )
  res.setHeader('X-Content-Type-Options', 'nosniff')
  res.setHeader('Referrer-Policy', 'no-referrer')
  res.setHeader('Permissions-Policy', 'camera=(self), microphone=(self), geolocation=()')
  next()
})

// ── CORS middleware (registered before ALL routes) ──────────────────
const corsOrigins = config.corsOrigins === '*'
  ? ['*']
  : (config.corsOrigins.length > 0
      ? config.corsOrigins
      : ['http://localhost', 'http://localhost:*', 'http://127.0.0.1', 'http://127.0.0.1:*', 'tauri://localhost', 'http://tauri.localhost'])

app.use((req, res, next) => {
  const origin = req.get('origin')
  let ngrokOrigin = null
  if (ngrokUrl) {
    try { ngrokOrigin = new URL(ngrokUrl).origin } catch (_) {}
  }

  const isAllowedOrigin = corsOrigins.includes('*') || corsOrigins.some(allowed => {
    if (allowed.endsWith('*')) {
      const prefix = allowed.slice(0, -1)
      return origin && origin.startsWith(prefix)
    }
    return origin === allowed
  }) || (ngrokOrigin && origin === ngrokOrigin)

  if (isAllowedOrigin) {
    res.setHeader('Access-Control-Allow-Origin', origin || '*')
  }
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS')
  res.setHeader('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept, X-Request-ID')
  res.setHeader('Access-Control-Max-Age', '86400')
  if (req.method === 'OPTIONS') return res.sendStatus(204)
  next()
})

app.use(express.json({ limit: '64kb' }))

// ── Request logging middleware ──────────────────────────────────────
app.use((req, res, next) => {
  const reqId = generateRequestId()
  const startTime = Date.now()
  req.requestId = reqId

  if (req.url !== '/health') {
    logger.debug({ method: req.method, url: req.url, ip: req.ip, reqId }, 'Incoming request')
  }

  res.on('finish', () => {
    const duration = Date.now() - startTime
    const level = res.statusCode >= 400 ? 'warn' : 'info'
    if (req.url !== '/health') {
      logger[level]({
        method: req.method,
        url: req.url,
        status: res.statusCode,
        duration,
        reqId
      }, 'Request completed')
    }
  })

  next()
})

// ── HTTP rate limiter for POST /create-room ─────────────────────────
const httpCreateBuckets = new Map()
const HTTP_CREATE_LIMIT = 20
const HTTP_CREATE_WINDOW_MS = 60_000

const httpRateCleanup = setInterval(() => {
  const cutoff = Date.now() - HTTP_CREATE_WINDOW_MS
  for (const [ip, ts] of httpCreateBuckets.entries()) {
    const recent = ts.filter(t => t > cutoff)
    if (recent.length === 0) httpCreateBuckets.delete(ip)
    else httpCreateBuckets.set(ip, recent)
  }
}, 120_000)
if (typeof httpRateCleanup.unref === 'function') httpRateCleanup.unref()

function rateLimitCreateRoom(req, res, next) {
  const ip = getClientIp(req)
  const now = Date.now()
  const cutoff = now - HTTP_CREATE_WINDOW_MS
  const recent = (httpCreateBuckets.get(ip) || []).filter(t => t > cutoff)
  if (recent.length >= HTTP_CREATE_LIMIT) {
    return res.status(429).json({ error: 'Too many room creation requests — please slow down' })
  }
  recent.push(now)
  httpCreateBuckets.set(ip, recent)
  next()
}

// ── API routes (before express.static) ──────────────────────────────
app.get('/health', (req, res) => {
  const stats = rooms.getStats()
  const payload = { ok: true, version: SERVER_VERSION, uptime: process.uptime() }
  if (config.nodeEnv !== 'production') {
    payload.rooms = stats.totalRooms
    payload.peers = stats.totalPeers
    payload.requestId = req.requestId
  }
  res.json(payload)
})

// Proxy GitHub Releases latest.json for desktop updater fallback
app.get('/update/latest', async (req, res) => {
  try {
    const resp = await fetch('https://github.com/CQNNQR/BridgeCam/releases/latest/download/latest.json', {
      signal: AbortSignal.timeout(8000)
    })
    if (resp.status === 404) return res.status(204).end()
    if (!resp.ok) return res.status(502).json({ error: 'Upstream release check failed' })
    const manifest = await resp.json()
    res.json(manifest)
  } catch (err) {
    logger.debug({ error: err.message }, 'GitHub release check unavailable')
    res.status(204).end()
  }
})

app.get('/tunnel-status', (req, res) => {
  if (tunnelReady) {
    return res.json({ ready: true, tunnelUrl: ngrokUrl || null })
  }
  const timeout = setTimeout(() => {
    if (!res.headersSent) res.json({ ready: true, tunnelUrl: ngrokUrl || null })
  }, 15000)
  tunnelReadyPromise.then(() => {
    clearTimeout(timeout)
    if (!res.headersSent) res.json({ ready: true, tunnelUrl: ngrokUrl || null })
  })
})

async function getLanAddress() {
  const os = await import('os')
  const nets = os.networkInterfaces()
  const skipPatterns = /vmware|vmnet|virtualbox|vbox|docker|veth|podman|bluetooth|openVPN|loopback/i
  let fallback = null
  for (const [name, addrs] of Object.entries(nets)) {
    for (const net of addrs) {
      if (net.family !== 'IPv4' || net.internal) continue
      if (net.address.startsWith('169.254.')) continue
      if (skipPatterns.test(name)) {
        if (!fallback) fallback = net.address
        continue
      }
      return net.address
    }
  }
  return fallback
}

app.post('/create-room', rateLimitCreateRoom, async (req, res) => {
  const reqLog = createRequestLogger(logger, req.requestId)
  const startTime = Date.now()

  try {
    const roomId = rooms.createRoom()
    const proto = req.headers['x-forwarded-proto']?.split(',')[0]?.trim() || req.protocol
    const host = req.get('host')
    const baseOrigin = `${proto}://${host}`
    const joinUrl = `${baseOrigin}/?room=${roomId}`

    let lanHost = null
    if (config.nodeEnv !== 'production') {
      try { lanHost = await getLanAddress() } catch (_) { lanHost = null }
    }
    const lanJoinUrl = lanHost ? `http://${lanHost}:${PORT}/?room=${roomId}` : joinUrl

    let mobileUrl = null
    if (config.nodeEnv === 'production' || proto === 'https') {
      mobileUrl = joinUrl
    } else if (ngrokUrl) {
      mobileUrl = `${ngrokUrl}/?room=${roomId}`
    } else {
      // Dev mode: check manually-running local ngrok (127.0.0.1:4040)
      try {
        const resp = await fetch('http://127.0.0.1:4040/api/tunnels', { signal: AbortSignal.timeout(1000) })
        if (resp.ok) {
          const body = await resp.json()
          const tunnel = (body.tunnels || []).find(t => t.proto === 'https') || (body.tunnels || [])[0]
          if (tunnel && tunnel.public_url) {
            mobileUrl = `${tunnel.public_url.replace(/\/$/, '')}/?room=${roomId}`
          }
        }
      } catch (_) {}
    }

    if (!mobileUrl && sslOptions && lanHost && httpsPort) {
      mobileUrl = `https://${lanHost}:${httpsPort}/?room=${roomId}`
    }
    if (!mobileUrl) {
      mobileUrl = lanJoinUrl
    }

    const qr = await QRCode.toDataURL(mobileUrl)
    const duration = Date.now() - startTime
    reqLog.info({ roomId, duration }, 'Room created successfully')

    res.json({ roomId, joinUrl, lanJoinUrl, mobileUrl, qr })
  } catch (err) {
    if (err.message === 'max-rooms-reached') {
      return res.status(503).json({ error: 'Server room capacity reached — try again shortly' })
    }
    reqLog.error({ error: err.message, stack: err.stack }, 'Failed to create room')
    res.status(500).json({ error: 'Failed to create room' })
  }
})

// ── Static assets & shared modules ──────────────────────────────────
const staticOpts = config.nodeEnv !== 'production'
  ? {
      setHeaders: (res) => {
        res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate, max-age=0')
      }
    }
  : { maxAge: '5m' }

app.use('/shared', express.static(sharedDir, staticOpts))
app.use(express.static(staticDir, staticOpts))
app.get('/host', (req, res) => res.sendFile(path.join(staticDir, 'host.html')))
app.get('/receiver', (req, res) => res.sendFile(path.join(staticDir, 'receiver.html')))

// ── Optional local HTTPS/WSS support (dev/LAN) ──────────────────────
let sslOptions = null
const certFile = config.ssl.certPath || path.resolve(__dirname, '..', 'cert', 'server.crt')
const keyFile = config.ssl.keyPath || path.resolve(__dirname, '..', 'cert', 'server.key')

if (config.nodeEnv !== 'production' || config.useHttps) {
  try {
    if (fs.existsSync(certFile) && fs.existsSync(keyFile)) {
      sslOptions = {
        key: fs.readFileSync(keyFile),
        cert: fs.readFileSync(certFile)
      }
      logger.info({ certFile }, 'Using SSL certificates for HTTPS/WSS')
    }
  } catch (e) {
    logger.warn({ error: e.message }, 'Could not load SSL certificates')
  }
}

const server = http.createServer(app)
let httpsServer = null
let httpsPort = null
if (sslOptions) {
  httpsPort = PORT + 1
  httpsServer = https.createServer(sslOptions, app)
  httpsServer.on('error', (err) => {
    logger.warn({ port: httpsPort, error: err.message }, 'HTTPS server failed to bind (continuing HTTP only)')
  })
}

const wss = new WebSocketServer({ server, path: SIGNALING_PATH, maxPayload: WS_MAX_PAYLOAD })
let wssSecure = null
if (httpsServer) {
  wssSecure = new WebSocketServer({ server: httpsServer, path: SIGNALING_PATH, maxPayload: WS_MAX_PAYLOAD })
}
attachSignaling(wss)
if (wssSecure) attachSignaling(wssSecure)

server.listen(PORT, '0.0.0.0', async () => {
  logger.info({
    version: SERVER_VERSION,
    port: PORT,
    signalingPath: SIGNALING_PATH,
    nodeEnv: config.nodeEnv,
    logLevel: config.logLevel,
    useHttps: !!sslOptions,
    httpsPort: sslOptions ? httpsPort : null
  }, 'BridgeCam signaling server started')

  if (httpsServer) {
    httpsServer.listen(httpsPort, '0.0.0.0', () => {
      logger.info({ port: httpsPort }, 'HTTPS server started on all interfaces')
    })
  }

  // Only start ngrok tunnel in non-production environments (Render provides TLS automatically)
  if (config.nodeEnv === 'production') {
    tunnelReady = true
    if (tunnelReadyResolve) tunnelReadyResolve()
    return
  }

  try {
    let resolvedAuthtoken = config.ngrok.authtoken
    if (!resolvedAuthtoken) {
      try {
        const os = await import('os')
        const fsp = await import('fs/promises')
        const candidates = [
          path.join(os.homedir(), '.ngrok2', 'ngrok.yml'),
          path.join(os.homedir(), '.config', 'ngrok', 'ngrok.yml'),
          path.join(process.env.APPDATA || '', 'ngrok', 'ngrok.yml')
        ]
        for (const cfgPath of candidates) {
          try {
            const cfg = await fsp.readFile(cfgPath, 'utf8')
            const m = cfg.match(/authtoken:\s*(\S+)/)
            if (m) {
              resolvedAuthtoken = m[1]
              process.env.NGROK_AUTHTOKEN = m[1]
              logger.info({ configPath: cfgPath }, 'Loaded ngrok authtoken from config file')
              break
            }
          } catch (_) {}
        }
      } catch (e) {
        logger.debug({ error: e.message }, 'Error during ngrok config search')
      }
    }

    if (resolvedAuthtoken) {
      const ngrokOptions = { addr: config.ngrok.options.addr || PORT, authtoken_from_env: true }
      if (config.ngrok.options.bandwidth) ngrokOptions.bandwidth = config.ngrok.options.bandwidth
      if (config.ngrok.options.metadata) ngrokOptions.metadata = config.ngrok.options.metadata
      ngrokListener = await ngrok.forward(ngrokOptions)
      ngrokUrl = ngrokListener.url()
      logger.info({ ngrokUrl }, 'ngrok tunnel active')
    }
  } catch (err) {
    logger.warn({ error: err.message }, 'ngrok tunnel unavailable (LAN/HTTPS fallback active)')
  } finally {
    tunnelReady = true
    if (tunnelReadyResolve) tunnelReadyResolve()
  }
})

// ── Unified graceful shutdown ───────────────────────────────────────
let shuttingDown = false
async function shutdown(signal) {
  if (shuttingDown) return
  shuttingDown = true
  logger.info({ signal }, 'Shutting down gracefully')

  const forceTimer = setTimeout(() => process.exit(0), 5000)
  if (typeof forceTimer.unref === 'function') forceTimer.unref()

  for (const wsServer of [wss, wssSecure]) {
    if (!wsServer) continue
    for (const client of wsServer.clients) {
      try { client.terminate() } catch (_) {}
    }
    try { wsServer.close() } catch (_) {}
  }

  if (ngrokListener) {
    try { await ngrokListener.close() } catch (_) {}
  }
  if (httpsServer) {
    try { httpsServer.close() } catch (_) {}
  }
  server.close(() => {
    logger.info('Server closed')
    process.exit(0)
  })
}

process.on('SIGTERM', () => shutdown('SIGTERM'))
process.on('SIGINT', () => shutdown('SIGINT'))
process.on('unhandledRejection', (reason) => {
  logger.error({ reason: reason?.message || reason, stack: reason?.stack }, 'Unhandled Promise Rejection')
})
process.on('uncaughtException', (err) => {
  logger.fatal({ error: err.message, stack: err.stack }, 'Uncaught Exception')
  process.exit(1)
})
