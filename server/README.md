BridgeCam — Signaling Server

Minimal Node.js + WebSocket signaling server used only for SDP/ICE exchange.

Quick start

1. cd server
2. npm install
3. npm start

Endpoints
- HTTP: POST /create-room  -> returns JSON { roomId, joinUrl, qr }
- WS: ws://<host>:<port>/ws  -> WebSocket endpoint for signaling messages

Security
- This server relays only SDP and ICE (no media)
- Use WSS/TLS in production

Cross-network connections

Direct WebRTC is preferred. For phones on cellular or networks that block direct peer connections, configure a TURN service that supports time-limited HMAC credentials, such as coturn with `use-auth-secret`.

- Set `TURN_URLS` to a comma-separated list of the relay's `turn:` or `turns:` URLs. Include TLS over TCP port 443 where available.
- Set `TURN_SECRET` to the relay's shared secret in the signaling server environment. Clients receive individual credentials through signaling after joining a room.
- Verify the deployment from a browser configured with `iceTransportPolicy: 'relay'` before relying on the relay for cellular connections.
