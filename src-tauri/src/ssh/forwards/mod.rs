//! Per-Connection port-forwarding runtime. Each live forward (one of
//! Local/Remote/Dynamic) owns one listener task and zero-or-more
//! per-connection pump tasks. The `Forwards` struct on `Connection`
//! tracks them by a u64 runtime id; the dispatch table routes inbound
//! Remote channels back to the right forward.
//!
//! Per-forward task layout:
//!
//!   Local:    [TcpListener]   accept → channel_open_direct_tcpip → copy_bidirectional
//!   Remote:   [russh tcpip_forward]   incoming channel via dispatch → TcpStream::connect → copy_bidirectional
//!   Dynamic:  [TcpListener]   accept → SOCKS5 handshake → channel_open_direct_tcpip → copy_bidirectional
//!
//! Teardown is driven by a `oneshot::Sender<()>` per forward (`stop_tx`).
//! Dropping it triggers the listener task to exit; per-connection pumps
//! die naturally when either side EOFs.

use std::collections::HashMap;
use std::sync::{Arc, Mutex as StdMutex};

use serde::{Deserialize, Serialize};
use tokio::sync::{mpsc, oneshot, Mutex, RwLock};

use russh::{client::Msg, Channel};

pub mod local;
pub mod remote;
pub mod socks5;
pub mod dynamic;

#[derive(Clone, Copy, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum ForwardKind { Local, Remote, Dynamic }

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct ForwardSpec {
    pub name:      String,
    pub kind:      ForwardKind,
    pub bind_addr: String,
    pub bind_port: u16,
    pub dest_addr: String,   // "" for Dynamic
    pub dest_port: u16,      //  0 for Dynamic
}

/// `Starting` and `Restarting` cross the JSON boundary as part of the
/// status-event payload but aren't (yet) emitted by Rust — the runtime
/// jumps straight to `Running` on a successful bind. They stay in the
/// enum so the frontend's exhaustive `ForwardStatus` discriminator
/// covers every payload it may need to render during edit-in-place.
#[derive(Clone, Debug, Serialize)]
#[serde(tag = "status", rename_all = "lowercase")]
#[allow(dead_code)]
pub enum ForwardStatus {
    Starting,
    Running,
    Restarting,
    Stopped,
    Error { message: String },
}

pub struct RuntimeForward {
    pub id:            u64,
    pub persistent_id: Option<i64>,
    pub spec:          ForwardSpec,
    pub status:        StdMutex<ForwardStatus>,
    pub stop_tx:       Mutex<Option<oneshot::Sender<()>>>,
}

#[derive(Clone, Serialize)]
pub struct RuntimeForwardSummary {
    pub runtime_id:    u64,
    pub persistent_id: Option<i64>,
    pub spec:          ForwardSpec,
    pub status:        ForwardStatus,
}

impl RuntimeForward {
    pub fn summary(&self) -> RuntimeForwardSummary {
        RuntimeForwardSummary {
            runtime_id:    self.id,
            persistent_id: self.persistent_id,
            spec:          self.spec.clone(),
            status:        self.status.lock().expect("forward status poisoned").clone(),
        }
    }

    pub fn set_status(&self, s: ForwardStatus) {
        *self.status.lock().expect("forward status poisoned") = s;
    }
}

/// Per-Connection registry of live forwards plus the dispatch table that
/// routes inbound `forwarded-tcpip` channels (Remote forwards) back to
/// the owning forward's task. The dispatch `Arc` is shared with the
/// owning `ClientHandler` so the russh callback can route without
/// reaching back through `AppState`.
#[derive(Default)]
pub struct Forwards {
    pub by_id:    RwLock<HashMap<u64, Arc<RuntimeForward>>>,
    pub next_id:  std::sync::atomic::AtomicU64,
    pub dispatch: Arc<RwLock<HashMap<(String, u32), mpsc::Sender<Channel<Msg>>>>>,
}

impl Forwards {
    /// Construct a `Forwards` that shares its dispatch map with an
    /// already-built `ClientHandler`. Used by `connect_impl`.
    pub fn with_dispatch(
        dispatch: Arc<RwLock<HashMap<(String, u32), mpsc::Sender<Channel<Msg>>>>>,
    ) -> Self {
        Self {
            by_id: Default::default(),
            next_id: Default::default(),
            dispatch,
        }
    }

    pub fn alloc_id(&self) -> u64 {
        use std::sync::atomic::Ordering;
        self.next_id.fetch_add(1, Ordering::Relaxed) + 1
    }

    pub async fn insert(&self, rf: Arc<RuntimeForward>) {
        self.by_id.write().await.insert(rf.id, rf);
    }

    pub async fn remove(&self, id: u64) -> Option<Arc<RuntimeForward>> {
        self.by_id.write().await.remove(&id)
    }

    pub async fn list(&self) -> Vec<RuntimeForwardSummary> {
        self.by_id.read().await.values().map(|rf| rf.summary()).collect()
    }

    /// Tear down every live forward. Called from `Connection::close()`
    /// before the russh handle is dropped, so listener tasks have a
    /// chance to exit cleanly (Remote needs the handle for
    /// `cancel_tcpip_forward`).
    pub async fn stop_all(&self) {
        let ids: Vec<u64> = self.by_id.read().await.keys().copied().collect();
        for id in ids {
            if let Some(rf) = self.by_id.write().await.remove(&id) {
                if let Some(tx) = rf.stop_tx.lock().await.take() {
                    let _ = tx.send(());
                }
            }
        }
    }
}
