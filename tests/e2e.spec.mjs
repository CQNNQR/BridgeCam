import { test, expect } from '@playwright/test';
import { WebSocket } from 'ws';

const BASE = 'http://localhost:3000';

test.describe('Full Connection Flow', () => {

  test('Desktop WS joins first, then Mobile WS joins and SDP flows', async ({ page }) => {
    // Step 1: Create room via HTTP
    const roomResp = await page.request.post(`${BASE}/create-room`);
    expect(roomResp.ok()).toBe(true);
    const { roomId } = await roomResp.json();
    console.log(`[Room] ${roomId}`);

    // Step 2: Desktop joins via WebSocket
    const desktopWs = new WebSocket('ws://localhost:3000/ws');
    const desktopMsgs = [];
    desktopWs.on('message', data => {
      console.log('[Desktop RAW]', data.toString().substring(0, 100));
      desktopMsgs.push(JSON.parse(data.toString()));
    });
    await new Promise(resolve => desktopWs.on('open', resolve));
    await new Promise(resolve => setTimeout(resolve, 1000));
    console.log('[Desktop msgs count]', desktopMsgs.length);

    const helloMsg = desktopMsgs[0];
    expect(helloMsg.action).toBe('hello');
    console.log(`[Desktop clientId] ${helloMsg.clientId}`);

    desktopWs.send(JSON.stringify({ action: 'join', roomId }));
    await new Promise(resolve => setTimeout(resolve, 500));

    const joinedMsg = desktopMsgs.find(m => m.action === 'joined');
    expect(joinedMsg).toBeDefined();
    expect(joinedMsg.roomId).toBe(roomId);

    // Step 3: Mobile joins via WebSocket
    const mobileWs = new WebSocket('ws://localhost:3000/ws');
    const mobileMsgs = [];
    mobileWs.on('message', data => {
      const msg = JSON.parse(data.toString());
      console.log('[Mobile RAW]', data.toString().substring(0, 100));
      mobileMsgs.push(msg);
    });
    await new Promise(resolve => mobileWs.on('open', resolve));
    await new Promise(resolve => setTimeout(resolve, 2000));
    console.log('[Mobile msgs count]', mobileMsgs.length);

    const mobileHello = mobileMsgs[0];
    expect(mobileHello).toBeDefined();
    expect(mobileHello.action).toBe('hello');

    mobileWs.send(JSON.stringify({ action: 'join', roomId }));
    await new Promise(resolve => setTimeout(resolve, 1500));

    const mobileJoined = mobileMsgs.find(m => m.action === 'joined');
    expect(mobileJoined).toBeDefined();

    // Step 4: Desktop receives peer-joined
    const peerJoined = desktopMsgs.find(m => m.action === 'peer-joined');
    expect(peerJoined).toBeDefined();
    console.log('[Desktop] Received peer-joined notification');

    // Step 5: Mobile sends SDP offer
    const sdpOffer = {
      type: 'offer',
      sdp: `v=0\r
o=- 1234567890 2 IN IP4 127.0.0.1\r
s=Playwright Test\r
c=IN IP4 0.0.0.0\r
t=0 0\r
m=video 9 UDP/TLS/RTP/SAVPF 96\r
c=IN IP4 0.0.0.0\r
a=rtcp-mux\r
a=rtpmap:96 VP8/90000\r
`
    };
    mobileWs.send(JSON.stringify({ action: 'signal', payload: sdpOffer }));

    // Step 6: Desktop receives the SDP offer
    await new Promise(resolve => setTimeout(resolve, 500));
    const receivedOffer = desktopMsgs.find(m => m.action === 'signal' && m.payload.type === 'offer');
    expect(receivedOffer).toBeDefined();
    expect(receivedOffer.payload.type).toBe('offer');
    console.log('[Desktop] Received SDP offer from mobile');

    // Step 7: Desktop sends SDP answer
    const sdpAnswer = {
      type: 'answer',
      sdp: `v=0\r
o=- 9876543210 2 IN IP4 127.0.0.1\r
s=Playwright Test Answer\r
c=IN IP4 0.0.0.0\r
t=0 0\r
m=video 9 UDP/TLS/RTP/SAVPF 96\r
c=IN IP4 0.0.0.0\r
a=rtcp-mux\r
a=rtpmap:96 VP8/90000\r
`
    };
    desktopWs.send(JSON.stringify({ action: 'signal', payload: sdpAnswer }));

    // Step 8: Mobile receives the SDP answer
    await new Promise(resolve => setTimeout(resolve, 500));
    const receivedAnswer = mobileMsgs.find(m => m.action === 'signal' && m.payload.type === 'answer');
    expect(receivedAnswer).toBeDefined();
    expect(receivedAnswer.payload.type).toBe('answer');
    console.log('[Mobile] Received SDP answer from desktop');

    // Step 9: ICE candidate forwarding
    const iceCandidate = {
      type: 'candidate',
      candidate: {
        candidate: 'candidate:1 1 UDP 2130378527 192.168.1.100 12345 typ host',
        sdpMid: '0',
        sdpMLineIndex: 0
      }
    };
    mobileWs.send(JSON.stringify({ action: 'signal', payload: iceCandidate }));

    await new Promise(resolve => setTimeout(resolve, 500));
    const receivedIce = desktopMsgs.find(m => m.action === 'signal' && m.payload.type === 'candidate');
    expect(receivedIce).toBeDefined();
    expect(receivedIce.payload.type).toBe('candidate');
    console.log('[Desktop] Received ICE candidate from mobile');

    desktopWs.close();
    mobileWs.close();
    console.log('[PASS] Full signaling flow verified');
  });

  test('index.html (mobile) is served at / and has Start Camera button', async ({ page }) => {
    const roomResp = await page.request.post(`${BASE}/create-room`);
    const { roomId } = await roomResp.json();
    await page.goto(`${BASE}/?room=${roomId}`, { timeout: 5000 });
    const startBtn = page.locator('#startBtn');
    await expect(startBtn).toBeVisible({ timeout: 5000 });
    console.log(`[PASS] index.html loaded with room=${roomId}`);
  });

});
