//! Dynamic (`-D`) forward. Local TCP listener that speaks the
//! server-side of SOCKS5; for each accepted client, parses the
//! greeting + CONNECT request and opens a direct-tcpip channel to
//! the requested host through the SSH handle.

use std::sync::Arc;

use russh::client::Handle;
use tokio::io::{AsyncReadExt, AsyncWriteExt, copy_bidirectional};
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::{oneshot, Mutex};

use super::socks5::{self, ConnectRequest, Socks5Error};
use super::{ForwardSpec, ForwardStatus, RuntimeForward, RuntimeForwardSummary};
use crate::error::{AppError, Result};
use crate::ssh::client::ClientHandler;

pub async fn start(
    handle: Arc<Mutex<Handle<ClientHandler>>>,
    spec: ForwardSpec,
    runtime_id: u64,
    persistent_id: Option<i64>,
    on_status: Arc<dyn Fn(RuntimeForwardSummary) + Send + Sync>,
) -> Result<Arc<RuntimeForward>> {
    let bind = format!("{}:{}", spec.bind_addr, spec.bind_port);
    let listener = TcpListener::bind(&bind).await.map_err(|e| {
        AppError::Ssh(format!("dynamic forward bind {bind}: {e}"))
    })?;

    let (stop_tx, mut stop_rx) = oneshot::channel::<()>();
    let rf = Arc::new(RuntimeForward {
        id:            runtime_id,
        persistent_id,
        spec:          spec.clone(),
        status:        std::sync::Mutex::new(ForwardStatus::Running),
        stop_tx:       Mutex::new(Some(stop_tx)),
    });

    let rf_task = rf.clone();
    let on_status_task = on_status.clone();
    tokio::spawn(async move {
        loop {
            tokio::select! {
                _ = &mut stop_rx => break,
                accept = listener.accept() => {
                    let (tcp, peer) = match accept {
                        Ok(p) => p,
                        Err(e) => {
                            tracing::warn!("dynamic forward accept error: {e}");
                            rf_task.set_status(ForwardStatus::Error {
                                message: format!("accept: {e}"),
                            });
                            on_status_task(rf_task.summary());
                            break;
                        }
                    };
                    let handle = handle.clone();
                    tokio::spawn(async move {
                        handle_client(tcp, peer, handle).await;
                    });
                }
            }
        }
        rf_task.set_status(ForwardStatus::Stopped);
        on_status_task(rf_task.summary());
    });

    on_status(rf.summary());
    Ok(rf)
}

async fn handle_client(
    mut tcp: TcpStream,
    peer: std::net::SocketAddr,
    handle: Arc<Mutex<Handle<ClientHandler>>>,
) {
    // Greeting: read at least VER+NMETHODS, then up to 255 methods.
    let mut hdr = [0u8; 2];
    if tcp.read_exact(&mut hdr).await.is_err() { return; }
    let nmethods = hdr[1] as usize;
    let mut methods = vec![0u8; nmethods];
    if tcp.read_exact(&mut methods).await.is_err() { return; }
    let mut greeting = Vec::with_capacity(2 + nmethods);
    greeting.extend_from_slice(&hdr);
    greeting.extend_from_slice(&methods);
    if socks5::parse_greeting(&greeting).is_err() {
        let _ = tcp.write_all(&socks5::encode_greeting_reply(false)).await;
        return;
    }
    if tcp.write_all(&socks5::encode_greeting_reply(true)).await.is_err() { return; }

    // Request prefix: VER CMD RSV ATYP (4 bytes), then a variable tail
    // (ATYP-dependent), then 2-byte port.
    let mut prefix = [0u8; 4];
    if tcp.read_exact(&mut prefix).await.is_err() { return; }
    let mut full = Vec::with_capacity(32);
    full.extend_from_slice(&prefix);
    match prefix[3] {
        0x01 => {
            let mut tail = [0u8; 4 + 2];
            if tcp.read_exact(&mut tail).await.is_err() { return; }
            full.extend_from_slice(&tail);
        }
        0x04 => {
            let mut tail = [0u8; 16 + 2];
            if tcp.read_exact(&mut tail).await.is_err() { return; }
            full.extend_from_slice(&tail);
        }
        0x03 => {
            let mut lenbuf = [0u8; 1];
            if tcp.read_exact(&mut lenbuf).await.is_err() { return; }
            full.push(lenbuf[0]);
            let mut tail = vec![0u8; lenbuf[0] as usize + 2];
            if tcp.read_exact(&mut tail).await.is_err() { return; }
            full.extend_from_slice(&tail);
        }
        _ => {
            let _ = tcp.write_all(&socks5::encode_reply(
                socks5::rep::ADDRESS_TYPE_NOT_SUPPORTED,
            )).await;
            return;
        }
    }

    let req: ConnectRequest = match socks5::parse_request(&full) {
        Ok(r) => r,
        Err(Socks5Error::BadCommand(_)) => {
            let _ = tcp.write_all(&socks5::encode_reply(
                socks5::rep::COMMAND_NOT_SUPPORTED,
            )).await;
            return;
        }
        Err(Socks5Error::BadAtyp(_)) => {
            let _ = tcp.write_all(&socks5::encode_reply(
                socks5::rep::ADDRESS_TYPE_NOT_SUPPORTED,
            )).await;
            return;
        }
        Err(_) => {
            let _ = tcp.write_all(&socks5::encode_reply(
                socks5::rep::GENERAL_FAILURE,
            )).await;
            return;
        }
    };

    let chan = {
        let h = handle.lock().await;
        h.channel_open_direct_tcpip(
            req.host.clone(),
            req.port as u32,
            peer.ip().to_string(),
            peer.port() as u32,
        ).await
    };
    let channel = match chan {
        Ok(c) => c,
        Err(e) => {
            tracing::warn!(
                "dynamic forward direct-tcpip {}:{} failed: {e}",
                req.host, req.port,
            );
            let _ = tcp.write_all(&socks5::encode_reply(
                socks5::rep::CONNECTION_REFUSED,
            )).await;
            return;
        }
    };

    if tcp.write_all(&socks5::encode_reply(socks5::rep::SUCCESS)).await.is_err() {
        return;
    }
    let mut stream = channel.into_stream();
    let _ = copy_bidirectional(&mut stream, &mut tcp).await;
}
