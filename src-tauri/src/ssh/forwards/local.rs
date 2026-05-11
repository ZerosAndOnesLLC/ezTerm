//! Local (`-L`) forward. Bind a TCP listener locally; for each accept,
//! open a `direct-tcpip` channel through the SSH handle to the
//! destination on the server side and pump bytes in both directions.

use std::sync::Arc;

use russh::client::{Handle, Msg};
use russh::Channel;
use tokio::io::copy_bidirectional;
use tokio::net::TcpListener;
use tokio::sync::{oneshot, Mutex};

use super::{ForwardSpec, ForwardStatus, RuntimeForward, RuntimeForwardSummary};
use crate::error::{AppError, Result};
use crate::ssh::client::ClientHandler;

/// Start a local-forward listener. Returns the populated `RuntimeForward`
/// (status = Running on success); bind failures surface as
/// `AppError::Ssh` so the command layer can emit them as an error event.
pub async fn start(
    handle: Arc<Mutex<Handle<ClientHandler>>>,
    spec: ForwardSpec,
    runtime_id: u64,
    persistent_id: Option<i64>,
    on_status: Arc<dyn Fn(RuntimeForwardSummary) + Send + Sync>,
) -> Result<Arc<RuntimeForward>> {
    let bind = format!("{}:{}", spec.bind_addr, spec.bind_port);
    let listener = TcpListener::bind(&bind).await.map_err(|e| {
        AppError::Ssh(format!("local forward bind {bind}: {e}"))
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
                    let (mut tcp, peer) = match accept {
                        Ok(p) => p,
                        Err(e) => {
                            tracing::warn!("local forward accept error: {e}");
                            rf_task.set_status(ForwardStatus::Error {
                                message: format!("accept: {e}"),
                            });
                            on_status_task(rf_task.summary());
                            break;
                        }
                    };
                    let handle = handle.clone();
                    let spec = spec.clone();
                    tokio::spawn(async move {
                        let chan = {
                            let h = handle.lock().await;
                            h.channel_open_direct_tcpip(
                                spec.dest_addr.clone(),
                                spec.dest_port as u32,
                                peer.ip().to_string(),
                                peer.port() as u32,
                            ).await
                        };
                        let channel = match chan {
                            Ok(c) => c,
                            Err(e) => {
                                tracing::warn!(
                                    "local forward direct-tcpip {}:{} failed: {e}",
                                    spec.dest_addr, spec.dest_port,
                                );
                                return;
                            }
                        };
                        pump(channel, &mut tcp).await;
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

async fn pump(channel: Channel<Msg>, tcp: &mut tokio::net::TcpStream) {
    let mut stream = channel.into_stream();
    let _ = copy_bidirectional(&mut stream, tcp).await;
}
