//! Remote (`-R`) forward. Sends `tcpip_forward` to the server so it
//! starts listening on the remote side; channels for each inbound
//! connection arrive at our `ClientHandler::server_channel_open_forwarded_tcpip`
//! callback and are dispatched here by `(bind_addr, bind_port)` via the
//! per-Connection dispatch map.

use std::collections::HashMap;
use std::sync::{Arc, RwLock as StdRwLock};

use russh::client::{Handle, Msg};
use russh::Channel;
use tokio::io::copy_bidirectional_with_sizes;
use tokio::net::TcpStream;
use tokio::sync::{mpsc, oneshot, Mutex};

use super::{ForwardSpec, ForwardStatus, RuntimeForward, RuntimeForwardSummary, COPY_BUF};
use crate::error::{AppError, Result};
use crate::ssh::client::ClientHandler;

pub async fn start(
    handle: Arc<Handle<ClientHandler>>,
    dispatch: Arc<StdRwLock<HashMap<(String, u32), mpsc::UnboundedSender<Channel<Msg>>>>>,
    spec: ForwardSpec,
    runtime_id: u64,
    persistent_id: Option<i64>,
    on_status: Arc<dyn Fn(RuntimeForwardSummary) + Send + Sync>,
) -> Result<Arc<RuntimeForward>> {
    let key = (spec.bind_addr.clone(), spec.bind_port as u32);

    let (tx, mut rx) = mpsc::unbounded_channel::<Channel<Msg>>();

    // Per-connection dedupe: check + insert under a single write lock so
    // two concurrent starts for the same key can't both pass the check
    // (TOCTOU). A duplicate is a neutral conflict — this session already
    // forwards that port — not a hard error.
    {
        let mut map = dispatch.write().expect("dispatch poisoned");
        if map.contains_key(&key) {
            return Err(AppError::PortConflict(format!(
                "{}:{} is already forwarded on this session",
                spec.bind_addr, spec.bind_port,
            )));
        }
        map.insert(key.clone(), tx);
    }

    // From here the dispatch entry is live. This guard removes it on every
    // exit path — server reject below, normal teardown, or a task panic —
    // so a stale key can't permanently block re-binding the address.
    let guard = DispatchGuard { map: dispatch.clone(), key: key.clone() };

    // Request the forward on the server side. If the server rejects
    // (AllowTcpForwarding=no, port-in-use on remote, etc.), `guard` drops
    // on return and backs the dispatch entry out.
    if let Err(e) = handle
        .tcpip_forward(spec.bind_addr.clone(), spec.bind_port as u32)
        .await
    {
        return Err(AppError::Ssh(format!(
            "tcpip_forward {}:{}: {e}",
            spec.bind_addr, spec.bind_port,
        )));
    }

    let (stop_tx, mut stop_rx) = oneshot::channel::<()>();
    let (done_tx, done_rx) = oneshot::channel::<()>();
    let rf = Arc::new(RuntimeForward {
        id:            runtime_id,
        persistent_id,
        spec:          spec.clone(),
        status:        std::sync::Mutex::new(ForwardStatus::Running),
        stop_tx:       Mutex::new(Some(stop_tx)),
        done_rx:       Mutex::new(Some(done_rx)),
    });

    let rf_task = rf.clone();
    let on_status_task = on_status.clone();
    let handle_task = handle.clone();
    let spec_task = spec.clone();
    tokio::spawn(async move {
        // Owns the dispatch entry for the task's lifetime; dropped
        // explicitly below (or on panic) to release the key.
        let guard = guard;
        loop {
            tokio::select! {
                _ = &mut stop_rx => break,
                ch = rx.recv() => {
                    let Some(channel) = ch else { break; };
                    let dest_addr = spec_task.dest_addr.clone();
                    let dest_port = spec_task.dest_port;
                    tokio::spawn(async move {
                        let mut tcp = match TcpStream::connect(
                            (dest_addr.as_str(), dest_port),
                        ).await {
                            Ok(t) => t,
                            Err(e) => {
                                tracing::debug!(
                                    "remote forward dest connect failed: {e}",
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
        // Drop the dispatch entry BEFORE awaiting cancel_tcpip_forward
        // so we don't keep accepting channels into a now-dropped mpsc
        // while waiting for the server's reply.
        drop(guard);
        let _ = handle_task
            .cancel_tcpip_forward(spec_task.bind_addr.clone(), spec_task.bind_port as u32)
            .await;
        rf_task.set_status(ForwardStatus::Stopped);
        on_status_task(rf_task.summary());
        // Teardown done: dispatch key dropped and the server-side remote
        // bind cancelled. Only now is it safe to re-request the same
        // (bind_addr, bind_port) — edit-in-place waits on this.
        let _ = done_tx.send(());
    });

    // Initial Running status is emitted centrally by `start_inner`.
    Ok(rf)
}

/// Removes a remote forward's dispatch entry when dropped. Covers the
/// normal teardown path (dropped explicitly before `cancel_tcpip_forward`)
/// and abnormal ones (early server-reject return, task panic) so a
/// `(bind_addr, bind_port)` key can't leak and permanently block
/// re-binding that address on this connection.
struct DispatchGuard {
    map: Arc<StdRwLock<HashMap<(String, u32), mpsc::UnboundedSender<Channel<Msg>>>>>,
    key: (String, u32),
}

impl Drop for DispatchGuard {
    fn drop(&mut self) {
        if let Ok(mut m) = self.map.write() {
            m.remove(&self.key);
        }
    }
}
