// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 BridgeCam Contributors
//
// BridgeCam Rust Backend — Main Module

use std::path::{Component, Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};

use base64::engine::general_purpose::STANDARD as B64;
use base64::Engine as _;
use once_cell::sync::Lazy;
use uuid::Uuid;

mod audio_socket;
mod frame_socket;
mod signaling_server;
#[cfg(target_os = "windows")]
mod virtual_cam;
#[cfg(target_os = "windows")]
mod win32_shm;

pub use signaling_server::find_server_dir;

// Pack (width, height) into a single AtomicU64 so readers never observe torn pairs.
static FRAME_DIMS: AtomicU64 = AtomicU64::new(((1280u64) << 32) | 720u64);

pub fn set_frame_dims(width: u32, height: u32) {
    let packed = ((width as u64) << 32) | (height as u64);
    FRAME_DIMS.store(packed, Ordering::Release);
}

pub fn get_frame_dims() -> (u32, u32) {
    let packed = FRAME_DIMS.load(Ordering::Acquire);
    ((packed >> 32) as u32, (packed & 0xFFFF_FFFF) as u32)
}

// Per-launch 128-bit random token used to authenticate localhost frame/audio WebSockets.
static SOCKET_TOKEN: Lazy<String> = Lazy::new(|| Uuid::new_v4().simple().to_string());

