//! Local (`-L`) forward. Bind a TCP listener locally; for each accept,
//! open a `direct-tcpip` channel through the SSH handle to the
//! destination on the server side and pump bytes in both directions.

use std::sync::Arc;

use russh::client::Handle;
use tokio::io::copy_bidirectional_with_sizes;
use tokio::net::TcpListener;
use tokio::sync::{oneshot, Mutex, Semaphore};

use super::{bind_socket, ForwardSpec, ForwardStatus, RuntimeForward, RuntimeForwardSummary, COPY_BUF, MAX_INFLIGHT_PER_FORWARD};
use crate::error::{AppError, Result};
use crate::ssh::client::ClientHandler;

/// Start a local-forward listener. Returns the populated `RuntimeForward`
/// (status = Running on success); bind failures surface as
/// `AppError::Ssh` so the command layer can emit them as an error event.
pub async fn start(
    handle: Arc<Handle<ClientHandler>>,
    spec: ForwardSpec,
    runtime_id: u64,
    persistent_id: Option<i64>,
    on_status: Arc<dyn Fn(RuntimeForwardSummary) + Send + Sync>,
) -> Result<Arc<RuntimeForward>> {
    let bind = bind_socket(&spec.bind_addr, spec.bind_port)?;
    let listener = TcpListener::bind(bind).await.map_err(|e| {
        AppError::Ssh(super::format_bind_error(&spec.bind_addr, spec.bind_port, &e))
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
                    // Acquire a permit before spawning. `try_acquire_owned`
                    // sheds excess load instead of letting tasks pile up.
                    let permit = match inflight.clone().try_acquire_owned() {
                        Ok(p) => p,
                        Err(_) => {
                            tracing::warn!(
                                "local forward {}:{} dropping accept — {} in-flight",
                                spec.bind_addr, spec.bind_port, MAX_INFLIGHT_PER_FORWARD,
                            );
                            continue;
                        }
                    };
                    let handle = handle.clone();
                    let dest_addr = spec.dest_addr.clone();
                    let dest_port = spec.dest_port;
                    tokio::spawn(async move {
                        let _p = permit;
                        let chan = handle.channel_open_direct_tcpip(
                            dest_addr.clone(),
                            dest_port as u32,
                            peer.ip().to_string(),
                            peer.port() as u32,
                        ).await;
                        let channel = match chan {
                            Ok(c) => c,
                            Err(e) => {
                                tracing::debug!(
                                    "local forward direct-tcpip open failed: {e}",
                                );
                                return;
                            }
                        };
                        let mut stream = channel.into_stream();
                        let _ = copy_bidirectional_with_sizes(
                            &mut stream, &mut tcp, COPY_BUF, COPY_BUF,
                        ).await;
                    });
                }
            }
        }
        rf_task.set_status(ForwardStatus::Stopped);
        on_status_task(rf_task.summary());
    });

    // Note: do NOT emit Running here — the command layer's awaited
    // return value already carries the same summary, and emitting both
    // makes the UI render the row twice for every Start.
    Ok(rf)
}
