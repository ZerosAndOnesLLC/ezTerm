use std::sync::atomic::{AtomicI64, AtomicU32};
use std::sync::Arc;

use sqlx::SqlitePool;
use tokio::sync::RwLock;

use crate::local::LocalRegistry;
use crate::sftp::SftpRegistry;
use crate::ssh::ConnectionRegistry;
use crate::sync::SyncManager;
use crate::vault::VaultState;
use crate::xserver::XServerManager;

pub struct AppState {
    pub db: SqlitePool,
    pub vault: Arc<RwLock<VaultState>>,
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
    /// VcXsrv lifecycle manager. Ref-counted per X11 display; the first
    /// SSH session with forward_x11 enabled starts it, the last one
    /// closing stops it.
    pub xserver: Arc<XServerManager>,
    /// Cloud sync manager. Call `.trigger()` after any user-data mutation
    /// to enqueue a debounced write to the configured destination.
    pub sync: Arc<SyncManager>,
}

impl AppState {
    pub fn new(db: SqlitePool) -> Self {
        let vault = Arc::new(RwLock::new(VaultState::Locked));
        let sync = Arc::new(SyncManager::spawn(db.clone(), vault.clone()));
        Self {
            db,
            vault,
            unlock_failures: AtomicU32::new(0),
            unlock_locked_until_unix: AtomicI64::new(0),
            ssh: Arc::new(ConnectionRegistry::new()),
            sftp: Arc::new(SftpRegistry::new()),
            local: Arc::new(LocalRegistry::new()),
            xserver: Arc::new(XServerManager::new()),
            sync,
        }
    }

    /// Drop all per-connection state in the correct order: SFTP first (so any
    /// lingering `SftpHandle` is released before the transport goes away),
    /// then the SSH connection itself (which also signals the driver task to
    /// disconnect). Idempotent: safe to call from both the user-initiated
    /// `ssh_disconnect` command and the driver task's own exit branches.
    ///
    /// X11 display ref counts are NOT touched here — the driver task that
    /// owns the connection handles `xserver.release(display)` in its
    /// cleanup branch (so a remote-initiated EOF releases the ref the same
    /// way a user disconnect does, no matter which path runs first).
    pub async fn close_connection(&self, id: u64) {
        self.sftp.remove(id).await;
        self.ssh.close(id).await;
    }
}
