use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};

use tokio::sync::{mpsc, Mutex};

/// A live SSH session. The write half is an mpsc sender: the command layer
/// enqueues keystrokes and the per-connection writer task drains them to the
/// russh channel. The ConnectionMeta carries host/port/user for logging and UI.
pub struct Connection {
    pub id: u64,
    pub host: String,
    pub port: i64,
    pub user: String,
    pub stdin: mpsc::UnboundedSender<ConnectionInput>,
}

pub enum ConnectionInput {
    Bytes(Vec<u8>),
    Resize { cols: u16, rows: u16 },
    Close,
}

#[derive(Default)]
pub struct ConnectionRegistry {
    next_id: AtomicU64,
    inner: Mutex<HashMap<u64, Connection>>,
}

impl ConnectionRegistry {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn alloc_id(&self) -> u64 {
        self.next_id.fetch_add(1, Ordering::Relaxed) + 1
    }

    pub async fn insert(&self, conn: Connection) {
        self.inner.lock().await.insert(conn.id, conn);
    }

    pub async fn write(&self, id: u64, bytes: Vec<u8>) -> bool {
        let guard = self.inner.lock().await;
        if let Some(conn) = guard.get(&id) {
            conn.stdin.send(ConnectionInput::Bytes(bytes)).is_ok()
        } else {
            false
        }
    }

    pub async fn resize(&self, id: u64, cols: u16, rows: u16) -> bool {
        let guard = self.inner.lock().await;
        if let Some(conn) = guard.get(&id) {
            conn.stdin
                .send(ConnectionInput::Resize { cols, rows })
                .is_ok()
        } else {
            false
        }
    }

    pub async fn close(&self, id: u64) {
        let conn = self.inner.lock().await.remove(&id);
        if let Some(c) = conn {
            let _ = c.stdin.send(ConnectionInput::Close);
        }
    }
}
