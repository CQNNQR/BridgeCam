import { describe, test, expect, beforeEach, afterEach } from '@jest/globals'
import { parseInteger, loadConfig } from '../src/config.js'

describe('config.js', () => {
  const originalEnv = { ...process.env }

  beforeEach(() => {
    process.env = { ...originalEnv }
  })

  afterEach(() => {
    process.env = originalEnv
  })

  test('parseInteger parses valid integers without recursion', () => {
    expect(parseInteger('8080', 1, 65535)).toBe(8080)
    expect(parseInteger('0', 1, 65535)).toBe(1)
    expect(parseInteger('99999', 1, 65535)).toBe(65535)
    expect(() => parseInteger('not-a-number', 1, 100)).toThrow('not a number')
  })

  test('loadConfig respects numeric env overrides like PORT and MAX_ROOMS', () => {
    process.env.PORT = '4567'
    process.env.MAX_ROOMS = '25'
    process.env.RATE_LIMIT_MAX_MESSAGES = '250'
    process.env.TRUST_PROXY = 'true'
    const cfg = loadConfig()
    expect(cfg.port).toBe(4567)
    expect(cfg.maxRooms).toBe(25)
    expect(cfg.rateLimit.maxMessages).toBe(250)
    expect(cfg.trustProxy).toBe(true)
  })
})
