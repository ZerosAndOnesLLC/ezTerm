use std::sync::atomic::{AtomicI64, AtomicU32};

use sqlx::SqlitePool;
use tokio::sync::RwLock;

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
    pub ssh: ConnectionRegistry,
}

impl AppState {
    pub fn new(db: SqlitePool) -> Self {
        Self {
            db,
            vault: RwLock::new(VaultState::Locked),
            unlock_failures: AtomicU32::new(0),
            unlock_locked_until_unix: AtomicI64::new(0),
            ssh: ConnectionRegistry::new(),
        }
    }
}
