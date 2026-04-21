//! Cloud sync — Phase 1: auto-backup to a user-chosen folder.
//!
//! Intended use: point at a folder synced by Dropbox / OneDrive / iCloud /
//! Google Drive for Desktop, and the user's encrypted backup stays in sync
//! across devices without ezTerm needing to know anything about those
//! services. On every mutation (create/update/delete across sessions,
//! folders, credentials, known-hosts) we enqueue a "write latest" trigger;
//! a background task debounces for a few seconds then writes a fresh
//! encrypted backup to the configured path.
//!
//! Phase 2 will add an S3-compatible driver behind the same `SyncManager`
//! interface with ETag-based conflict detection.

use std::path::PathBuf;
use std::sync::atomic::{AtomicI64, Ordering};
use std::sync::Arc;
use std::time::Duration;

use chrono::Utc;
use tokio::sync::{mpsc, RwLock};

use crate::backup;
use crate::db;
use crate::error::{AppError, Result};
use crate::vault;

/// Delay between trigger and actual write. Coalesces rapid edits (bulk
/// import, drag-drop moves, etc.) into a single file write.
const DEBOUNCE_SECS: u64 = 3;

/// Default filename written into the configured folder. Fixed name so
/// cloud-provider sync sees one file, not a growing pile of timestamped
/// artifacts. Users can rotate their own backups with `Backup…` manually.
pub const LOCAL_FILENAME: &str = "ezterm-sync.json";

// ===== settings keys =====================================================

/// Active sync backend. Values: `"none"` | `"local"` (phase 2 adds `"s3"`).
pub const KEY_KIND: &str = "sync.kind";
pub const KEY_LOCAL_PATH: &str = "sync.local.path";
/// Backup passphrase, stored as base64(nonce || ciphertext) encrypted
/// under the vault key. Required so the sync task can run without user
/// interaction on every mutation.
pub const KEY_LOCAL_PASSPHRASE_BLOB: &str = "sync.local.passphrase_blob";
/// RFC 3339 timestamp of the last successful write. Pure UI metadata.
pub const KEY_LAST_SUCCESS_AT: &str = "sync.last_success_at";
/// Error message from the last failed write (UI surfaces via `sync_status`).
pub const KEY_LAST_ERROR: &str = "sync.last_error";

// ===== public types ======================================================

#[derive(Clone, Debug)]
pub enum SyncTarget {
    /// Sync disabled.
    None,
    /// Write encrypted backup to `<path>/ezterm-sync.json`.
    LocalFolder {
        path: PathBuf,
        /// Passphrase used to wrap the backup — held decrypted in memory
        /// so the trigger task doesn't need to re-ask per write.
        passphrase: String,
    },
}

#[derive(Clone, Debug, Default, serde::Serialize)]
pub struct SyncStatus {
    pub kind:            String,     // 'none' | 'local'
    pub local_path:      Option<String>,
    pub last_success_at: Option<String>,
    pub last_error:      Option<String>,
    pub pending:         bool,
}

// ===== SyncManager =======================================================

/// Lives in `AppState`. Holds the active target + a trigger channel to the
/// debounced background writer. Swapping targets is atomic: callers flip
/// the Arc<RwLock<SyncTarget>> value and the writer picks up the new
/// target on the next tick.
pub struct SyncManager {
    target: Arc<RwLock<SyncTarget>>,
    tx: mpsc::UnboundedSender<()>,
    /// Pending-trigger flag surfaced through `status()`. Set when a mutation
    /// fires; cleared when the writer finishes (successfully or not).
    pending: Arc<std::sync::atomic::AtomicBool>,
    /// Unix ms of last successful write. Read by status() without a lock.
    last_success_ms: Arc<AtomicI64>,
}

impl SyncManager {
    /// Build a fresh manager with sync disabled and spawn the debounced
    /// writer task. Call `reload_from_db` after the vault unlocks to hydrate
    /// the target from settings.
    pub fn spawn(
        db_pool: sqlx::SqlitePool,
        vault_state: Arc<tokio::sync::RwLock<vault::VaultState>>,
    ) -> Self {
        let target: Arc<RwLock<SyncTarget>> = Arc::new(RwLock::new(SyncTarget::None));
        let (tx, rx) = mpsc::unbounded_channel::<()>();
        let pending = Arc::new(std::sync::atomic::AtomicBool::new(false));
        let last_success_ms = Arc::new(AtomicI64::new(0));

        let writer = WriterTask {
            target: target.clone(),
            db_pool,
            vault_state,
            pending: pending.clone(),
            last_success_ms: last_success_ms.clone(),
        };
        tokio::spawn(writer.run(rx));

        Self {
            target,
            tx,
            pending,
            last_success_ms,
        }
    }

