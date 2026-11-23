// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 BridgeCam Contributors
//
// BridgeCam Audio Socket Module
// Authenticated localhost WebSocket piping stereo f32le PCM to VB-Audio Cable via cpal/WASAPI.

use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
use std::collections::VecDeque;
use std::net::TcpListener;
use std::sync::atomic::{AtomicU16, Ordering};
use std::sync::{Arc, Mutex};
use std::thread;
use tungstenite::handshake::server::{ErrorResponse, Request, Response};
use tungstenite::http::StatusCode;
use tungstenite::{accept_hdr_with_config, protocol::WebSocketConfig, Message};

use crate::verify_socket_token;

static PORT: AtomicU16 = AtomicU16::new(0);

type SampleBuf = Arc<Mutex<VecDeque<f32>>>;

// Cap ring buffer at ~200ms of 48kHz stereo (48000 * 2 * 0.2 = 19200 samples, even)
const MAX_RING_SAMPLES: usize = 19_200;

/// Start the audio socket server on a random available localhost port.
/// Safe to call multiple times (idempotent).
pub fn start() -> Result<u16, String> {
    let current = PORT.load(Ordering::Relaxed);
    if current != 0 {
        return Ok(current);
    }

    #[cfg(target_os = "windows")]
    crate::ensure_winsock();

    let listener = TcpListener::bind("127.0.0.1:0")
        .map_err(|e| format!("audio_socket bind failed: {e}"))?;
    let port = listener
        .local_addr()
        .map_err(|e| format!("audio_socket addr failed: {e}"))?
        .port();
    PORT.store(port, Ordering::Relaxed);

    thread::spawn(move || {
        for stream in listener.incoming() {
            match stream {
                Ok(s) => {
                    thread::spawn(move || handle_client(s));
                }
                Err(e) => eprintln!("[BridgeCam] audio socket accept error: {e}"),
            }
        }
    });
    Ok(port)
}

#[allow(unknown_lints, clippy::result_large_err, clippy::chunks_exact_to_as_chunks)]
fn handle_client(stream: std::net::TcpStream) {
    let ws_config = WebSocketConfig {
        max_message_size: Some(256 * 1024),
        max_frame_size: Some(256 * 1024),
        ..WebSocketConfig::default()
    };

    let callback = |req: &Request, response: Response| -> Result<Response, ErrorResponse> {
        let query = req.uri().query().unwrap_or("");
        if !verify_socket_token(query) {
            let mut err = ErrorResponse::new(Some("Unauthorized".into()));
            *err.status_mut() = StatusCode::UNAUTHORIZED;
            return Err(err);
        }
        Ok(response)
    };

    let mut ws = match accept_hdr_with_config(stream, callback, Some(ws_config)) {
        Ok(w) => w,
        Err(e) => {
            eprintln!("[BridgeCam] audio WS handshake failed: {e}");
            return;
        }
    };

    let buf: SampleBuf = Arc::new(Mutex::new(VecDeque::with_capacity(MAX_RING_SAMPLES)));
    #[allow(clippy::type_complexity)]
    let _stream: Option<Box<dyn std::any::Any>> = start_cpal_output(buf.clone());

    loop {
        match ws.read() {
            Ok(Message::Binary(data)) => {
                // Ensure stereo alignment (multiples of 8 bytes = 2 f32 samples)
                let aligned_len = data.len() & !7;
                let samples: Vec<f32> = data[..aligned_len]
                    .chunks_exact(4)
                    .map(|b| f32::from_le_bytes([b[0], b[1], b[2], b[3]]))
                    .collect();
                let mut lock = buf.lock().unwrap_or_else(|e| e.into_inner());
                lock.extend(samples);
                // Always drop in stereo pairs so L/R never swap
                while lock.len() > MAX_RING_SAMPLES {
                    lock.pop_front();
                    lock.pop_front();
                }
            }
            Ok(Message::Close(_)) | Err(_) => break,
            _ => {}
        }
    }
}

fn start_cpal_output(buf: SampleBuf) -> Option<Box<dyn std::any::Any>> {
    let host = cpal::default_host();
    let device = host
        .output_devices()
        .ok()?
        .find(|d| {
            d.name()
                .map(|n| n.to_lowercase().contains("cable input"))
                .unwrap_or(false)
        })
        .or_else(|| host.default_output_device())?;
    eprintln!(
        "[BridgeCam] audio output device: {}",
        device.name().unwrap_or_default()
    );
    let config = device.default_output_config().ok()?;
    let channels = (config.channels() as usize).max(1);
    let stream = device
        .build_output_stream(
            &config.into(),
            move |output: &mut [f32], _| {
                // Non-blocking try_lock on real-time audio thread to avoid priority inversion
                let mut lock = match buf.try_lock() {
                    Ok(g) => g,
                    Err(_) => {
                        output.fill(0.0);
                        return;
                    }
                };
                let frames_needed = output.len() / channels;
                let stereo_samples_available = lock.len() & !1;
                let frames_available = stereo_samples_available / 2;
                let frames_to_read = frames_needed.min(frames_available);

                for f in 0..frames_to_read {
                    let l = lock.pop_front().unwrap_or(0.0);
                    let r = lock.pop_front().unwrap_or(0.0);
                    for ch in 0..channels {
                        output[f * channels + ch] = if ch == 0 { l } else { r };
                    }
                }
                // Fill remaining output with silence on underrun
                if frames_to_read < frames_needed {
                    output[frames_to_read * channels..].fill(0.0);
                }
            },
            |e| eprintln!("[BridgeCam] cpal stream error: {e}"),
            None,
        )
        .ok()?;
    stream.play().ok()?;
    Some(Box::new(stream))
}

pub fn port() -> u16 {
    PORT.load(Ordering::Relaxed)
}

pub fn vb_audio_present() -> bool {
    let host = cpal::default_host();
    host.output_devices()
        .map(|mut devs| {
            devs.any(|d| {
                d.name()
                    .map(|n| n.to_lowercase().contains("cable input"))
                    .unwrap_or(false)
            })
        })
        .unwrap_or(false)
}
