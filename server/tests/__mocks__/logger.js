import { jest } from '@jest/globals'

// Mock logger for testing
export const logger = {
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
  debug: jest.fn(),
  trace: jest.fn(),
  fatal: jest.fn(),
  child: jest.fn().mockReturnThis()
}

export function createRequestLogger() {
  return logger
}

export function generateRequestId() {
  return 'test-req-id-123'
}

export default logger