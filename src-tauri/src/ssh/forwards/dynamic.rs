//! Dynamic (`-D`) forward. Local TCP listener that speaks the
//! server-side of SOCKS5; for each accepted client, parses the
//! greeting + CONNECT request and opens a direct-tcpip channel to
//! the requested host through the SSH handle.

use std::sync::Arc;

use russh::client::Handle;
use tokio::io::{AsyncReadExt, AsyncWriteExt, copy_bidirectional_with_sizes};
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::{oneshot, Mutex, Semaphore};
use tokio::time::{timeout, Duration};

use super::socks5::{self, ConnectRequest, Socks5Error};
use super::{
    bind_socket, format_bind_error, ForwardSpec, ForwardStatus, RuntimeForward,
    RuntimeForwardSummary, COPY_BUF, MAX_INFLIGHT_PER_FORWARD, SOCKS5_READ_TIMEOUT_SECS,
};
use crate::error::{AppError, Result};
use crate::ssh::client::ClientHandler;

pub async fn start(
    handle: Arc<Handle<ClientHandler>>,
    spec: ForwardSpec,
    runtime_id: u64,
    persistent_id: Option<i64>,
    on_status: Arc<dyn Fn(RuntimeForwardSummary) + Send + Sync>,
) -> Result<Arc<RuntimeForward>> {
    let bind = bind_socket(&spec.bind_addr, spec.bind_port)?;
    let listener = TcpListener::bind(bind).await.map_err(|e| {
        AppError::Ssh(format_bind_error(&spec.bind_addr, spec.bind_port, &e))
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
    let inflight = Arc::new(Semaphore::new(MAX_INFLIGHT_PER_FORWARD));
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
                    let permit = match inflight.clone().try_acquire_owned() {
                        Ok(p) => p,
                        Err(_) => {
                            tracing::warn!(
                                "dynamic forward {}:{} dropping accept — {} in-flight",
                                spec.bind_addr, spec.bind_port, MAX_INFLIGHT_PER_FORWARD,
                            );
                            continue;
                        }
                    };
                    let handle = handle.clone();
                    tokio::spawn(async move {
                        let _p = permit;
                        handle_client(tcp, peer, handle).await;
                    });
                }
            }
        }
        rf_task.set_status(ForwardStatus::Stopped);
        on_status_task(rf_task.summary());
    });

    Ok(rf)
}

async fn handle_client(
    mut tcp: TcpStream,
    peer: std::net::SocketAddr,
    handle: Arc<Handle<ClientHandler>>,
) {
    let stage = Duration::from_secs(SOCKS5_READ_TIMEOUT_SECS);
    // Stack scratch for the whole SOCKS5 handshake. Max payload is
    // ~262 bytes (4 prefix + 1 domain-len + 255 domain + 2 port);
    // 320 is comfortably above with room for the greeting on top.
    let mut buf = [0u8; 320];

    // Greeting: VER NMETHODS METHODS...
    if timeout(stage, tcp.read_exact(&mut buf[..2])).await.is_err() { return; }
    let nmethods = buf[1] as usize;
    if nmethods > 0 {
        if timeout(stage, tcp.read_exact(&mut buf[2..2 + nmethods])).await.is_err() { return; }
    }
    if socks5::parse_greeting(&buf[..2 + nmethods]).is_err() {
        let _ = tcp.write_all(&socks5::encode_greeting_reply(false)).await;
        return;
    }
    if tcp.write_all(&socks5::encode_greeting_reply(true)).await.is_err() { return; }

    // Request prefix: VER CMD RSV ATYP (4 bytes).
    if timeout(stage, tcp.read_exact(&mut buf[..4])).await.is_err() { return; }
    let atyp = buf[3];
    let req_len = match atyp {
        0x01 => 4 + 4 + 2,
        0x04 => 4 + 16 + 2,
        0x03 => {
            if timeout(stage, tcp.read_exact(&mut buf[4..5])).await.is_err() { return; }
            let domain_len = buf[4] as usize;
            5 + domain_len + 2
        }
        _ => {
            let _ = tcp.write_all(&socks5::encode_reply(
                socks5::rep::ADDRESS_TYPE_NOT_SUPPORTED,
            )).await;
            return;
        }
    };
    if req_len > buf.len() {
        let _ = tcp.write_all(&socks5::encode_reply(
            socks5::rep::GENERAL_FAILURE,
        )).await;
        return;
    }
    let already_read = if atyp == 0x03 { 5 } else { 4 };
    if timeout(stage, tcp.read_exact(&mut buf[already_read..req_len])).await.is_err() { return; }

    let req: ConnectRequest = match socks5::parse_request(&buf[..req_len]) {
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

    let chan = handle.channel_open_direct_tcpip(
        req.host.clone(),
        req.port as u32,
        peer.ip().to_string(),
        peer.port() as u32,
    ).await;
    let channel = match chan {
        Ok(c) => c,
        Err(_e) => {
            // Don't log the destination here — SOCKS5 destinations may
            // contain sensitive subdomain names. The pane row already
            // shows runtime errors via forwards:status when the listener
            // itself fails; per-connection target failures are noisy and
            // low-signal.
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
    let _ = copy_bidirectional_with_sizes(&mut stream, &mut tcp, COPY_BUF, COPY_BUF).await;
}
