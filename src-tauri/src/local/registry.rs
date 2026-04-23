use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex as StdMutex};

use tokio::sync::{mpsc, RwLock};

pub struct Connection {
    pub id: u64,
    pub stdin: mpsc::UnboundedSender<LocalInput>,
    /// Gates the reader thread on the frontend signalling that its
    /// `ssh:data:<id>` listener is installed. Without this, ConPTY's
    /// prompt bytes race the Tauri `listen()` round-trip on first
    /// connect and the terminal shows blank until a reconnect. Once
    /// `unlock_reader` takes the sender and sends `()`, the reader
    /// thread enters its normal read loop. Subsequent calls are no-ops.
    pub reader_gate: StdMutex<Option<std::sync::mpsc::Sender<()>>>,
}

pub enum LocalInput {
    Bytes(Vec<u8>),
    Resize { cols: u16, rows: u16 },
    Close,
}

#[derive(Default)]
pub struct LocalRegistry {
    next_id: AtomicU64,
    inner: RwLock<HashMap<u64, Arc<Connection>>>,
}

impl LocalRegistry {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn alloc_id(&self) -> u64 {
        // Offset by 1<<48 so local ids can't collide with SSH ids even
        // across long-running sessions. The frontend picks a command
        // family by session_kind, not by id, but this keeps the logs
        // unambiguous if a user pastes an id into a bug report.
        (self.next_id.fetch_add(1, Ordering::Relaxed) + 1) | (1u64 << 48)
    }

    pub async fn insert(&self, conn: Connection) {
        self.inner.write().await.insert(conn.id, Arc::new(conn));
    }

    pub async fn get(&self, id: u64) -> Option<Arc<Connection>> {
        self.inner.read().await.get(&id).cloned()
    }

    pub async fn write(&self, id: u64, bytes: Vec<u8>) -> bool {
        if let Some(c) = self.get(id).await {
            c.stdin.send(LocalInput::Bytes(bytes)).is_ok()
        } else {
            false
        }
    }

    pub async fn resize(&self, id: u64, cols: u16, rows: u16) -> bool {
        if let Some(c) = self.get(id).await {
            c.stdin.send(LocalInput::Resize { cols, rows }).is_ok()
        } else {
            false
        }
    }

    pub async fn close(&self, id: u64) {
        let conn = self.inner.write().await.remove(&id);
        if let Some(c) = conn {
            let _ = c.stdin.send(LocalInput::Close);
        }
    }

    /// Signals the reader thread to start emitting data. Called by the
    /// `local_ready` command once the frontend has its `ssh:data:<id>`
    /// listener installed. Idempotent — subsequent calls are no-ops.
    pub async fn unlock_reader(&self, id: u64) {
        if let Some(c) = self.get(id).await {
            let tx = c.reader_gate.lock().expect("reader_gate poisoned").take();
            if let Some(tx) = tx {
                let _ = tx.send(());
            }
        }
    }
}
