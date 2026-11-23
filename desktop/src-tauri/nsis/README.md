# Windows installer

The release workflow builds the x64 camera DLL and bundles it in the NSIS installer through the Tauri release configuration. The installer registers the Media Foundation source.

To build the release bundle on Windows with the MSVC toolchain and SDK:

```powershell
cmake -S drivers/windows -B drivers/windows/build_release -G "Visual Studio 17 2022" -A x64
cmake --build drivers/windows/build_release --config Release --target BridgeCamFilter
cd desktop
npm ci
npx tauri build --config src-tauri/tauri.release.conf.json
```

The GitHub Actions build uses the repository's Tauri signing secrets. Download the signed `bridgecam-windows-signed` artifact from a successful run, verify the installer, and upload it and its signature to the matching GitHub release. Upload `latest.json` after both files are available so existing apps can update safely.
