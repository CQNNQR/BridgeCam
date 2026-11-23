// Mock config for testing
export const config = {
  port: 3000,
  logLevel: 'info',
  signalingPath: '/ws',
  rateLimit: {
    windowMs: 60000,
    maxMessages: 100,
    maxConnectionsPerIp: 10
  },
  corsOrigins: '*',
  useHttps: false,
  ssl: {
    keyPath: '',
    certPath: ''
  },
  ngrok: {
    authtoken: null,
    options: {}
  },
  nodeEnv: 'test',
  useWorkers: false,
  maxRooms: 0,
  peerTimeout: 30000,
  healthCheckInterval: 30000
}

export default config