    /// Request a new backup write — coalesces with any pending request.
    pub fn trigger(&self) {
        self.pending
            .store(true, std::sync::atomic::Ordering::Release);
        let _ = self.tx.send(());
    }

    pub async fn set_target(&self, new_target: SyncTarget) {
        *self.target.write().await = new_target;
    }

    pub async fn target_kind(&self) -> &'static str {
        match &*self.target.read().await {
            SyncTarget::None => "none",
            SyncTarget::LocalFolder { .. } => "local",
        }
    }

    pub async fn local_path(&self) -> Option<PathBuf> {
        match &*self.target.read().await {
            SyncTarget::LocalFolder { path, .. } => Some(path.clone()),
            _ => None,
        }
    }

    pub fn pending_flag(&self) -> bool {
        self.pending.load(std::sync::atomic::Ordering::Acquire)
    }

    pub fn last_success_ms(&self) -> i64 {
        self.last_success_ms.load(Ordering::Acquire)
    }

    /// Load sync config out of app_settings and apply. Called after vault
    /// unlock (needs the vault key to decrypt the stored passphrase).
    pub async fn reload_from_db(
        &self,
        pool: &sqlx::SqlitePool,
        vault_state: &vault::VaultState,
    ) -> Result<()> {
        let kind = db::settings::get(pool, KEY_KIND).await?.unwrap_or_default();
        let new_target = match kind.as_str() {
            "local" => load_local_target(pool, vault_state).await?,
            _ => SyncTarget::None,
        };
        self.set_target(new_target).await;
        Ok(())
    }
}

async fn load_local_target(
    pool: &sqlx::SqlitePool,
    vault_state: &vault::VaultState,
) -> Result<SyncTarget> {
    let path = db::settings::get(pool, KEY_LOCAL_PATH)
        .await?
        .ok_or_else(|| AppError::Validation("sync.local.path missing".into()))?;
    let blob_b64 = db::settings::get(pool, KEY_LOCAL_PASSPHRASE_BLOB)
        .await?
        .ok_or_else(|| AppError::Validation("sync.local.passphrase missing".into()))?;
    let passphrase = decrypt_stored_blob(&blob_b64, vault_state)?;
    Ok(SyncTarget::LocalFolder {
        path: PathBuf::from(path),
        passphrase,
    })
}

pub fn encrypt_stored_blob(plaintext: &str, vault_state: &vault::VaultState) -> Result<String> {
    use base64::{engine::general_purpose::STANDARD as B64, Engine};
    let (nonce, ct) = vault::encrypt_with(vault_state, plaintext.as_bytes())?;
    let mut combined = Vec::with_capacity(nonce.len() + ct.len());
    combined.extend_from_slice(&nonce);
    combined.extend_from_slice(&ct);
    Ok(B64.encode(&combined))
}

fn decrypt_stored_blob(blob_b64: &str, vault_state: &vault::VaultState) -> Result<String> {
    use base64::{engine::general_purpose::STANDARD as B64, Engine};
    let bytes = B64
        .decode(blob_b64)
        .map_err(|_| AppError::Validation("stored blob not base64".into()))?;
    if bytes.len() < vault::aead::NONCE_LEN {
        return Err(AppError::Crypto);
    }
    let (nonce, ct) = bytes.split_at(vault::aead::NONCE_LEN);
    let pt = vault::decrypt_with(vault_state, nonce, ct)?;
    String::from_utf8(pt).map_err(|_| AppError::Crypto)
}

// ===== writer task =======================================================

struct WriterTask {
    target: Arc<RwLock<SyncTarget>>,
    db_pool: sqlx::SqlitePool,
    vault_state: Arc<tokio::sync::RwLock<vault::VaultState>>,
    pending: Arc<std::sync::atomic::AtomicBool>,
    last_success_ms: Arc<AtomicI64>,
}

