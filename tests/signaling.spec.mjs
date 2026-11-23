import { test, expect } from '@playwright/test';
import { WebSocket } from 'ws';

const BASE = 'http://localhost:3000';

test.describe('HTTP Endpoints', () => {
  test('GET /health returns ok', async ({ page }) => {
    const resp = await page.request.get(BASE + '/health');
    expect(resp.ok()).toBe(true);
    const body = await resp.json();
    expect(body.ok).toBe(true);
    expect(body.uptime).toBeGreaterThan(0);
  });

  test('POST /create-room returns valid room', async ({ page }) => {
    const resp = await page.request.post(BASE + '/create-room');
    expect(resp.ok()).toBe(true);
    const body = await resp.json();
    expect(body.roomId).toMatch(/^[0-9a-f]{8,16}$/);
    expect(body.joinUrl).toContain(body.roomId);
  });

  test('POST /create-room mobileUrl has room param', async ({ page }) => {
    const resp = await page.request.post(BASE + '/create-room');
    const body = await resp.json();
    expect(body.mobileUrl).toContain('room=');
  });

  test('POST /create-room unique IDs', async ({ page }) => {
    const [r1, r2] = await Promise.all([
      page.request.post(BASE + '/create-room'),
      page.request.post(BASE + '/create-room'),
    ]);
    const b1 = await r1.json();
    const b2 = await r2.json();
    expect(b1.roomId).not.toBe(b2.roomId);
  });
});

test.describe('WebSocket Signaling', () => {
  // Correct pattern: persistent listener + array buffer, not once()
  function makeWS(url) {
    const ws = new WebSocket(url);
    const msgs = [];
    ws.on('message', data => msgs.push(JSON.parse(data.toString())));
    return { ws, msgs };
  }

  test('WS: invalid room ID rejected', async () => {
    const { ws, msgs } = makeWS('ws://localhost:3000/ws');
    await new Promise(resolve => ws.on('open', resolve));
    await new Promise(resolve => setTimeout(resolve, 500));
    expect(msgs[0].action).toBe('hello');
    ws.send(JSON.stringify({ action: 'join', roomId: 'test123' }));
    await new Promise(resolve => setTimeout(resolve, 500));
    const err = msgs.find(m => m.action === 'error');
    expect(err).toBeDefined();
    expect(err.message).toBe('invalid-room-id');
    ws.close();
  });

  test('WS: non-existent room returns error', async () => {
    const { ws, msgs } = makeWS('ws://localhost:3000/ws');
    await new Promise(resolve => ws.on('open', resolve));
    await new Promise(resolve => setTimeout(resolve, 500));
    ws.send(JSON.stringify({ action: 'join', roomId: 'deadbeef' }));
    await new Promise(resolve => setTimeout(resolve, 500));
    const err = msgs.find(m => m.action === 'error');
    expect(err).toBeDefined();
    expect(err.message).toBe('room-not-found');
    ws.close();
  });

  test('WS: two-peer join and SDP offer forwarding', async ({ page }) => {
    const roomResp = await page.request.post(BASE + '/create-room');
    const { roomId } = await roomResp.json();

    const desktop = new WebSocket('ws://localhost:3000/ws');
    const desktopMsgs = [];
    desktop.on('message', data => desktopMsgs.push(JSON.parse(data.toString())));
    await new Promise(resolve => desktop.on('open', resolve));
    await new Promise(resolve => setTimeout(resolve, 500));

    const mobile = new WebSocket('ws://localhost:3000/ws');
    const mobileMsgs = [];
    mobile.on('message', data => mobileMsgs.push(JSON.parse(data.toString())));
    await new Promise(resolve => mobile.on('open', resolve));
    await new Promise(resolve => setTimeout(resolve, 500));

    desktop.send(JSON.stringify({ action: 'join', roomId }));
    mobile.send(JSON.stringify({ action: 'join', roomId }));
    await new Promise(resolve => setTimeout(resolve, 1000));

    const dJoined = desktopMsgs.find(m => m.action === 'joined');
    const mJoined = mobileMsgs.find(m => m.action === 'joined');
    expect(dJoined).toBeDefined();
    expect(mJoined).toBeDefined();

    const peerJoined = desktopMsgs.find(m => m.action === 'peer-joined');
    expect(peerJoined).toBeDefined();

    mobile.send(JSON.stringify({ action: 'signal', payload: { type: 'offer', sdp: 'v=0' } }));
    await new Promise(resolve => setTimeout(resolve, 500));
    const offer = desktopMsgs.find(m => m.action === 'signal' && m.payload.type === 'offer');
    expect(offer).toBeDefined();
    expect(offer.payload.type).toBe('offer');

    desktop.close();
    mobile.close();
  });

  test('WS: ICE candidates forwarded', async ({ page }) => {
    const roomResp = await page.request.post(BASE + '/create-room');
    const { roomId } = await roomResp.json();

    const p1 = new WebSocket('ws://localhost:3000/ws');
    const p2 = new WebSocket('ws://localhost:3000/ws');
    const p1Msgs = [];
    const p2Msgs = [];
    p1.on('message', data => p1Msgs.push(JSON.parse(data.toString())));
    p2.on('message', data => p2Msgs.push(JSON.parse(data.toString())));
    await Promise.all([new Promise(r => p1.on('open', r)), new Promise(r => p2.on('open', r))]);
    await new Promise(resolve => setTimeout(resolve, 500));

    p1.send(JSON.stringify({ action: 'join', roomId }));
    p2.send(JSON.stringify({ action: 'join', roomId }));
    await new Promise(resolve => setTimeout(resolve, 1000));

    p1.send(JSON.stringify({ action: 'signal', payload: { type: 'candidate', candidate: {} } }));
    await new Promise(resolve => setTimeout(resolve, 500));

    const ice = p2Msgs.find(m => m.action === 'signal' && m.payload.type === 'candidate');
    expect(ice).toBeDefined();
    expect(ice.payload.type).toBe('candidate');

    p1.close();
    p2.close();
  });
});
