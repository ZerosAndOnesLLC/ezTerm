use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;

use tokio::sync::{mpsc, RwLock};

use russh::client::Handle as RusshHandle;

use crate::ssh::client::ClientHandler;

/// A live SSH session. The write half is an mpsc sender: the command layer
/// enqueues keystrokes and the per-connection writer task drains them to the
/// russh channel. The russh `Handle` is wrapped in `Arc<...>` (no Mutex) —
/// every method we call on it (`channel_open_session`,
/// `channel_open_direct_tcpip`, `tcpip_forward`, `cancel_tcpip_forward`,
/// `disconnect`) takes `&self`, so concurrent access is safe and a Mutex
/// would only serialize SSH channel opens behind one another.
pub struct Connection {
    pub id: u64,
    // host/port/user are captured for future logging and UI surfacing (Plan 3+).
    #[allow(dead_code)]
    pub host: String,
    #[allow(dead_code)]
    pub port: i64,
    #[allow(dead_code)]
    pub user: String,
    pub stdin: mpsc::UnboundedSender<ConnectionInput>,
    /// Shared russh client handle. The driver task holds a clone for the
    /// lifetime of the session so the Close branch can `disconnect(..)`; the
    /// SFTP commands clone this Arc to open a second session channel.
    pub ssh_handle: Arc<RusshHandle<ClientHandler>>,
    /// When `Some(display)`, this session acquired the X server on that
    /// display and must release it on disconnect. The driver task reads
    /// this at teardown. Tagged `allow(dead_code)` because the only
    /// current reader is the closure captured by the driver — Rust's
    /// dead-code lint can't see through that.
    #[allow(dead_code)]
    pub x11_display: Option<u8>,
    /// Per-connection port-forwarding runtime. Created empty at insert
    /// time; populated by `commands::forwards::forward_start` and by
    /// the auto-start scan in `connect_impl`.
    pub forwards: std::sync::Arc<crate::ssh::forwards::Forwards>,
}

pub enum ConnectionInput {
    Bytes(Vec<u8>),
    Resize { cols: u16, rows: u16 },
    Close,
}

#[derive(Default)]
pub struct ConnectionRegistry {
    next_id: AtomicU64,
    inner: RwLock<HashMap<u64, Arc<Connection>>>,
}

impl ConnectionRegistry {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn alloc_id(&self) -> u64 {
        self.next_id.fetch_add(1, Ordering::Relaxed) + 1
    }

    pub async fn insert(&self, conn: Connection) {
        self.inner.write().await.insert(conn.id, Arc::new(conn));
    }

    pub async fn get(&self, id: u64) -> Option<Arc<Connection>> {
        self.inner.read().await.get(&id).cloned()
    }

    pub async fn write(&self, id: u64, bytes: Vec<u8>) -> bool {
        if let Some(conn) = self.get(id).await {
            conn.stdin.send(ConnectionInput::Bytes(bytes)).is_ok()
        } else {
            false
        }
    }

    pub async fn resize(&self, id: u64, cols: u16, rows: u16) -> bool {
        if let Some(conn) = self.get(id).await {
            conn.stdin
                .send(ConnectionInput::Resize { cols, rows })
                .is_ok()
        } else {
            false
        }
    }

    pub async fn close(&self, id: u64) {
        let conn = self.inner.write().await.remove(&id);
        if let Some(c) = conn {
            // Stop forwards before signalling the driver to drop the
            // russh handle — Remote forwards need the handle for
            // cancel_tcpip_forward at teardown.
            c.forwards.stop_all().await;
            let _ = c.stdin.send(ConnectionInput::Close);
        }
    }
}