pub fn verify_socket_token(query: &str) -> bool {
    let expected = SOCKET_TOKEN.as_str();
    query.split('&').any(|pair| {
        if let Some((k, v)) = pair.split_once('=') {
            k == "token" && v == expected
        } else {
            false
        }
    })
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------
#[cfg(target_os = "windows")]
pub const SHM_FILE_PATH: &str = "C:\\ProgramData\\BridgeCam\\framebuffer.dat";
pub const HEADER_SIZE: usize = 12;
pub const MAX_FRAME_BYTES: usize = 3840 * 2160 * 4; // 4K RGBA
#[cfg(target_os = "windows")]
pub const MAX_MAPPING_BYTES: u64 = (HEADER_SIZE + MAX_FRAME_BYTES) as u64;

const ALLOWED_SAVE_EXTENSIONS: &[&str] = &["webm", "png", "mp4", "webp"];

// ---------------------------------------------------------------------------
// Winsock initialization helper (Windows)
// ---------------------------------------------------------------------------
#[cfg(target_os = "windows")]
pub fn ensure_winsock() {
    use std::sync::Once;
    static INIT: Once = Once::new();
    INIT.call_once(|| unsafe {
        let mut wsa_data: winapi::um::winsock2::WSADATA = std::mem::zeroed();
        let result = winapi::um::winsock2::WSAStartup(0x0202, &mut wsa_data);
        if result != 0 {
            eprintln!("[BridgeCam] WSAStartup failed: {result}");
        } else {
            eprintln!(
                "[BridgeCam] WSAStartup OK (Winsock {}.{})",
                wsa_data.wVersion & 0xFF,
                wsa_data.wVersion >> 8
            );
        }
    });
}

/// Validate a destination path for saving screenshots/recordings:
/// - Rejects parent-directory (`..`) traversal components
/// - Requires an allowed media file extension (.webm, .png, .mp4, .webp)
pub fn validate_save_path(raw: &str) -> Result<PathBuf, String> {
    if raw.trim().is_empty() {
        return Err("save path cannot be empty".into());
    }
    let path = Path::new(raw);
    for comp in path.components() {
        if matches!(comp, Component::ParentDir) {
            return Err("path traversal ('..') is not allowed".into());
        }
    }
    let ext = path
        .extension()
        .and_then(|e| e.to_str())
        .map(|e| e.to_ascii_lowercase())
        .ok_or_else(|| "save path must include a file extension".to_string())?;
    if !ALLOWED_SAVE_EXTENSIONS.contains(&ext.as_str()) {
        return Err(format!(
            "unsupported file extension '.{ext}' (allowed: .webm, .png, .mp4, .webp)"
        ));
    }
    Ok(path.to_path_buf())
}

// ---------------------------------------------------------------------------
// Tauri Commands
// ---------------------------------------------------------------------------

#[tauri::command]
fn create_named_shared_memory(width: u32, height: u32) -> Result<(), String> {
    set_frame_dims(width, height);
    #[cfg(target_os = "windows")]
    return win32_shm::create(width, height);
    #[cfg(not(target_os = "windows"))]
    Err("Named Win32 shared memory is only supported on Windows".into())
}

#[tauri::command]
fn write_named_shared_memory_base64(
    data_b64: String,
    width: u32,
    height: u32,
) -> Result<(), String> {
    let data = B64.decode(&data_b64).map_err(|e| e.to_string())?;
    #[cfg(target_os = "windows")]
    return win32_shm::write_frame(&data, width, height);
    #[cfg(not(target_os = "windows"))]
    Err("Named Win32 shared memory is only supported on Windows".into())
}

#[tauri::command]
fn write_frame_raw(request: tauri::ipc::Request<'_>) -> Result<(), String> {
    let bytes: &[u8] = match request.body() {
        tauri::ipc::InvokeBody::Raw(b) => b.as_slice(),
        tauri::ipc::InvokeBody::Json(_) => {
            return Err("expected raw binary payload (Uint8Array), got JSON".into());
        }
    };
    let (w, h) = get_frame_dims();
    let expected = (w as usize)
        .checked_mul(h as usize)
        .and_then(|px| px.checked_mul(4))
        .ok_or_else(|| "frame dimension overflow".to_string())?;
    if bytes.len() != expected {
        return Err(format!(
            "frame size mismatch: got {} bytes, expected {} ({}x{}x4)",
            bytes.len(),
            expected,
            w,
            h
        ));
    }
    #[cfg(target_os = "windows")]
    return win32_shm::write_frame(bytes, w, h);
    #[cfg(not(target_os = "windows"))]
    Err("raw frame write only supported on Windows".into())
}

#[tauri::command]
fn get_app_version() -> String {
    env!("CARGO_PKG_VERSION").to_string()
}

#[derive(serde::Serialize)]
struct UpdateInfo {
    version: String,
    notes: String,
}

/// Check GitHub Releases / update endpoints for a signed Tauri update.
#[tauri::command]
async fn check_update_available(app: tauri::AppHandle) -> Result<Option<UpdateInfo>, String> {
    use tauri_plugin_updater::UpdaterExt;
    let updater = app.updater().map_err(|e| format!("updater init failed: {e}"))?;
    match updater.check().await.map_err(|e| format!("update check failed: {e}"))? {
        Some(update) => Ok(Some(UpdateInfo {
            version: update.version,
            notes: update.body.unwrap_or_default(),
        })),
        None => Ok(None),
    }
}

/// Download, verify minisign signature, install the update in-place, and restart BridgeCam.
#[tauri::command]
async fn download_and_install_update(app: tauri::AppHandle) -> Result<(), String> {
    use tauri_plugin_updater::UpdaterExt;
    let updater = app.updater().map_err(|e| format!("updater init failed: {e}"))?;
    if let Some(update) = updater.check().await.map_err(|e| format!("update check failed: {e}"))? {
        eprintln!("[BridgeCam] Downloading signed update v{}…", update.version);
        update
            .download_and_install(|_, _| {}, || {})
            .await
            .map_err(|e| format!("update install failed: {e}"))?;
        eprintln!("[BridgeCam] Update installed — restarting app");
        app.restart();
    }
    Ok(())
}

#[tauri::command]
fn activate_virtual_camera() -> Result<String, String> {
    #[cfg(target_os = "windows")]
    return virtual_cam::activate();
    #[cfg(not(target_os = "windows"))]
    Err("Virtual camera activation is only supported on Windows 11 22H2+".into())
}

#[tauri::command]
fn deactivate_virtual_camera() -> Result<(), String> {
    #[cfg(target_os = "windows")]
    return virtual_cam::deactivate();
    #[cfg(not(target_os = "windows"))]
    Ok(())
}

#[tauri::command]
fn start_signaling_server() -> Result<String, String> {
    let server_dir =
        find_server_dir().ok_or_else(|| "Could not locate server/ directory".to_string())?;
    let port = signaling_server::start(&server_dir)?;
    Ok(format!("ws://localhost:{port}/ws"))
}

#[tauri::command]
fn get_frame_socket_port() -> u16 {
    frame_socket::port()
}

#[tauri::command]
fn get_audio_socket_port() -> u16 {
    audio_socket::port()
}

#[tauri::command]
fn get_socket_auth_token() -> String {
    SOCKET_TOKEN.clone()
}

#[tauri::command]
fn check_vb_audio() -> bool {
    audio_socket::vb_audio_present()
}

/// Save recording/screenshot to disk — RAW binary IPC (no base64).
#[tauri::command]
fn save_file_raw(request: tauri::ipc::Request<'_>) -> Result<String, String> {
    let raw_path = request
        .headers()
        .get("x-file-path")
        .and_then(|v| v.to_str().ok())
        .ok_or_else(|| "missing x-file-path header".to_string())?;

    let path = validate_save_path(raw_path)?;

    let bytes: &[u8] = match request.body() {
        tauri::ipc::InvokeBody::Raw(b) => b.as_slice(),
        tauri::ipc::InvokeBody::Json(_) => {
            return Err("expected raw binary payload (Uint8Array), got JSON".into());
        }
    };

    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|e| format!("create dir {}: {e}", parent.display()))?;
    }

    std::fs::write(&path, bytes).map_err(|e| format!("write {}: {e}", path.display()))?;
    let out = path.to_string_lossy().into_owned();
    eprintln!("[BridgeCam] Saved {} bytes to {out}", bytes.len());
    Ok(out)
}

