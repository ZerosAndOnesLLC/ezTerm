use std::sync::atomic::{AtomicI64, AtomicU32};
use std::sync::Arc;

use sqlx::SqlitePool;
use tokio::sync::RwLock;

use crate::local::LocalRegistry;
use crate::sftp::SftpRegistry;
use crate::ssh::ConnectionRegistry;
use crate::vault::VaultState;

pub struct AppState {
    pub db: SqlitePool,
    pub vault: RwLock<VaultState>,
    /// Consecutive failed `vault_unlock` attempts. Reset on a successful unlock.
    pub unlock_failures: AtomicU32,
    /// Unix timestamp (seconds) until which new unlock attempts are refused.
    /// Zero means no cooldown is active.
    pub unlock_locked_until_unix: AtomicI64,
    /// SSH connection registry. Wrapped in `Arc` so the per-connection driver
    /// task (`ssh::client::drive_channel`) can hold its own reference and clean
    /// up on EOF/Close/ExitStatus without needing access to `State<AppState>`.
    pub ssh: Arc<ConnectionRegistry>,
    /// SFTP session registry. Wrapped in `Arc` for the same reason as `ssh`:
    /// the SSH driver task must be able to drop SFTP state when the underlying
    /// transport dies, otherwise `SftpHandle`s leak past connection teardown.
    pub sftp: Arc<SftpRegistry>,
    /// Local PTY connection registry — WSL distros and local shells. Uses
    /// its own id space (offset ≥ 2⁴⁸) so ids never collide with SSH.
    pub local: Arc<LocalRegistry>,
}

impl AppState {
    pub fn new(db: SqlitePool) -> Self {
        Self {
            db,
            vault: RwLock::new(VaultState::Locked),
            unlock_failures: AtomicU32::new(0),
            unlock_locked_until_unix: AtomicI64::new(0),
            ssh: Arc::new(ConnectionRegistry::new()),
            sftp: Arc::new(SftpRegistry::new()),
            local: Arc::new(LocalRegistry::new()),
        }
    }

    /// Drop all per-connection state in the correct order: SFTP first (so any
    /// lingering `SftpHandle` is released before the transport goes away),
    /// then the SSH connection itself (which also signals the driver task to
    /// disconnect). Idempotent: safe to call from both the user-initiated
    /// `ssh_disconnect` command and the driver task's own exit branches.
    pub async fn close_connection(&self, id: u64) {
        self.sftp.remove(id).await;
        self.ssh.close(id).await;
    }
}
