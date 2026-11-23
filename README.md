<div align="center">

# BridgeCam

**Turn your phone into a 4K webcam. Free, open source, and private.**

[![License: GPL v3](https://img.shields.io/badge/License-GPLv3-blue.svg)](LICENSE)
[![Build](https://github.com/CQNNQR/BridgeCam/actions/workflows/build.yml/badge.svg)](https://github.com/CQNNQR/BridgeCam/actions/workflows/build.yml)
[![Signaling Server](https://img.shields.io/badge/signaling-live%20on%20Render-brightgreen)](https://bridgecam.onrender.com/health)

</div>

---

## Download

| Platform | Download | Notes |
|----------|----------|-------|
| **Windows 10/11** | [**BridgeCam-Setup.exe**](https://github.com/CQNNQR/BridgeCam/releases/latest) | Installs app + virtual camera driver. Run as admin for best results. |

macOS and Linux builds are in progress — see [ROADMAP.md](ROADMAP.md).

---

## What Is BridgeCam?

BridgeCam turns any smartphone into a high-quality webcam — no app install required on the phone. Open a URL, scan a QR code, and your phone's camera appears as a real webcam in Zoom, OBS, Teams, and any app that supports a camera.

**How it works in 3 steps:**

```
1.  Launch BridgeCam on your PC  →  a QR code appears
2.  Scan QR with your phone       →  tap "Allow Camera"
3.  Your phone is now a webcam   →  select "BridgeCam Source" in Zoom/OBS
```

---

## Why BridgeCam?

| | BridgeCam | EpocCam / DroidCam |
|---|---|---|
| Price | Free | Freemium / paid |
| Source code | Open (GPLv3) | Closed |
| Video path | Direct WebRTC with optional TURN fallback | Cloud relay |
| Accounts required | None | Required |
| Resolution | Up to 4K | 1080p (paid) |
| Phone install | Browser only | App required |
| Audio | Virtual mic (VB-Audio) | Built-in |
| Privacy | End-to-end encrypted video | Unknown |

---

## Features

- **4K / 1080p / 720p** streaming over your local Wi-Fi
- **< 200ms latency** — video takes the shortest path: phone → router → PC
- **Virtual camera driver** — appears as "BridgeCam Source" in every app (Windows; macOS/Linux in progress)
- **Virtual microphone** — phone mic routed through VB-Audio Cable to any app
- **End-to-end encrypted video** — BridgeCam prefers a direct connection and can use a configured TURN relay when needed
- **No accounts, no telemetry, no tracking**
- **PWA — no phone app install** — works in Chrome, Safari, Firefox
- **Advanced camera controls** — exposure, focus, zoom, white balance, torch, remote-controlled from desktop
- **Auto-reconnect** on network drops (ICE restart)
- **Adaptive quality** — auto-reduces bitrate on poor connections
- **Recording** — save clips directly to disk, motion-triggered auto-record
- **Time-lapse** mode
- **Screenshot** capture from the desktop
- **Stealth mode** — screen-off streaming (saves battery)
- **Motion detection** with auto-record and pre-roll buffer
- **Security Cam mode** — view phone feed in any browser, no desktop app needed

---

## Quick Start

### Webcam Mode (Recommended)

1. **Download** [BridgeCam-Setup.exe](https://github.com/CQNNQR/BridgeCam/releases/latest) and run the installer
2. **Launch BridgeCam** from the Start Menu — a QR code appears
3. **Scan the QR code** with your phone — tap **Allow Camera**
4. **Open Zoom / OBS / Teams** and select **BridgeCam Source** as your camera

That's it. The installer registers the virtual camera driver automatically. No signing keys, no terminal commands, no developer tools.

> **Optional:** For virtual microphone support (phone mic → PC), install the free [VB-Audio Cable](https://vb-audio.com/Cable/) and select **CABLE Output** as your mic in Zoom/Teams.

### Security Cam Mode (No Install)

Don't need a virtual webcam? Use BridgeCam as a browser-only security camera:

1. Open **[bridgecam.onrender.com/host](https://bridgecam.onrender.com/host)** on your PC
2. Click **Create Room** — a QR code appears
3. Scan with your phone — tap **Allow Camera**
4. **Done.** View the feed right in your browser.

> **Cold start:** The free-tier server sleeps after 15 min idle. First request may take ~30s.

### Self-Hosted / Developer Setup

<details>
<summary>Click to expand developer instructions</summary>

**Prerequisites:** Node.js 18+, Rust toolchain (for desktop app)

```bash
# Run the signaling server locally
git clone https://github.com/CQNNQR/BridgeCam.git
cd BridgeCam/server
npm install
node src/index.js
# Server running at http://localhost:3000
# Open http://localhost:3000/host on your PC
```

```bash
# Build and run the desktop app from source
cd BridgeCam/desktop
npm install
npm run tauri dev
```

The desktop app auto-connects to the cloud server, creates a room, and shows a QR code. For the virtual camera driver, build from `drivers/windows/` — see [`drivers/windows/README.md`](drivers/windows/README.md).

</details>

---

## Architecture

```
┌──────────────────────────────────────────────────────────┐
│  Phone (PWA)                                             │
│  Chrome / Safari / Firefox — no install required         │
└──────────────┬───────────────────────────────────────────┘
               │  WebSocket (SDP + ICE only)
               ▼
┌──────────────────────────────────────────────────────────┐
│  Signaling Server  (Node.js + ws)                        │
│  bridgecam.onrender.com  — zero video data               │
└──────────────┬───────────────────────────────────────────┘
               │  SDP answer + ICE candidates relayed
               ▼
┌──────────────────────────────────────────────────────────┐
│  Desktop                                                 │
│  ┌───────────────────┐    ┌─────────────────────────┐   │
│  │  Browser (any)    │    │  Tauri App (Webcam Mode) │   │
│  │  Security Cam     │    │  Rust + Webview          │   │
│  └───────────────────┘    └──────────┬──────────────┘   │
│                 WebRTC P2P over LAN  │  Raw NV12 frames  │
│  ◄────────────────────────────────   │                   │
│                                      ▼                   │
│                           ┌──────────────────────┐      │
│                           │  Virtual Camera DLL   │      │
│                           │  BridgeCam Source     │      │
│                           │  (DirectShow / MF)    │      │
│                           └──────────────────────┘      │
└──────────────────────────────────────────────────────────┘
```

**Key design rules:**
- 🚫 Zero video data on the signaling server — only SDP and ICE candidates
- 🏠 ICE priority: `host` → `srflx` → `relay` — LAN always wins
- 🔒 No user accounts, no stored data, no telemetry
- 📵 PWA works offline after initial load (service worker cached)

---

## Project Structure

```
BridgeCam/
├── server/          # Node.js WebSocket signaling server
├── mobile/          # Phone PWA (camera sender)
│   └── public/      # Static files served by signaling server
├── desktop/         # Tauri desktop client (webcam mode)
│   ├── src/         # JS/HTML/CSS frontend
│   └── src-tauri/   # Rust backend
├── drivers/
│   ├── windows/     # DirectShow + IMFVirtualCamera DLL
│   ├── macos/       # CoreMediaIO Camera Extension (WIP)
│   └── linux/       # v4l2loopback setup (WIP)
├── docs/            # Architecture notes, sprint docs
├── ROADMAP.md       # Live development progress tracker
├── THIRD_PARTY_LICENSES.txt
└── LICENSE          # GPLv3
```

---

## Compatibility

| Platform | Webcam Mode | Security Cam Mode |
|---|---|---|
| Windows 10/11 | ✅ Full (DLL driver) | ✅ Any browser |
| macOS | 🔜 In progress | ✅ Any browser |
| Linux | 🔜 In progress | ✅ Any browser |

| Mobile Browser | Camera Access |
|---|---|
| Chrome for Android | ✅ |
| Safari (iOS 15+) | ✅ |
| Firefox for Android | ✅ |
| Samsung Internet | ✅ |

**Video apps tested with BridgeCam Source (Windows):** Zoom, OBS Studio, Microsoft Teams, Google Meet, Discord

---

## Privacy

BridgeCam is **privacy by design**:

- 📡 Video uses an encrypted direct connection where possible. When TURN is configured and a direct connection fails, the TURN server forwards encrypted media.
- 🚫 The signaling server handles **only** connection metadata (SDP/ICE) — no video, no audio
- 🔒 No user accounts, no cookies, no analytics, no crash reporting
- 🗑️ No data is stored anywhere — rooms are ephemeral, in-memory only

See [`PRIVACY.md`](PRIVACY.md) for the full data flow diagram and third-party audit notes.

---

## Contributing

We welcome issues and pull requests! Before contributing, please read:

- [`CONTRIBUTING.md`](CONTRIBUTING.md) — architecture rules, code style, testing guide
- [`ROADMAP.md`](ROADMAP.md) — current sprint priorities and open tasks
- [`CODE_OF_CONDUCT.md`](CODE_OF_CONDUCT.md) — community standards

```bash
# Quick dev setup
cd server && npm install && node src/index.js &
cd desktop && npm install && npm run tauri dev
```

---

## Roadmap

BridgeCam is actively developed. Current phase: **Phase 5 — Ship It 🚀**

Upcoming milestones:
- `v1.0.0` — Windows installer with bundled virtual camera driver
- `v1.1.0` — macOS + Linux driver support
- `v1.2.0` — Multi-camera matrix mode

See [`ROADMAP.md`](ROADMAP.md) for the full sprint-by-sprint breakdown.

---

## License

**GNU General Public License v3.0** — see [`LICENSE`](LICENSE).

If you fork BridgeCam to build a paid product, GPLv3 requires you to open-source your changes under the same license.
