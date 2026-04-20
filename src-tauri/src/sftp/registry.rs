use std::collections::HashMap;
use std::sync::Arc;

use tokio::sync::RwLock;

use super::session::SftpHandle;

#[derive(Default)]
pub struct SftpRegistry {
    inner: RwLock<HashMap<u64, Arc<SftpHandle>>>,
}

impl SftpRegistry {
    pub fn new() -> Self {
        Self::default()
    }

    pub async fn insert(&self, connection_id: u64, handle: SftpHandle) {
        self.inner
            .write()
            .await
            .insert(connection_id, Arc::new(handle));
    }

    #[allow(dead_code)] // consumed by Bundle 2 (sftp_list/mkdir/etc.)
    pub async fn get(&self, connection_id: u64) -> Option<Arc<SftpHandle>> {
        self.inner.read().await.get(&connection_id).cloned()
    }

    pub async fn remove(&self, connection_id: u64) {
        self.inner.write().await.remove(&connection_id);
    }
}
