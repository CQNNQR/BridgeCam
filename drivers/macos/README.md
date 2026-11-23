# macOS Driver Skeleton

This directory will eventually contain the CoreMediaIO Camera Extension
project that provides a virtual camera named "BridgeCam Source".

For now:

* Create an Xcode project or use `cmake` with `CMakeLists.txt` for an
  Objective-C/Swift extension.  A minimal stub (`BridgeCamExtension.m`) is
  already provided under `BridgeCamExtension/` which compiles to a dummy
  module and includes the basic plug-in factory entry point.
* The extension will communicate with the desktop app via XPC or a named
  shared memory segment (`/tmp/bridgecam_shm_*`).  The desktop client
  already exposes an API for creating and writing these files, so the
  extension can open the same path and map it.
* Build and sign instructions will be added later.
