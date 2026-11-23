# BridgeCam — Privacy Statement

> **Last Updated:** 2026-03-10

BridgeCam is designed from the ground up with privacy as a first principle. This document explains exactly what data BridgeCam collects, transmits, and stores — which is as close to nothing as technically possible.

---

## The Short Version

- **No user accounts.** No sign-up, no login, no email address required.
- **No telemetry.** BridgeCam never phones home, sends usage statistics, or reports errors to a server.
- **End-to-end encrypted video.** BridgeCam prefers a direct connection. When a direct connection fails, a configured TURN relay can forward the encrypted media.
- **No cookies.** The signaling server does not set any cookies.
- **No tracking.** No analytics, no third-party SDKs, no advertising.
- **No persistent storage.** The signaling server stores nothing to disk about you or your sessions.

---

## How BridgeCam Works (Data Flow)

```
Phone Camera
    │
    │  Encrypted WebRTC
    │  Direct connection or configured TURN relay
    ▼
PC Desktop App
    │
    │  Shared memory (local, in-process)
    │  No network involved
    ▼
Virtual Camera Driver
(appears as "BridgeCam Source" in Zoom/OBS/Teams)
```

The **Signaling Server** (hosted at `bridgecam.onrender.com`) receives connection metadata:

| Data | Purpose | Retained? |
|------|---------|-----------|
| Room code (10-char hex, e.g. `a3f9c21b04`) | Match phone to PC | Only in RAM, deleted when session ends |
| WebRTC SDP offer/answer | Describe media format; relayed to the other peer | Never stored — relayed and forgotten |
| ICE candidates (local LAN IP addresses) | Help peers find each other on the LAN | Never stored — relayed and forgotten |
| Your public IP address | Standard TCP/IP; visible in server logs for rate limiting | Not logged to disk; in-memory only for rate-limit counters |

**The signaling server never sees, touches, or stores any audio or video data.** It is a simple relay for connection setup only.

---

## Video & Audio Data

All video and audio streams are:

1. **Encrypted in transit** — WebRTC mandates DTLS-SRTP encryption for all media. BridgeCam verifies this on connection.
2. **Direct when available** — WebRTC prefers the local network. If a direct connection is unavailable, a configured TURN relay can forward the media over the internet. The relay cannot decrypt the media.
3. **Never recorded by BridgeCam** — The app does not record or upload your stream. The optional "Record" feature in the desktop app saves files **directly to your PC's local disk** — no upload, no cloud.

---

## Local Storage

The desktop app stores the following **only on your PC**, never transmitted anywhere:

| Data | Location | Purpose |
|------|----------|---------|
| App settings | `localStorage` in the Tauri webview | Your preferences (quality tier, accent color, etc.) |
| Recent room history | `localStorage` in the Tauri webview | Quick rejoin for recent sessions |
| Shared memory frame buffer | `C:\ProgramData\BridgeCam\framebuffer.dat` | Pass video frames to the virtual camera driver |
| Recordings & screenshots | Your chosen save directory | Files you explicitly save — you control these |

You can clear all stored data by clicking **Reset All Settings** in the Settings panel, or by deleting the app's data directory.

---

## Third-Party Services

| Service | Purpose | Data Shared |
|---------|---------|-------------|
| Render (render.com) | Hosts the signaling server | Your IP address (standard TCP) — see Render's [Privacy Policy](https://render.com/privacy) |

No other third-party services are used. There are no analytics providers, no CDN (assets are bundled), and no external API calls.

---

## VB-Audio Cable (Optional)

BridgeCam's audio piping feature works with [VB-Audio Cable](https://vb-audio.com/Cable/), a separate third-party application. VB-Audio Cable has its own privacy policy. BridgeCam does not share any data with VB-Audio.

---

## Children's Privacy

BridgeCam does not knowingly collect any information from children. The app has no accounts and collects no personal data from any user.

---

## Open Source Transparency

BridgeCam is fully open source under the [GNU GPLv3 license](LICENSE). You can review every line of code that runs on your devices at [https://github.com/CQNNQR/BridgeCam](https://github.com/CQNNQR/BridgeCam). There are no hidden code paths.

---

## Contact

If you have privacy questions or concerns, open an issue on the [GitHub repository](https://github.com/CQNNQR/BridgeCam/issues).
