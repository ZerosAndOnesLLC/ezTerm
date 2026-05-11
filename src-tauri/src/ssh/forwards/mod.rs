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
use std::sync::{Arc, Mutex as StdMutex, RwLock as StdRwLock};

use serde::{Deserialize, Serialize};
use tokio::sync::{mpsc, oneshot, Mutex, RwLock};

use russh::{client::Msg, Channel};

use crate::error::{AppError, Result};

pub mod local;
pub mod remote;
pub mod socks5;
pub mod dynamic;

/// Copy-bidirectional buffer size for all forward kinds. SSH max packet
/// size is ~64 KiB on modern servers; matching it lets a single stream
/// fill the SSH channel window between window-adjust round-trips.
pub const COPY_BUF: usize = 64 * 1024;

/// Cap on concurrent in-flight pumps per forward. Sheds excess load
/// (`try_acquire_owned` drops the accept) instead of letting tasks pile
/// up under accept floods.
pub const MAX_INFLIGHT_PER_FORWARD: usize = 256;

/// SOCKS5 / Local / Dynamic per-stage read timeout. A client that
/// dribbles bytes (slowloris) loses its task + FD after this.
pub const SOCKS5_READ_TIMEOUT_SECS: u64 = 10;

/// Parse `bind_addr` into a `SocketAddr`. Accepts an IPv4/IPv6 literal
/// or the special `localhost` alias; rejects unparseable values. Needed
/// so IPv6 literals like `::1` produce the right `SocketAddr` rather
/// than the surprise `format!("{}:{}", "::1", 5432)` mash-up.
pub fn bind_socket(bind_addr: &str, port: u16) -> Result<std::net::SocketAddr> {
    let trimmed = bind_addr.trim();
    if trimmed.eq_ignore_ascii_case("localhost") {
        return Ok(std::net::SocketAddr::from(([127, 0, 0, 1], port)));
    }
    let ip: std::net::IpAddr = trimmed.parse().map_err(|_| {
        AppError::Validation(format!(
            "bind_addr {trimmed:?} must be an IP literal or `localhost`",
        ))
    })?;
    Ok(std::net::SocketAddr::new(ip, port))
}

/// Format a bind-failure error message. Detects `AddrInUse` and emits
/// the friendlier "another ezTerm tab?" hint promised by the spec.
pub fn format_bind_error(bind_addr: &str, port: u16, err: &std::io::Error) -> String {
    if err.kind() == std::io::ErrorKind::AddrInUse {
        format!(
            "bind {bind_addr}:{port} in use (another ezTerm tab, or a different app on this port?)"
        )
    } else if err.kind() == std::io::ErrorKind::PermissionDenied {
        format!(
            "bind {bind_addr}:{port} permission denied (ports below 1024 typically require admin/root)"
        )
    } else {
        format!("bind {bind_addr}:{port}: {err}")
    }
}

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

/// Forward lifecycle states. The runtime emits `Running` (after a
/// successful bind / `tcpip_forward`), `Stopped` (after the listener
/// task exits cleanly), and `Error { message }` (bind failure, accept
/// failure, server-side reject). Edit-while-running is implemented as
/// stop + re-start, surfacing as a `Stopped → Running` transition.
#[derive(Clone, Debug, Serialize)]
#[serde(tag = "status", rename_all = "lowercase")]
pub enum ForwardStatus {
    Running,
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
///
/// `dispatch` is `std::sync::RwLock` (not tokio's) because the russh
/// callback reads it under a `&mut self` async context but only holds
/// the lock long enough to clone an `UnboundedSender` out — no awaits
/// while held.
#[derive(Default)]
pub struct Forwards {
    pub by_id:    RwLock<HashMap<u64, Arc<RuntimeForward>>>,
    pub next_id:  std::sync::atomic::AtomicU64,
    pub dispatch: Arc<StdRwLock<HashMap<(String, u32), mpsc::UnboundedSender<Channel<Msg>>>>>,
}

impl Forwards {
    /// Construct a `Forwards` that shares its dispatch map with an
    /// already-built `ClientHandler`. Used by `connect_impl`.
    pub fn with_dispatch(
        dispatch: Arc<StdRwLock<HashMap<(String, u32), mpsc::UnboundedSender<Channel<Msg>>>>>,
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
