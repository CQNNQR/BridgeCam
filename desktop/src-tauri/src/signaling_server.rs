// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 BridgeCam Contributors
//
// BridgeCam Signaling Server Module — auto-start child process management

use std::process::{Child, Command, Stdio};
use std::sync::Mutex;

static SERVER_PROC: Mutex<Option<Child>> = Mutex::new(None);

/// Spawn the Node.js signaling server. Returns Ok(port) on success.
pub fn start(server_dir: &str) -> Result<u16, String> {
    let mut guard = SERVER_PROC.lock().unwrap_or_else(|e| e.into_inner());
    if let Some(ref mut child) = *guard {
        match child.try_wait() {
            Ok(None) => return Ok(3000), // still alive
            _ => {
                *guard = None; // exited – restart below
            }
        }
    }

    let nm = std::path::Path::new(server_dir).join("node_modules");
    if !nm.exists() {
        eprintln!("[BridgeCam] Installing server dependencies…");
        #[cfg(target_os = "windows")]
        let npm_cmd = "npm.cmd";
        #[cfg(not(target_os = "windows"))]
        let npm_cmd = "npm";

        let install = Command::new(npm_cmd)
            .arg("install")
            .current_dir(server_dir)
            .stdout(Stdio::inherit())
            .stderr(Stdio::inherit())
            .status();
        match install {
            Ok(s) if s.success() => eprintln!("[BridgeCam] npm install succeeded"),
            Ok(s) => return Err(format!("npm install exited with {s}")),
            Err(e) => return Err(format!("npm install failed: {e}")),
        }
    }

    eprintln!("[BridgeCam] Starting signaling server from {server_dir}");
    let child = Command::new("node")
        .arg("src/index.js")
        .current_dir(server_dir)
        .stdout(Stdio::inherit())
        .stderr(Stdio::inherit())
        .spawn()
        .map_err(|e| format!("Failed to start signaling server: {e}"))?;

    eprintln!("[BridgeCam] Signaling server PID: {}", child.id());
    *guard = Some(child);
    Ok(3000)
}

pub fn stop() {
    let mut guard = SERVER_PROC.lock().unwrap_or_else(|e| e.into_inner());
    if let Some(ref mut child) = guard.take() {
        eprintln!("[BridgeCam] Stopping signaling server PID {}", child.id());
        let _ = child.kill();
        let _ = child.wait();
    }
}

/// Find the server/ directory by walking up from CWD or exe location.
pub fn find_server_dir() -> Option<String> {
    let manifest_based = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../server");

    let mut candidates: Vec<std::path::PathBuf> = vec![
        manifest_based,
        std::path::PathBuf::from("../server"),
        std::path::PathBuf::from("server"),
        std::path::PathBuf::from("./server"),
    ];

    if let Ok(exe) = std::env::current_exe() {
        if let Some(dir) = exe.parent() {
            candidates.push(dir.join("server"));
            candidates.push(dir.join("../server"));
            candidates.push(dir.join("../../server"));
            candidates.push(dir.join("../../../server"));
            candidates.push(dir.join("../../../../server"));
        }
    }

    if let Ok(cwd) = std::env::current_dir() {
        candidates.push(cwd.join("server"));
        candidates.push(cwd.join("../server"));
    }

    for c in &candidates {
        let idx = c.join("src/index.js");
        if idx.exists() {
            return c
                .canonicalize()
                .ok()
                .map(|p| p.to_string_lossy().into_owned());
        }
    }
    None
}
