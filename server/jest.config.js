export default {
  testEnvironment: 'node',
  transform: {},
  moduleFileExtensions: ['js'],
  testMatch: ['**/tests/**/*.test.js'],
  verbose: true,
  clearMocks: true,
  // Mock logger and config to avoid pino dependency issues
  moduleNameMapper: {
    '^./logger.js$': '<rootDir>/tests/__mocks__/logger.js',
    '^./config.js$': '<rootDir>/tests/__mocks__/config.js'
  }
}