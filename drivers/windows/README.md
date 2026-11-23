# Windows Driver

This directory contains the source code and installer scripts for the
BridgeCam virtual camera filter on Windows.

## Build

Requires Visual Studio with Windows SDK.  A minimal stub implementation is
currently provided so the project builds without the full DirectShow base
classes.

```powershell
cd drivers\windows
mkdir build
cd build
cmake ..
cmake --build . --config Debug
```

`BridgeCamFilter.dll` and `frame_reader.exe` will appear in
`build\Debug`.

## Installing the filter

There are two installation options:

1. **INF-based**: run `install.inf` as administrator (`right-click > Install`).
   This copies the DLL to `%SystemRoot%\System32` and registers the COM class.

2. **NSIS installer**: build `installer.nsi` using NSIS and run the generated
   executable.  It copies the DLL to a subfolder of `Program Files` and runs
   `regsvr32` to register it.  The uninstaller removes the registration.

Both methods add the filter to the **Video Capture Device** category so it
appears as a webcam source in applications like Zoom/OBS.

## Notes

* The filter now reads RGBA frames from a shared-memory file created by
  the desktop app.  Set the `BRIDGECAM_SHM` environment variable to the
  path returned by the app before starting any DirectShow graph (or install
  system-wide via the registry).  You can also set `BRIDGECAM_WIDTH` and
  `BRIDGECAM_HEIGHT` to override the hardcoded resolution; the driver
  polls these on each call to `FillBuffer`.
* Use the provided `frame_reader.exe` helper to populate a shared-memory
  file for testing.  Example:
  ```powershell
  .\frame_reader.exe "C:\path\to\bridgecam_shm_uuid" # writes dummy data
  ```
  Then point GraphEdit/GraphStudio at the `BridgeCam Source` filter and
  connect it to a renderer to verify frames appear.
* When the DirectShow Base Classes become available, remove the stub
  definitions at the top of `BridgeCamFilter.cpp` and enable the full
  implementation (see earlier commits for reference code).

---

For macOS and Linux drivers, see the parent `drivers/` README.