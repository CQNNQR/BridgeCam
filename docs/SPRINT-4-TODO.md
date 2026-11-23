# Sprint 4 — Latency Tuning (In Progress)

**Last updated:** 2026-02-16
**Owner:** Copilot

## Goal
Reduce end-to-end latency to <200ms on LAN and provide developer-visible latency metrics.

## Tasks (actionable)
- [x] 4.4 — Tune `maxBitrate` for LAN (sender)
  - Implemented best-effort `RTCRtpSender.setParameters()` to request higher maxBitrate per resolution.
  - File: `mobile/public/src/app.js`

- [x] 4.5 — Latency measurement overlay (debug mode)
  - Implemented ping/pong RTT overlay using signaling messages.
  - Files: `mobile/public/src/receiver.js`, `mobile/public/receiver.html`

- [x] 4.1 — Disable audio processing (echo cancel / noise suppression)
  - Added audio constraints to explicitly disable browser audio processing when audio is enabled (applyConstraints + getUserMedia).

- [x] 4.2 — Prefer VP8 codec when no HW accel
  - Implemented VP8 fallback using `RTCRtpSender.setCodecPreferences()` when H.264 is not selected.

- [x] 4.3 — Prefer H.264 when HW accel available
  - Implemented best-effort H.264 preference when platform hints at HW support (heuristic) using `setCodecPreferences()`. (TBD: extend with per‑platform probing)

- [ ] 4.6 — Frame rate optimization (target 30/60fps)
  - Added frame-rate selector (30/60) and sender auto-fallback to 30fps on encoder overload — **in progress**
  - Next: add adaptive frame-rate based on real-time motion detection and add receiver-driven feedback loop

## Next actions (priority)
1. Implement `frameRate` constraint selector and measure actual frame delivery on receiver. (4.6)  
2. Add codec-preference toggle + tests (4.2 / 4.3).  
3. Add a debug mode toggle for latency overlay and verbose stats (optional).

---

If you'd like, I can start 4.6 (frame-rate constraints) now — say "start frame-rate tuning" and I'll implement it.