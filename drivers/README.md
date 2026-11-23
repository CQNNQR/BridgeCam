# Virtual Driver Development

This directory holds the source for the virtual camera/microphone drivers
required by Sprint 6 (Virtual Driver Injection). Each operating system has its
own subfolder with the platform-specific implementation.

## Windows (`drivers/windows`)
- **DirectShow filter** project (`BridgeCamFilter`)
- Shared memory / frame pipe interface that receives raw frames from the
  Tauri desktop client and feeds them to the filter pin.
- Installer scripts (.inf, NSIS) to register the filter as a system webcam.
- `frame_reader` utility for inspecting shared-memory files (built via
  CMake alongside the filter).

## macOS (`drivers/macos`)
- **CoreMediaIO Camera Extension** skeleton.
- IPC mechanism (XPC or shared memory) for receiving frames from the desktop
  app.
- Build instructions using Xcode or `xcodebuild`.

## Linux (`drivers/linux`)
- Scripts to build and install `v4l2loopback` kernel module (`make install`)
  and configure a `BridgeCam` device.
- Helper binaries (C/C++/Rust) that open `/dev/videoN` and write raw YUV frames
  produced by the desktop client (via FIFO or unix socket).

> **Note:** At the moment these folders contain scaffolding only. Actual
> driver code will be developed in subsequent tasks. See sprint 6 progress
> notes in `ROADMAP.md`.
