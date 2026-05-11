//! Remote (`-R`) forward. Sends `tcpip_forward` to the server so it
//! starts listening on the remote side; channels for each inbound
//! connection arrive at our `ClientHandler::server_channel_open_forwarded_tcpip`
//! callback and are dispatched here by `(bind_addr, bind_port)` via the
//! per-Connection dispatch map.

use std::collections::HashMap;
use std::sync::Arc;

use russh::client::{Handle, Msg};
use russh::Channel;
use tokio::io::copy_bidirectional;
use tokio::net::TcpStream;
use tokio::sync::{mpsc, oneshot, Mutex, RwLock};

use super::{ForwardSpec, ForwardStatus, RuntimeForward, RuntimeForwardSummary};
use crate::error::{AppError, Result};
use crate::ssh::client::ClientHandler;

const INBOUND_QUEUE_DEPTH: usize = 32;

pub async fn start(
    handle: Arc<Mutex<Handle<ClientHandler>>>,
    dispatch: Arc<RwLock<HashMap<(String, u32), mpsc::Sender<Channel<Msg>>>>>,
    spec: ForwardSpec,
    runtime_id: u64,
    persistent_id: Option<i64>,
    on_status: Arc<dyn Fn(RuntimeForwardSummary) + Send + Sync>,
) -> Result<Arc<RuntimeForward>> {
    let key = (spec.bind_addr.clone(), spec.bind_port as u32);
    let (tx, mut rx) = mpsc::channel::<Channel<Msg>>(INBOUND_QUEUE_DEPTH);
    dispatch.write().await.insert(key.clone(), tx);

    // Request the forward on the server side. If the server rejects
    // (AllowTcpForwarding=no, port-in-use on remote, etc.), back out
    // the dispatch entry and surface the error to the command layer.
    let req = {
        let h = handle.lock().await;
        h.tcpip_forward(spec.bind_addr.clone(), spec.bind_port as u32).await
    };
    if let Err(e) = req {
        dispatch.write().await.remove(&key);
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
                                tracing::warn!(
                                    "remote forward dest connect {dest_addr}:{dest_port} failed: {e}",
                                );
                                return;
                            }
                        };
                        let mut stream = channel.into_stream();
                        let _ = copy_bidirectional(&mut stream, &mut tcp).await;
                    });
                }
            }
        }
        // Cancel on the server, drop the dispatch entry, then mark stopped.
        let _ = {
            let h = handle_task.lock().await;
            h.cancel_tcpip_forward(spec_task.bind_addr.clone(), spec_task.bind_port as u32).await
        };
        dispatch_task.write().await.remove(&key_task);
        rf_task.set_status(ForwardStatus::Stopped);
        on_status_task(rf_task.summary());
    });

    on_status(rf.summary());
    Ok(rf)
}
