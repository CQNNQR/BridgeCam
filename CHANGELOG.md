# Changelog

All notable changes to BridgeCam are documented here.

---

## [1.0.0] — 2026-03-10 🚀

### First public release — "Ship It"

#### What Is BridgeCam?
Turn your smartphone into a webcam or security camera over your local Wi-Fi — no app install, no accounts, no cloud video.

#### Highlights
- **Webcam Mode** — Phone appears as `BridgeCam Source` in Zoom, OBS, Microsoft Teams, Google Meet, and any DirectShow/Media Foundation app on Windows 10/11
- **Security Cam Mode** — View your phone's camera feed in any browser, no desktop app required
- **Zero cloud video** — WebRTC P2P over LAN; the signaling server only relays connection metadata (SDP/ICE)
- **No phone app install** — Works as a PWA in Chrome, Safari, and Firefox
- **Virtual microphone** — Phone mic routed through VB-Audio Cable to any app

#### Features
- QR code room pairing — scan with phone to connect instantly
- Front / back / telephoto camera selection with live switching
- Resolution selection: 720p / 1080p / 4K
- Frame rate: 30fps / 60fps with adaptive quality
- Advanced camera controls (exposure, focus, zoom, torch, white balance) — remote-controlled from desktop
- Auto-reconnect on network drops (ICE restart)
- Adaptive bitrate on poor connections
- Screen-off streaming (stealth mode, saves battery)
- Screenshot capture from desktop
- Record to local disk (manual + motion-triggered with 5s pre-roll)
- Time-lapse mode
- Motion detection with auto-record
- Dark cyberpunk UI

#### Installer
- **NSIS installer** (recommended) — installs app + automatically registers the virtual camera driver (`BridgeCam Source`) in System32/SysWOW64
- **MSI installer** — alternative for enterprise/GPO deployment
- Requires **Windows 10/11** for virtual camera (Webcam Mode requires Win 11 22H2+ for IMFVirtualCamera)

#### Known Limitations
- Virtual camera driver: Windows only in this release (macOS and Linux in progress)
- Virtual microphone requires [VB-Audio Cable](https://vb-audio.com/Cable/) (free, donationware) — not bundled due to license
- First connection may take ~30s if using the cloud server (Render free tier cold start)

#### Quick Start
1. Download `BridgeCam-Setup-1.0.0_x64-setup.exe` below
2. Run installer as Administrator (needed to register the virtual camera driver)
3. Launch BridgeCam — it shows a QR code automatically
4. Scan with your phone — tap **Allow Camera**
5. Select **BridgeCam Source** in Zoom/OBS/Teams

For self-hosting, see [README.md](https://github.com/CQNNQR/BridgeCam#readme).

---

## [Unreleased]

- macOS CoreMediaIO virtual camera driver
- Linux v4l2loopback integration
- Multi-camera matrix (4 phones simultaneously)
- iOS Safari auto-sleep workaround
