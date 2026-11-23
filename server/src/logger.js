import pino from 'pino'
import { cpus, availableParallelism, hostname } from 'os'

const isDev = process.env.NODE_ENV !== 'production'

// Detect worker threads for multi-core utilization (disabled by default)
// Workers are only used when USE_WORKERS=true to avoid issues with ngrok in the main thread
const numWorkers = (() => {
  try {
    return process.env.USE_WORKERS === 'true' ? (availableParallelism() || cpus().length) : 1
  } catch {
    return 1
  }
})()

export const logger = pino({
  level: process.env.LOG_LEVEL || 'info',
  // Use pretty printing in development, JSON in production
  // Note: formatters cannot be used in transport options (worker thread serialization)
  transport: isDev
    ? {
        target: 'pino-pretty',
        options: {
          colorize: true,
          translateTime: 'SYS:standard',
          ignore: 'pid,hostname'
        }
      }
    : undefined,
  // Base fields included in every log entry
  base: {
    pid: process.pid,
    hostname: process.env.HOSTNAME || hostname(),
    numWorkers,
    service: 'bridgecam-signaling'
  },
  // Formatters for consistent output
  formatters: {
    level: (label) => ({ level: label }),
    bindings: (obj) => ({
      pid: obj.pid,
      hostname: obj.hostname,
      numWorkers: obj.numWorkers,
      service: obj.service
    })
  },
  // Timestamp format - ISO 8601 for easy parsing
  timestamp: pino.stdTimeFunctions.isoTime,
  // Redact sensitive fields - add any sensitive config keys here
  redact: {
    paths: ['req.headers.authorization', 'req.headers.cookie', 'env.NGROK_AUTHTOKEN'],
    censor: '[REDACTED]'
  }
})

// Child logger factory for creating request-scoped loggers
export function createRequestLogger(baseLogger, requestId) {
  return baseLogger.child({
    reqId: requestId
  })
}

// Generate a short unique request ID
export function generateRequestId() {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
}

export default logger
