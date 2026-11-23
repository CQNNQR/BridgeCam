# BridgeCam — Copilot Instructions

## MANDATORY: Pre-Task Protocol

**Before executing ANY coding task, you MUST:**

1. **Read the roadmap** — Open and read `ROADMAP.md` in the project root to understand current progress, what has been completed, what is in progress, and what remains.
2. **Identify the relevant sprint/task** — Determine which roadmap task(s) the current work corresponds to.
3. **Confirm context** — Reference the roadmap status in your response so the user knows you're aligned.

## MANDATORY: Post-Task Protocol

**After completing ANY coding task, you MUST:**

1. **Update `ROADMAP.md`** — Change the status of completed task(s) from `:white_large_square:` to `:white_check_mark:` and in-progress tasks to `:construction:`.
2. **Update sprint status** — If all tasks in a sprint are done, update the sprint's overall status line.
3. **Update phase status** — If all sprints in a phase are done, update the phase's overall status line.
4. **Update the "Last Updated" date** at the top of the roadmap.
5. **Add a Change Log entry** at the bottom of `ROADMAP.md` with the date, a brief description of what was done, and "Copilot" as the author.
6. **Update `README.md` feature checklist** if a user-visible feature was completed (change `- [ ]` to `- [x]`).

## Project Context

**BridgeCam** is an open-source tool that turns smartphones into webcams/security cameras via WebRTC over LAN.

### Key Technical Decisions (Do Not Deviate Without User Approval)
- **Mobile:** Vanilla JS PWA (no heavy frameworks — performance is paramount)
- **Desktop Client:** Tauri (Rust + Webview) — NOT Electron
- **Signaling Server:** Node.js + WebSocket (`ws` library)
- **Video Codecs:** VP8/VP9 default, H.264 optional (patent-free priority)
- **Connection Strategy:** LAN P2P first, STUN fallback, TURN last resort
- **License:** GPLv3
- **UI Theme:** Dark/Cyberpunk/Minimalist — neon accents, deep blacks

### Architecture Rules
1. **Zero video data on the signaling server** — Only SDP and ICE candidates are relayed.
2. **ICE candidate priority:** `host` > `srflx` > `relay` — Always prefer local network.
3. **No user accounts or stored data** — Privacy by design.
4. **PWA must work offline** after initial load (service worker caching).
5. **Bundle size matters** — Every dependency must justify its inclusion.

### File Structure Reference
```
BridgeCam/
├── server/          # Node.js WebSocket signaling server
├── mobile/          # Phone PWA (camera sender)
├── desktop/         # Tauri desktop client (webcam mode)
├── drivers/         # Virtual camera/mic drivers per OS
├── docs/            # Documentation
├── ROADMAP.md       # THE source of truth for progress
└── README.md        # Project overview
```

### Code Style Preferences
- **JavaScript:** ES Modules, no semicolons optional (user preference), modern APIs
- **CSS:** CSS custom properties for theming, GPU-accelerated animations only
- **Rust (Tauri):** Follow standard Rust conventions, `clippy` clean
- **Comments:** Explain *why*, not *what* — the code should be self-documenting
- **Error Handling:** Always handle camera permission denials, WebRTC failures, and WebSocket disconnects gracefully with user-friendly messages

### Testing Approach
- Test WebRTC connections on same-machine (localhost) during development
- Test LAN connections with at least one physical phone + PC
- Browser targets: Chrome 90+, Safari 15+, Firefox 90+, Edge 90+

## Workflow Example

```
User: "Set up the signaling server"

Copilot:
1. [Reads ROADMAP.md] → Sprint 1 is "Not Started"
2. [Implements server/src/index.js, room.js, signaling.js, package.json]
3. [Updates ROADMAP.md]:
   - Tasks 1.1-1.7: ✅
   - Sprint 1 Status: ✅ Completed
   - Change Log: "2026-02-15 | Implemented signaling server | Copilot"
4. [Reports to user with roadmap context]
```