impl WriterTask {
    async fn run(self, mut rx: mpsc::UnboundedReceiver<()>) {
        loop {
            // Block until at least one trigger arrives.
            if rx.recv().await.is_none() {
                break;
            }
            // Debounce: sleep, draining further triggers that land during
            // the wait so we coalesce into a single write.
            tokio::time::sleep(Duration::from_secs(DEBOUNCE_SECS)).await;
            while rx.try_recv().is_ok() {}

            // Snapshot the target under a short read.
            let target_snapshot = self.target.read().await.clone();
            match target_snapshot {
                SyncTarget::None => {
                    // Sync disabled since the trigger fired. Clear pending
                    // and move on — the trigger channel is idempotent.
                    self.pending
                        .store(false, std::sync::atomic::Ordering::Release);
                    continue;
                }
                SyncTarget::LocalFolder { path, passphrase } => {
                    let outcome = self
                        .build_and_write_local(&path, &passphrase)
                        .await;
                    self.finish(outcome).await;
                }
            }
        }
    }

    async fn build_and_write_local(&self, path: &std::path::Path, passphrase: &str) -> Result<()> {
        use base64::{engine::general_purpose::STANDARD as B64, Engine};
        // Collect every data type. Credentials are decrypted on the fly
        // (need the unlocked vault) so the bundle carries plaintexts
        // protected only by the backup passphrase.
        let folders = db::folders::list(&self.db_pool).await?;
        let sessions_raw = db::sessions::list(&self.db_pool).await?;
        let mut sessions = Vec::with_capacity(sessions_raw.len());
        for s in sessions_raw {
            let env = db::sessions::env_get(&self.db_pool, s.id).await?;
            sessions.push(backup::SessionEntry { session: s, env });
        }
        let cred_metas = db::credentials::list(&self.db_pool).await?;
        let mut credentials = Vec::with_capacity(cred_metas.len());
        {
            let vs = self.vault_state.read().await;
            if !vs.is_unlocked() {
                return Err(AppError::VaultLocked);
            }
            for meta in cred_metas {
                let row = db::credentials::get(&self.db_pool, meta.id).await?;
                let pt = vault::decrypt_with(&vs, &row.nonce, &row.ciphertext)?;
                credentials.push(backup::CredentialEntry {
                    id: meta.id,
                    kind: meta.kind,
                    label: meta.label,
                    secret_b64: B64.encode(&pt),
                });
            }
        }
        let known_hosts = db::known_hosts::list(&self.db_pool).await?;
        let settings = db::settings::list_all(&self.db_pool)
            .await?
            .into_iter()
            .map(|(k, v)| backup::SettingEntry { key: k, value: v })
            .collect();

        let bundle = backup::Bundle {
            version: backup::BACKUP_VERSION,
            created_at: Utc::now().to_rfc3339(),
            app_version: env!("CARGO_PKG_VERSION").to_string(),
            folders,
            sessions,
            credentials,
            known_hosts,
            settings,
        };

        let bytes = backup::encrypt_bundle(&bundle, passphrase)?;

        // Atomic write: tempfile in same directory then rename. Avoids
        // cloud-sync readers picking up a half-written file.
        tokio::fs::create_dir_all(path).await?;
        let final_path = path.join(LOCAL_FILENAME);
        let tmp_path = path.join(format!("{LOCAL_FILENAME}.tmp"));
        tokio::fs::write(&tmp_path, &bytes).await?;
        if final_path.exists() {
            tokio::fs::remove_file(&final_path).await?;
        }
        tokio::fs::rename(&tmp_path, &final_path).await?;
        Ok(())
    }

    async fn finish(&self, outcome: Result<()>) {
        self.pending
            .store(false, std::sync::atomic::Ordering::Release);
        match outcome {
            Ok(()) => {
                let now = Utc::now();
                self.last_success_ms
                    .store(now.timestamp_millis(), Ordering::Release);
                let _ = db::settings::set(
                    &self.db_pool,
                    KEY_LAST_SUCCESS_AT,
                    &now.to_rfc3339(),
                )
                .await;
                let _ = db::settings::set(&self.db_pool, KEY_LAST_ERROR, "").await;
            }
            Err(e) => {
                let msg = e.to_string();
                tracing::warn!("sync write failed: {msg}");
                let _ = db::settings::set(&self.db_pool, KEY_LAST_ERROR, &msg).await;
            }
        }
    }
}
