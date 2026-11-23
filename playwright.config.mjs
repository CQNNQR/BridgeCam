import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: './tests',
  fullyParallel: false,        // Server state is shared — run tests serially
  forbidOnly: !!process.env.CI,
  retries: 0,
  workers: 1,
  reporter: [
    ['list'],
    ['html', { open: 'never' }]
  ],
  use: {
    baseURL: 'http://localhost:3000',
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
  ],
  webServer: {
    command: 'node server/src/index.js',
    env: { RATE_LIMIT_MAX_CONNECTIONS_PER_IP: '30' },
    url: 'http://localhost:3000/health',
    reuseExistingServer: !process.env.CI,
    timeout: 15000,
  },
});
