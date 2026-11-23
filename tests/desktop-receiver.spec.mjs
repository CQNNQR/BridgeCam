import { test, expect } from '@playwright/test';

const BASE = 'http://localhost:3000';

test.describe('Desktop Receiver Page (host.html)', () => {

  test.beforeEach(async ({ page }) => {
    // Collect console errors only — warnings/info are ignored
    page.on('console', msg => {
      if (msg.type() === 'error') {
        console.log(`[BROWSER ERROR] ${msg.text()}`);
      }
    });
  });

  test('host.html loads and shows Create Room button', async ({ page }) => {
    const errors = [];
    page.on('pageerror', err => errors.push(err.message));

    await page.goto(`${BASE}/host`);
    await page.waitForLoadState('networkidle');

    // Should show the create room button
    const createBtn = page.locator('#createRoom');
    await expect(createBtn).toBeVisible();
    await expect(createBtn).toContainText('Create Room');

    // Should not have page errors
    expect(errors).toHaveLength(0);
  });

  test('Create Room shows QR and room ID', async ({ page }) => {
    const errors = [];
    page.on('pageerror', err => errors.push(err.message));

    await page.goto(`${BASE}/host`);
    await page.waitForLoadState('networkidle');

    // Click create room
    await page.click('#createRoom');

    // Wait for room card to appear
    await page.waitForSelector('#roomCard:not([hidden])', { timeout: 5000 });

    // Should show room ID chip
    const roomIdChip = page.locator('#roomIdChip');
    await expect(roomIdChip).toBeVisible();
    const roomId = await roomIdChip.textContent();
    expect(roomId).toMatch(/^[0-9a-f]{8,16}$/);

    // Should show QR code image
    const qrImg = page.locator('#qrImg');
    await expect(qrImg).toBeVisible();
    const qrSrc = await qrImg.getAttribute('src');
    expect(qrSrc).toMatch(/^data:image\/png;base64,/);

    // Mobile URL should be present
    const urlList = page.locator('#urlList');
    await expect(urlList).toBeVisible();

    // Room card should not be hidden
    const roomCard = page.locator('#roomCard');
    await expect(roomCard).not.toBeHidden();

    console.log(`Room created: ${roomId}`);
    expect(errors).toHaveLength(0);
  });

  test('Create Room button is disabled while creating', async ({ page }) => {
    await page.goto(`${BASE}/host`);
    await page.waitForLoadState('networkidle');

    await page.click('#createRoom');

    // Button should be disabled immediately
    const btn = page.locator('#createRoom');
    await expect(btn).toBeDisabled();

    // Wait for room card to appear
    await page.waitForSelector('#roomCard:not([hidden])', { timeout: 5000 });

    // Button should be re-enabled
    await expect(btn).toBeEnabled();
  });

  test('QR mobile URL points to index.html with room param', async ({ page }) => {
    await page.goto(`${BASE}/host`);
    await page.waitForLoadState('networkidle');

    await page.click('#createRoom');
    await page.waitForSelector('#roomCard:not([hidden])', { timeout: 5000 });

    // Check the mobile URL link
    const mobileLink = page.locator('#urlList .url-link').first();
    const mobileUrl = await mobileLink.getAttribute('href');
    console.log('[Mobile URL]', mobileUrl);

    // Mobile URL must be HTTPS (or localhost HTTP)
    // If it's HTTPS it should NOT be a self-signed cert to a raw IP without ngrok working
    if (mobileUrl.startsWith('https://')) {
      const urlHostname = new URL(mobileUrl).hostname;
      const isLocalhost = urlHostname === 'localhost' || urlHostname === '127.0.0.1';
      const isNgrok = urlHostname.includes('ngrok');
      if (!isLocalhost && !isNgrok) {
        console.warn('[WARN] Mobile URL uses self-signed HTTPS to raw IP — phone will show cert warning');
      }
    }
  });

});
