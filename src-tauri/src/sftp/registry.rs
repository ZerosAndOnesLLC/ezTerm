use std::collections::HashMap;
use std::sync::Arc;

use tokio::sync::RwLock;

use super::session::SftpHandle;
use crate::wslfs::WslFsHandle;

/// One per active file-browser pane. We dispatch on this rather than
/// keying two registries because every `sftp_*` command takes a
/// connection-id and the routing decision needs to happen at command
/// entry. Holding the enum centrally means the SSH disconnect path and
/// vault rotation flows tear down both kinds with the same call.
pub enum FileBrowser {
    /// Real SFTP over an SSH channel.
    Sftp(SftpHandle),
    /// WSL adapter — Plan 9 + shell-outs to the distro's coreutils.
    Wsl(WslFsHandle),
}

#[derive(Default)]
pub struct SftpRegistry {
    inner: RwLock<HashMap<u64, Arc<FileBrowser>>>,
}

impl SftpRegistry {
    pub fn new() -> Self {
        Self::default()
    }

    pub async fn insert(&self, connection_id: u64, browser: FileBrowser) {
        self.inner
            .write()
            .await
            .insert(connection_id, Arc::new(browser));
    }

    pub async fn get(&self, connection_id: u64) -> Option<Arc<FileBrowser>> {
        self.inner.read().await.get(&connection_id).cloned()
    }

    pub async fn remove(&self, connection_id: u64) {
        self.inner.write().await.remove(&connection_id);
    }

    /// All currently-registered connection ids. Used by vault rotation
    /// flows that need to tear every active SFTP session down.
    pub async fn list_ids(&self) -> Vec<u64> {
        self.inner.read().await.keys().copied().collect()
    }
}
