// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 BridgeCam Contributors
//
// Environment-based configuration for BridgeCam signaling server.
// All values can be overridden via environment variables.

function getEnv(key, defaultValue, parser) {
  const val = process.env[key]
  if (val === undefined) return defaultValue
  try {
    return parser ? parser(val) : val
  } catch (e) {
    console.warn(`Invalid value for ${key}: "${val}", using default: ${defaultValue}`)
    return defaultValue
  }
}

function parseList(val) {
  if (!val) return []
  return val.split(',').map(s => s.trim()).filter(Boolean)
}

function parseBool(val) {
  if (val === undefined) return false
  const lower = String(val).toLowerCase()
  return lower === 'true' || lower === '1' || lower === 'yes'
}

// Parse integer with optional range clamping (uses Number.parseInt to avoid recursion)
export function parseInteger(val, min, max) {
  const parsed = Number.parseInt(val, 10)
  if (Number.isNaN(parsed)) throw new Error('not a number')
  if (min !== undefined && parsed < min) return min
  if (max !== undefined && parsed > max) return max
  return parsed
}

export function loadConfig() {
  const cfg = {
    port: getEnv('PORT', 3000, (v) => parseInteger(v, 1, 65535)),

    logLevel: getEnv('LOG_LEVEL', 'info', (v) => {
      const valid = ['trace', 'debug', 'info', 'warn', 'error', 'fatal']
      if (!valid.includes(v)) {
        console.warn(`Invalid LOG_LEVEL: "${v}", using "info"`)
        return 'info'
      }
      return v
    }),

    signalingPath: getEnv('SIGNALING_PATH', '/ws'),

    rateLimit: {
      windowMs: getEnv('RATE_LIMIT_WINDOW_MS', 60000, (v) => parseInteger(v, 1000)),
      maxMessages: getEnv('RATE_LIMIT_MAX_MESSAGES', 100, (v) => parseInteger(v, 1)),
      maxConnectionsPerIp: getEnv('RATE_LIMIT_MAX_CONNECTIONS_PER_IP', 10, (v) => parseInteger(v, 1))
    },

    corsOrigins: getEnv('CORS_ORIGINS', '*', (v) => (v.trim() === '*' ? '*' : parseList(v))),

    useHttps: getEnv('USE_HTTPS', false, parseBool),
    ssl: {
      keyPath: getEnv('SSL_KEY_PATH', '', (v) => v),
      certPath: getEnv('SSL_CERT_PATH', '', (v) => v)
    },

    ngrok: {
      authtoken: process.env.NGROK_AUTHTOKEN || null,
      options: {
        addr: getEnv('NGROK_ADDR', null),
        bandwidth: getEnv('NGROK_BANDWIDTH', null),
        metadata: getEnv('NGROK_METADATA', 'BridgeCam')
      }
    },

    nodeEnv: getEnv('NODE_ENV', 'development', (v) =>
      ['development', 'production', 'test'].includes(v) ? v : 'development'
    ),

    trustProxy: getEnv('TRUST_PROXY', false, parseBool),
    render: getEnv('RENDER', false, parseBool),
    turn: {
      urls: parseList(process.env.TURN_URLS),
      secret: process.env.TURN_SECRET
    },
    maxRooms: getEnv('MAX_ROOMS', 0, (v) => parseInteger(v, 0)),
    peerTimeout: getEnv('PEER_TIMEOUT_MS', 30000, (v) => parseInteger(v, 5000)),
    healthCheckInterval: getEnv('HEALTH_CHECK_INTERVAL_MS', 30000, (v) => parseInteger(v, 5000))
  }

  if (cfg.useHttps) {
    if (!cfg.ssl.keyPath || !cfg.ssl.certPath) {
      throw new Error('USE_HTTPS=true requires SSL_KEY_PATH and SSL_CERT_PATH to be set')
    }
  }

  if (Object.freeze) {
    Object.freeze(cfg)
    Object.freeze(cfg.rateLimit)
    Object.freeze(cfg.ssl)
    Object.freeze(cfg.ngrok)
    Object.freeze(cfg.ngrok.options)
  }

  return cfg
}

export const config = loadConfig()
export default config
