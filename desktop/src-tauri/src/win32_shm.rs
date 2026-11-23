// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 BridgeCam Contributors
//
// BridgeCam Win32 Shared Memory Module
// File-backed memory mapping at C:\ProgramData\BridgeCam\framebuffer.dat
// accessible across Session 0 (Frame Server) and Session 1 (Tauri desktop).

use memmap2::MmapMut;
use std::fs::OpenOptions;
use std::sync::atomic::{fence, Ordering};
use std::sync::Mutex;

use crate::{HEADER_SIZE, MAX_FRAME_BYTES, MAX_MAPPING_BYTES, SHM_FILE_PATH};

static SHM_MMAP: Mutex<Option<MmapMut>> = Mutex::new(None);

/// Validate that `(width, height)` fits within `MAX_FRAME_BYTES` without overflow.
pub fn validate_frame_dims(width: u32, height: u32) -> Result<usize, String> {
    if width == 0 || height == 0 {
        return Err("frame dimensions must be non-zero".into());
    }
    let bytes = (width as usize)
        .checked_mul(height as usize)
        .and_then(|px| px.checked_mul(4))
        .ok_or_else(|| "frame dimension overflow".to_string())?;
    if bytes > MAX_FRAME_BYTES {
        return Err(format!(
            "frame size {} ({}x{}x4) exceeds max {}",
            bytes, width, height, MAX_FRAME_BYTES
        ));
    }
    Ok(bytes)
}

#[allow(clippy::suspicious_open_options)]
pub fn create(width: u32, height: u32) -> Result<(), String> {
    validate_frame_dims(width, height)?;

    std::fs::create_dir_all("C:\\ProgramData\\BridgeCam")
        .map_err(|e| format!("create_dir_all failed: {e}"))?;

    // Never truncate an existing file — Frame Server may already have it mapped.
    let file = OpenOptions::new()
        .read(true)
        .write(true)
        .create(true)
        .truncate(false)
        .open(SHM_FILE_PATH)
        .map_err(|e| format!("open framebuffer.dat failed: {e}"))?;

    // Only extend, never shrink
    if file.metadata().map(|m| m.len()).unwrap_or(0) < MAX_MAPPING_BYTES {
        file.set_len(MAX_MAPPING_BYTES)
            .map_err(|e| format!("set_len failed: {e}"))?;
    }

    let mut mmap = unsafe {
        MmapMut::map_mut(&file).map_err(|e| format!("map_mut failed: {e}"))?
    };

    let p = mmap.as_mut_ptr() as *mut u32;
    unsafe {
        p.write(width);
        p.add(1).write(height);
        p.add(2).write(0);
    }
    mmap.flush_async().ok();

    let mut guard = SHM_MMAP.lock().unwrap_or_else(|e| e.into_inner());
    *guard = Some(mmap);
    Ok(())
}

pub fn write_frame(data: &[u8], width: u32, height: u32) -> Result<(), String> {
    let expected = validate_frame_dims(width, height)?;
    if data.len() != expected {
        return Err(format!(
            "frame length mismatch: got {}, expected {} ({}x{}x4)",
            data.len(),
            expected,
            width,
            height
        ));
    }

    // try_lock: if another write is mid-copy, skip this frame rather than
    // blocking the socket thread.
    let mut guard = match SHM_MMAP.try_lock() {
        Ok(g) => g,
        Err(_) => return Err("busy".into()),
    };
    let mmap = guard.as_mut().ok_or("Shared memory not created yet")?;

    let needed = HEADER_SIZE
        .checked_add(data.len())
        .ok_or_else(|| "buffer size overflow".to_string())?;
    if mmap.len() < needed {
        return Err(format!("mmap too small: {} < {}", mmap.len(), needed));
    }

    unsafe {
        let p = mmap.as_mut_ptr();
        let pw = p as *mut u32;
        pw.write(width);
        pw.add(1).write(height);
        // Copy pixels BEFORE bumping frame_seq so Frame Server never reads a
        // half-written/torn frame when it observes the new sequence number.
        std::ptr::copy_nonoverlapping(data.as_ptr(), p.add(HEADER_SIZE), data.len());
        fence(Ordering::Release);
        let old_seq = pw.add(2).read();
        pw.add(2).write(old_seq.wrapping_add(1));
    }
    Ok(())
}
