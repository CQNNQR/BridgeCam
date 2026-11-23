// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 BridgeCam Contributors
//
// BridgeCam Frame Socket Module
// Authenticated localhost WebSocket for high-speed RGBA frame delivery.

use std::net::{TcpListener, TcpStream};
use std::sync::atomic::{AtomicU16, Ordering};
use std::thread;
use tungstenite::handshake::server::{ErrorResponse, Request, Response};
use tungstenite::http::StatusCode;
use tungstenite::{accept_hdr_with_config, protocol::WebSocketConfig, Message};

#[cfg(target_os = "windows")]
use crate::win32_shm;
use crate::{get_frame_dims, verify_socket_token};

static PORT: AtomicU16 = AtomicU16::new(0);

// 4K RGBA (~33.2 MB) + margin
const MAX_FRAME_WS_MSG: usize = 36 * 1024 * 1024;

/// Start the frame socket server on a random available localhost port.
/// Safe to call multiple times (idempotent).
pub fn start() -> Result<u16, String> {
    let current = PORT.load(Ordering::Relaxed);
    if current != 0 {
        return Ok(current);
    }

    #[cfg(target_os = "windows")]
    crate::ensure_winsock();

    let listener = TcpListener::bind("127.0.0.1:0")
        .map_err(|e| format!("frame socket bind failed: {e}"))?;
    let port = listener
        .local_addr()
        .map_err(|e| format!("frame socket addr failed: {e}"))?
        .port();

    PORT.store(port, Ordering::Relaxed);

    thread::spawn(move || {
        eprintln!("[BridgeCam] Frame socket listening on 127.0.0.1:{port}");
        for stream in listener.incoming() {
            match stream {
                Ok(s) => {
                    thread::spawn(|| handle_client(s));
                }
                Err(e) => eprintln!("[BridgeCam] frame socket accept error: {e}"),
            }
        }
    });

    Ok(port)
}

#[allow(clippy::result_large_err)]
fn handle_client(stream: TcpStream) {
    stream.set_nodelay(true).ok();

    // 64MB receive buffer so the OS can accept a full 4K frame (~33MB) in one shot
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::io::AsRawSocket;
        unsafe {
            let buf_size: i32 = 64 * 1024 * 1024;
            winapi::um::winsock2::setsockopt(
                stream.as_raw_socket() as _,
                winapi::um::winsock2::SOL_SOCKET,
                winapi::um::winsock2::SO_RCVBUF,
                &buf_size as *const i32 as *const i8,
                std::mem::size_of::<i32>() as i32,
            );
        }
    }

    let ws_config = WebSocketConfig {
        max_message_size: Some(MAX_FRAME_WS_MSG),
        max_frame_size: Some(MAX_FRAME_WS_MSG),
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
        Ok(ws) => ws,
        Err(e) => {
            eprintln!("[BridgeCam] Frame socket handshake failed: {e}");
            return;
        }
    };

    eprintln!("[BridgeCam] Frame socket client connected");

    loop {
        match ws.read() {
            Ok(Message::Binary(data)) => {
                let (w, h) = get_frame_dims();
                let expected = (w as usize)
                    .checked_mul(h as usize)
                    .and_then(|px| px.checked_mul(4));
                if expected == Some(data.len()) {
                    #[cfg(target_os = "windows")]
                    {
                        let _ = win32_shm::write_frame(&data, w, h);
                    }
                }
            }
            Ok(Message::Close(_)) | Err(_) => {
                eprintln!("[BridgeCam] Frame socket client disconnected");
                break;
            }
            _ => {}
        }
    }
}

pub fn port() -> u16 {
    PORT.load(Ordering::Relaxed)
}
