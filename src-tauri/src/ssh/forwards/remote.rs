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

    // Per-connection dedupe: refuse a duplicate (bind_addr, bind_port)
    // registration. Otherwise a server could re-deliver channels into
    // an unrelated forward task that happens to share the key.
    {
        let map = dispatch.read().expect("dispatch poisoned");
        if map.contains_key(&key) {
            return Err(AppError::Validation(format!(
                "{}:{} is already bound by another forward on this session",
                spec.bind_addr, spec.bind_port,
            )));
        }
    }

    let (tx, mut rx) = mpsc::unbounded_channel::<Channel<Msg>>();
    dispatch.write().expect("dispatch poisoned").insert(key.clone(), tx);

    // Request the forward on the server side. If the server rejects
    // (AllowTcpForwarding=no, port-in-use on remote, etc.), back out
    // the dispatch entry and surface the error to the command layer.
    if let Err(e) = handle
        .tcpip_forward(spec.bind_addr.clone(), spec.bind_port as u32)
        .await
    {
        dispatch.write().expect("dispatch poisoned").remove(&key);
        return Err(AppError::Ssh(format!(
            "tcpip_forward {}:{}: {e}",
            spec.bind_addr, spec.bind_port,
        )));
    }

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
    let dispatch_task = dispatch.clone();
    let handle_task = handle.clone();
    let key_task = key.clone();
    let spec_task = spec.clone();
    tokio::spawn(async move {
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
        dispatch_task.write().expect("dispatch poisoned").remove(&key_task);
        let _ = handle_task
            .cancel_tcpip_forward(spec_task.bind_addr.clone(), spec_task.bind_port as u32)
            .await;
        rf_task.set_status(ForwardStatus::Stopped);
        on_status_task(rf_task.summary());
    });

    Ok(rf)
}
