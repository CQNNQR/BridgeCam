# Contributing to BridgeCam

Thank you for your interest in contributing to BridgeCam! This document outlines the process for contributing and the standards we hold ourselves to.

---

## Code of Conduct

This project adheres to the [Contributor Covenant Code of Conduct](CODE_OF_CONDUCT.md). By participating, you are expected to uphold this code.

---

## Getting Started

### Prerequisites

- **Node.js** 18+ (for the signaling server)
- **Rust** 1.77+ with `cargo` (for the Tauri desktop app)
- **Tauri CLI** — `cargo install tauri-cli`
- **Windows 10/11** (for virtual camera development; other OS for macOS/Linux drivers)
- A phone with Chrome Android or Safari iOS for testing

### Local Development Setup

```bash
# 1. Clone the repository
git clone https://github.com/CQNNQR/BridgeCam.git
cd BridgeCam

# 2. Start the signaling server
cd server
npm install
node src/index.js
# Server runs at http://localhost:3000

# 3. In a new terminal, start the desktop app (dev mode)
cd desktop
npm install
npm run tauri dev
```

The desktop app auto-connects to `localhost:3000` in dev mode.

---

## How to Contribute

### Reporting Bugs

Use the [Bug Report](https://github.com/CQNNQR/BridgeCam/issues/new?template=bug_report.md) issue template. Include:

- Your OS version
- Steps to reproduce
- Expected vs actual behavior
- Console logs (open DevTools with `F12` in the Tauri window)

### Suggesting Features

Use the [Feature Request](https://github.com/CQNNQR/BridgeCam/issues/new?template=feature_request.md) template. Check that the feature aligns with the [Architecture Rules](#architecture-rules) before submitting.

### Submitting a Pull Request

1. **Fork** the repository and create your branch from `main`:
   ```bash
   git checkout -b feature/your-feature-name
   ```
2. **Make your changes** — keep commits focused and atomic.
3. **Test your changes** — see the [Testing](#testing) section.
4. **Open a Pull Request** against `main`. Use the PR template.

---

## Architecture Rules

These are non-negotiable constraints that keep BridgeCam true to its privacy-first design:

1. **Zero video data on the signaling server** — Only SDP and ICE candidates are relayed. Never log or store any media content.
2. **No user accounts or stored personal data** — Privacy by design. No emails, no IDs.
3. **ICE candidate priority: `host` > `srflx` > `relay`** — Always prefer LAN paths.
4. **PWA must work offline** after initial load (service worker caching).
5. **Bundle size matters** — Every new dependency must justify itself. Avoid adding npm packages for things that can be done with native browser APIs.
6. **Mobile client: Vanilla JS only** — No frameworks. Performance on low-end phones is paramount.
7. **Desktop client: Tauri only** — Not Electron. Memory footprint and startup time matter.

---

## Code Style

### JavaScript (Server + Mobile + Desktop)

- **ES Modules** (`import`/`export`) — no CommonJS
- Modern browser APIs — target Chrome 90+, Safari 15+, Firefox 90+
- Comments explain **why**, not what — the code should be self-documenting
- No semicolons (optional, follow existing file style)
- Error handling: always handle camera permission denials, WebRTC failures, and WebSocket disconnects with user-friendly messages

### Rust (Tauri Backend)

- Follow standard Rust conventions
- Code must pass `cargo clippy` with no warnings
- Keep the `[profile.dev] opt-level = 1` (critical for 8MB/frame IPC performance — see Cargo.toml)
- Document any `unsafe` blocks with a clear safety comment

### CSS

- CSS custom properties for all theming — no hardcoded colors
- GPU-accelerated animations only: `transform` and `opacity`. Never `top`/`left`/`width` in animations.
- Follow the existing design system (`--accent`, `--bg`, `--surface`, etc.)

### C++ (Virtual Camera Driver)

- Target MSVC with C++17
- Follow the existing Windows SDK patterns in `BridgeCamMFSource.cpp`
- All COM interface implementations must be complete (no stub `E_NOTIMPL` on required methods)

---

## Testing

### WebRTC (Core Functionality)
- Test WebRTC connections on localhost (both peers on same machine) during development
- Test on actual LAN with a physical phone + PC before submitting

### Browser Targets
| Browser | Minimum Version |
|---------|----------------|
| Chrome / Edge | 90+ |
| Safari | 15+ |
| Firefox | 90+ |

### Virtual Camera
- Verify the virtual camera appears in `OBS Studio` (DirectShow + Media Foundation)
- Verify the virtual camera appears in Zoom and Microsoft Teams
- Use `smoke_test.ps1` in `drivers/windows/` for automated DLL verification

### Before Submitting a PR
```bash
# Server
cd server && npm audit  # 0 vulnerabilities required

# Desktop
cd desktop/src-tauri && cargo clippy  # no warnings
cd desktop/src-tauri && cargo check   # compiles clean
```

---

## Project Structure

```
BridgeCam/
├── server/          # Node.js WebSocket signaling server
│   └── src/
│       ├── index.js      # Express + WebSocket entry point
│       ├── room.js       # Room management
│       └── signaling.js  # SDP/ICE relay logic
├── mobile/          # Phone PWA (camera sender)
│   └── public/
│       ├── index.html    # Main phone UI
│       ├── src/
│       │   ├── app.js    # Camera + WebRTC sender
│       │   └── camera.js # MediaDevices + constraints
│       └── sw.js         # Service worker (offline support)
├── desktop/         # Tauri desktop client (webcam receiver)
│   ├── src/          # Frontend JS/HTML/CSS
│   └── src-tauri/    # Rust backend
│       └── src/
│           ├── main.rs          # Entry point
│           ├── lib.rs           # Tauri commands + frame pipe
│           ├── frame_socket.rs  # WebSocket frame server (LAN bypass)
│           ├── audio_socket.rs  # Virtual mic (VB-Audio Cable)
│           ├── virtual_cam.rs   # IMFVirtualCamera activation
│           └── signaling_server.rs  # Auto-start Node.js server
├── drivers/         # Virtual camera/mic drivers per OS
│   ├── windows/     # DirectShow + MF virtual camera
│   ├── macos/       # CoreMediaIO Camera Extension (WIP)
│   └── linux/       # v4l2loopback (planned)
├── ROADMAP.md       # Development progress tracker
├── RELEASE.md       # v1.0 release plan
└── README.md        # Project overview
```

---

---

## Making a Release

This project uses an annotated tag-based release tagging system. Tags are pushed to `origin` and trigger the GitHub Actions [`release.yml`](.github/workflows/release.yml) workflow, which builds the Tauri installer and publishes a GitHub Draft Release.

### Prerequisites

Before making a release, ensure:

1. **All CI checks pass** on `main` — Rust check, clippy, and npm audit must all be green.
2. **Version is bumped** — Update the version in:
   - `desktop/src-tauri/Cargo.toml` (`[package]` → `version`)
   - `desktop/package.json` (`"version"`)
3. **Changelog entry added** — Add a dated entry to `CHANGELOG.md` describing everything in this release.
4. **ROADMAP.md updated** — Move the version from "In Progress" to "Released" in the Release Milestones table. Add a change log entry.
5. **Commit the version bump** — The tag must point to a commit that has the version number already bumped.

### Tag Release Script

Use `scripts/tag-release.sh` from the repository root:

```bash
./scripts/tag-release.sh <version>
# e.g.
./scripts/tag-release.sh 1.0.1
```

The script:
1. Validates the version argument against semver format (`MAJOR.MINOR.PATCH`).
2. Creates an annotated tag: `git tag -a v<version> -m "Release v<version>"`
3. Pushes the tag to `origin`: `git push origin v<version>`

If the version argument is missing or malformed, the script prints usage and exits non-zero.

### Expected Tag Format

Tags must match the pattern `v*.*.*` (e.g. `v1.0.0`, `v1.0.1`, `v2.0.0`). The GitHub Actions workflow triggers on tags matching `v*.*.*`.

### After Pushing the Tag

The `release.yml` workflow will:
1. Run `cargo tauri build` to produce the NSIS `.exe` and `.msi` installers.
2. Create a GitHub Draft Release with the artifacts attached.
3. Upload a `latest.json` update manifest.

Review the draft release, edit the description with release notes from `CHANGELOG.md`, and publish it.

### Re-tag If Needed

If you make a mistake, delete the local and remote tag and re-tag:

```bash
git tag -d v1.0.1
git push origin --delete v1.0.1
# ... fix the issue, commit, then ...
./scripts/tag-release.sh 1.0.1
```

---

## License

By contributing to BridgeCam, you agree that your contributions will be licensed under the [GNU General Public License v3.0](LICENSE).
