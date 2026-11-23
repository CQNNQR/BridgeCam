import { test, expect } from '@playwright/test';

const BASE = 'http://localhost:3000';

test.describe('Mobile Sender Page (index.html)', () => {

  test.beforeEach(async ({ page }) => {
    page.on('console', msg => {
      if (msg.type() === 'error') {
        console.log(`[BROWSER ERROR] ${msg.text()}`);
      }
    });
    page.on('pageerror', err => {
      console.log(`[PAGE ERROR] ${err.message}`);
    });
  });

  test('index.html loads and shows Start Camera button', async ({ page }) => {
    await page.goto(`${BASE}/`);
    await page.waitForLoadState('networkidle');

    const startBtn = page.locator('#startBtn');
    await expect(startBtn).toBeVisible();
    await expect(startBtn).toContainText('Start Camera');

    const status = page.locator('#status');
    await expect(status).toBeVisible();
  });

  test('index.html with room param loads without errors', async ({ page }) => {
    const roomResp = await page.request.post(`${BASE}/create-room`);
    const { roomId } = await roomResp.json();

    await page.goto(`${BASE}/?room=${roomId}`);
    await page.waitForLoadState('networkidle');

    const status = page.locator('#status');
    await expect(status).toBeVisible();
    const statusText = await status.textContent();
    console.log(`[Status with room=] ${statusText}`);

    // Should NOT show an error
    const errorEl = page.locator('#error');
    const errorVisible = await errorEl.isVisible();
    if (errorVisible) {
      console.log(`[ERROR shown] ${await errorEl.textContent()}`);
    }
  });

  test('camera selector is populated', async ({ page }) => {
    await page.goto(`${BASE}/`);
    await page.waitForLoadState('networkidle');

    const cameraSelect = page.locator('#cameraSelect');
    await expect(cameraSelect).toBeVisible();

    const resSelect = page.locator('#resolutionSelect');
    await expect(resSelect).toBeVisible();

    const fpsSelect = page.locator('#frameRateSelect');
    await expect(fpsSelect).toBeVisible();
  });

});