/// Legacy base64 save — retained with strict path/extension validation.
#[tauri::command]
fn save_file_to_disk(path: String, data_b64: String) -> Result<String, String> {
    let validated = validate_save_path(&path)?;
    let bytes = B64
        .decode(&data_b64)
        .map_err(|e| format!("base64 decode: {e}"))?;
    if let Some(parent) = validated.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|e| format!("create dir {}: {e}", parent.display()))?;
    }
    std::fs::write(&validated, &bytes).map_err(|e| format!("write {}: {e}", validated.display()))?;
    let out = validated.to_string_lossy().into_owned();
    eprintln!("[BridgeCam] Saved {} bytes to {out}", bytes.len());
    Ok(out)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    #[cfg(target_os = "windows")]
    {
        unsafe {
            use windows::Win32::System::Com::{CoInitializeEx, COINIT_APARTMENTTHREADED};
            let _ = CoInitializeEx(None, COINIT_APARTMENTTHREADED);
        }
        if let Err(e) = win32_shm::create(1280, 720) {
            eprintln!("[BridgeCam] auto SHM create failed: {e}");
        }
        match virtual_cam::activate() {
            Ok(msg) => eprintln!("[BridgeCam] auto virtual camera activated: {msg}"),
            Err(e) => eprintln!("[BridgeCam] auto virtual camera activation failed: {e}"),
        }
    }

    match find_server_dir() {
        Some(dir) => match signaling_server::start(&dir) {
            Ok(port) => eprintln!("[BridgeCam] Signaling server started on port {port}"),
            Err(e) => eprintln!("[BridgeCam] Signaling server auto-start failed: {e}"),
        },
        None => eprintln!(
            "[BridgeCam] Could not locate server/ directory — signaling server not started"
        ),
    }

    match frame_socket::start() {
        Ok(port) => eprintln!("[BridgeCam] Frame socket ready on port {port}"),
        Err(e) => eprintln!("[BridgeCam] Frame socket start failed: {e}"),
    }
    match audio_socket::start() {
        Ok(port) => eprintln!("[BridgeCam] Audio socket ready on port {port}"),
        Err(e) => eprintln!("[BridgeCam] Audio socket start failed: {e}"),
    }

    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![
            get_app_version,
            check_update_available,
            download_and_install_update,
            create_named_shared_memory,
            write_named_shared_memory_base64,
            write_frame_raw,
            activate_virtual_camera,
            deactivate_virtual_camera,
            start_signaling_server,
            get_frame_socket_port,
            get_audio_socket_port,
            get_socket_auth_token,
            check_vb_audio,
            save_file_raw,
            save_file_to_disk,
        ])
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .setup(|_app| Ok(()))
        .on_window_event(|_window, event| {
            if let tauri::WindowEvent::Destroyed = event {
                eprintln!("[BridgeCam] Window destroyed — cleaning up");
                signaling_server::stop();
                #[cfg(target_os = "windows")]
                let _ = virtual_cam::deactivate();
            }
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn frame_dims_pack_and_unpack() {
        set_frame_dims(1920, 1080);
        assert_eq!(get_frame_dims(), (1920, 1080));
        set_frame_dims(3840, 2160);
        assert_eq!(get_frame_dims(), (3840, 2160));
    }

    #[test]
    fn socket_token_validation() {
        let tok = get_socket_auth_token();
        assert_eq!(tok.len(), 32);
        assert!(verify_socket_token(&format!("token={tok}")));
        assert!(verify_socket_token(&format!("foo=bar&token={tok}&baz=1")));
        assert!(!verify_socket_token("token=wrong"));
        assert!(!verify_socket_token(""));
    }

    #[test]
    fn save_path_validation_blocks_traversal_and_bad_extensions() {
        assert!(validate_save_path("C:\\Users\\test\\Videos\\clip.webm").is_ok());
        assert!(validate_save_path("C:\\Users\\test\\Pictures\\shot.PNG").is_ok());
        assert!(validate_save_path("C:\\Users\\test\\..\\Windows\\evil.webm").is_err());
        assert!(validate_save_path("C:\\Users\\test\\payload.exe").is_err());
        assert!(validate_save_path("C:\\Users\\test\\noext").is_err());
        assert!(validate_save_path("").is_err());
    }

    #[cfg(target_os = "windows")]
    #[test]
    fn shm_dimension_validation() {
        assert_eq!(win32_shm::validate_frame_dims(1920, 1080).unwrap(), 1920 * 1080 * 4);
        assert_eq!(win32_shm::validate_frame_dims(3840, 2160).unwrap(), 3840 * 2160 * 4);
        assert!(win32_shm::validate_frame_dims(0, 1080).is_err());
        assert!(win32_shm::validate_frame_dims(7680, 4320).is_err());
        assert!(win32_shm::validate_frame_dims(u32::MAX, u32::MAX).is_err());
    }
}
