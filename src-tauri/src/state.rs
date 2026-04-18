use sqlx::SqlitePool;
use tokio::sync::RwLock;

use crate::vault::VaultState;

pub struct AppState {
    pub db: SqlitePool,
    pub vault: RwLock<VaultState>,
}

impl AppState {
    pub fn new(db: SqlitePool) -> Self {
        Self { db, vault: RwLock::new(VaultState::Locked) }
    }
}
