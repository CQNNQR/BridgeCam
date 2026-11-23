import { test, expect } from '@playwright/test'

test.use({
  launchOptions: {
    args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream']
  }
})

test.beforeEach(async ({ context }) => {
  await context.route('https://fonts.googleapis.com/**', route => route.abort())
})

async function expectCameraFrames(page) {
  await expect.poll(() => page.locator('#remote').evaluate(video => {
    if (video.readyState < HTMLMediaElement.HAVE_CURRENT_DATA || !video.videoWidth) return 0
    const canvas = document.createElement('canvas')
    canvas.width = canvas.height = 32
    const context = canvas.getContext('2d')
    context.drawImage(video, 0, 0, 32, 32)
    const pixels = context.getImageData(0, 0, 32, 32).data
    return pixels.filter((value, index) => index % 4 === 0 && value > 16).length
  }), { timeout: 20000 }).toBeGreaterThan(50)
}

test('Host opens a receiver tab without occupying a room slot in the background', async ({ page, context }) => {
  await page.goto('/host')
  await page.locator('#createRoom').click()
  const link = page.locator('#urlList .url-link').first()
  await expect(link).toBeVisible()
  const [receiver] = await Promise.all([
    context.waitForEvent('page'),
    page.locator('#openReceiverTabBtn').click()
  ])
  await expect(receiver.locator('#status')).toHaveText('Waiting for camera…')
  const sender = await context.newPage()
  const room = await page.locator('#roomIdChip').textContent()
  await sender.goto('/?room=' + room)
  await sender.locator('#startBtn').click()
  await expectCameraFrames(receiver)
  await expect(sender.locator('#status')).toHaveText('Connection: connected')

  const cameraTrack = () => sender.locator('#preview').evaluate(video => {
    const track = video.srcObject?.getVideoTracks()[0]
    return track && { id: track.id, ...track.getSettings() }
  })
  const original = await cameraTrack()
  await sender.locator('#resolutionSelect').selectOption('720')
  await sender.locator('#frameRateSelect').selectOption('15')
  await expect.poll(async () => {
    const capture = await cameraTrack()
    return capture && { id: capture.id, frameRate: capture.frameRate }
  }).toEqual({ id: original.id, frameRate: 15 })
  await expectCameraFrames(receiver)
})

test('sender waits for a late receiver and resumes when the receiver tab is replaced', async ({ page, context }) => {
  const response = await page.request.post('/create-room')
  const { roomId } = await response.json()
  await page.goto('/?room=' + roomId)
  await page.locator('#startBtn').click()
  await expect(page.locator('#status')).toHaveText('Waiting for receiver…')

  const receiver = await context.newPage()
  await receiver.goto('/receiver?room=' + roomId)
  await expectCameraFrames(receiver)
  await receiver.close()
  await expect(page.locator('#status')).toHaveText('Waiting for receiver…')

  const replacement = await context.newPage()
  await replacement.goto('/receiver?room=' + roomId)
  await expectCameraFrames(replacement)
  await expect(page.locator('#error')).toBeHidden()
})

test('local camera test opens the paired tabs and repeated Join clicks preserve the stream', async ({ page, context }) => {
  await page.goto('/host')
  await page.locator('#createRoom').click()
  const [sender] = await Promise.all([
    context.waitForEvent('page'),
    page.locator('#localCameraTest').click()
  ])
  await expect(sender.locator('#cameraSelect option')).toHaveText('Simulated camera')
  await expectCameraFrames(page)
  const stream = await page.locator('#remote').evaluate(video => video.srcObject.id)
  for (let count = 0; count < 12; count++) {
    await page.locator('#joinBtn').click()
  }
  expect(await page.locator('#remote').evaluate(video => video.srcObject?.id)).toBe(stream)
  await page.reload()
  await expectCameraFrames(page)
  await expect(page.locator('#error')).toBeHidden()
})

test('receiver respects the signaling server cooldown after a connection rejection', async ({ page }) => {
  await page.clock.install()
  let attempts = 0
  await page.routeWebSocket('**/ws', socket => {
    const attempt = ++attempts
    socket.onMessage(() => {
      if (attempt === 1) {
        socket.send(JSON.stringify({ action: 'error', message: 'too-many-connections', retryAfter: 5 }))
        socket.close({ code: 1013 })
      } else {
        socket.send(JSON.stringify({ action: 'joined', peerCount: 1 }))
      }
    })
  })
  await page.goto('/receiver?room=cooldown-test')
  await expect(page.locator('#status')).toHaveText('Server busy — retrying in 5 seconds')
  await page.locator('#joinBtn').click()
  await page.clock.runFor(2000)
  expect(attempts).toBe(1)
  await page.clock.runFor(3500)
  await expect(page.locator('#status')).toHaveText('Waiting for camera…')
  expect(attempts).toBe(2)
})
