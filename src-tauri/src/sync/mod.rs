//! Cloud sync — auto-backup to a local folder (phase 1) or to an
//! S3-compatible bucket (phase 2).
//!
//! Phase 1 — local folder: point at a folder synced by Dropbox / OneDrive /
//! iCloud / Google Drive and the encrypted backup stays in sync across
//! devices without ezTerm touching the cloud provider's APIs.
//!
//! Phase 2 — S3: direct PUT/HEAD/GET on a single object in the user's
//! bucket (AWS, R2, B2, Wasabi, MinIO, …). ETag-based optimistic
//! conflict check: HEAD before PUT, refuse to overwrite if the remote
//! ETag drifted from our last-known value.

pub mod s3;

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

/// Active sync backend. Values: `"none"` | `"local"` | `"s3"`.
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

// S3 keys. The access-key ID is not secret-grade on its own so we store
// it in plaintext; the secret access key and the backup passphrase are
// vault-encrypted blobs.
pub const KEY_S3_ENDPOINT:      &str = "sync.s3.endpoint";
pub const KEY_S3_REGION:        &str = "sync.s3.region";
pub const KEY_S3_BUCKET:        &str = "sync.s3.bucket";
pub const KEY_S3_PREFIX:        &str = "sync.s3.prefix";
pub const KEY_S3_ACCESS_KEY_ID: &str = "sync.s3.access_key_id";
pub const KEY_S3_SECRET_BLOB:   &str = "sync.s3.secret_blob";
pub const KEY_S3_PASSPHRASE_BLOB: &str = "sync.s3.passphrase_blob";
/// Last remote ETag this device observed — used for optimistic conflict
/// detection before every push and to decide whether a startup pull has
/// anything to bring in.
pub const KEY_S3_LAST_ETAG:     &str = "sync.s3.last_etag";

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
    /// PUT the encrypted backup to `<prefix>/ezterm-sync.json` in the
    /// configured S3-compatible bucket.
    S3 {
        endpoint:          String,
        region:            String,
        bucket:            String,
        prefix:            String,
        access_key_id:     String,
        secret_access_key: String,
        passphrase:        String,
    },
}

#[derive(Clone, Debug, Default, serde::Serialize)]
pub struct SyncStatus {
    pub kind:            String,     // 'none' | 'local' | 's3'
    pub local_path:      Option<String>,
    pub s3_endpoint:     Option<String>,
    pub s3_bucket:       Option<String>,
    pub s3_prefix:       Option<String>,
    pub s3_region:       Option<String>,
    pub s3_access_key_id: Option<String>,
    pub s3_last_etag:    Option<String>,
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
            SyncTarget::S3 { .. } => "s3",
        }
    }

    pub async fn local_path(&self) -> Option<PathBuf> {
        match &*self.target.read().await {
            SyncTarget::LocalFolder { path, .. } => Some(path.clone()),
            _ => None,
        }
    }

    /// Immutable snapshot of the active S3 config for ad-hoc operations
    /// like pull-now (downloads the remote bundle). Caller must make sure
    /// the vault is unlocked.
    pub async fn s3_target(&self) -> Option<SyncTarget> {
        match &*self.target.read().await {
            s3 @ SyncTarget::S3 { .. } => Some(s3.clone()),
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
            "s3" => load_s3_target(pool, vault_state).await?,
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

async fn load_s3_target(
    pool: &sqlx::SqlitePool,
    vault_state: &vault::VaultState,
) -> Result<SyncTarget> {
    let endpoint = db::settings::get(pool, KEY_S3_ENDPOINT).await?
        .ok_or_else(|| AppError::Validation("sync.s3.endpoint missing".into()))?;
    let region = db::settings::get(pool, KEY_S3_REGION).await?.unwrap_or_else(|| "auto".into());
    let bucket = db::settings::get(pool, KEY_S3_BUCKET).await?
        .ok_or_else(|| AppError::Validation("sync.s3.bucket missing".into()))?;
    let prefix = db::settings::get(pool, KEY_S3_PREFIX).await?.unwrap_or_default();
    let access_key_id = db::settings::get(pool, KEY_S3_ACCESS_KEY_ID).await?
        .ok_or_else(|| AppError::Validation("sync.s3.access_key_id missing".into()))?;
    let secret_blob = db::settings::get(pool, KEY_S3_SECRET_BLOB).await?
        .ok_or_else(|| AppError::Validation("sync.s3.secret missing".into()))?;
    let secret_access_key = decrypt_stored_blob(&secret_blob, vault_state)?;
    let passphrase_blob = db::settings::get(pool, KEY_S3_PASSPHRASE_BLOB).await?
        .ok_or_else(|| AppError::Validation("sync.s3.passphrase missing".into()))?;
    let passphrase = decrypt_stored_blob(&passphrase_blob, vault_state)?;
    Ok(SyncTarget::S3 {
        endpoint, region, bucket, prefix, access_key_id, secret_access_key, passphrase,
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
                SyncTarget::S3 {
                    endpoint, region, bucket, prefix,
                    access_key_id, secret_access_key, passphrase,
                } => {
                    let outcome = self
                        .build_and_push_s3(
                            &endpoint, &region, &bucket, &prefix,
                            &access_key_id, &secret_access_key, &passphrase,
                        )
                        .await;
                    self.finish(outcome).await;
                }
            }
        }
    }

    /// Build the encrypted bundle and PUT it to S3. Includes the ETag
    /// conflict check: if a prior push stored an ETag, HEAD the object
    /// first and refuse to overwrite if the remote drifted.
    #[allow(clippy::too_many_arguments)]
    async fn build_and_push_s3(
        &self,
        endpoint: &str, region: &str, bucket: &str, prefix: &str,
        access_key_id: &str, secret_access_key: &str, passphrase: &str,
    ) -> Result<()> {
        let bundle = self.build_bundle().await?;
        let bytes = backup::encrypt_bundle(&bundle, passphrase)?;

        let driver = s3::S3Driver::new(s3::S3Config {
            endpoint, region, bucket, prefix,
            access_key_id, secret_access_key,
        })?;

        // Optimistic conflict check: if we have a last-known ETag, HEAD
        // the object and bail if the remote is newer than what we last
        // saw. The user can resolve by pulling first (sync_pull_preview
        // / sync_pull_commit) and then retrying.
        let known = db::settings::get(&self.db_pool, KEY_S3_LAST_ETAG).await?
            .filter(|s| !s.is_empty());
        if let Some(known) = known.as_deref() {
            if let Some(remote) = driver.head().await? {
                if remote != known {
                    return Err(AppError::Validation(format!(
                        "remote S3 object changed since last sync (remote ETag {remote}, \
                         last known {known}) — pull first to merge"
                    )));
                }
            }
        }

        let new_etag = driver.put(&bytes).await?;
        db::settings::set(&self.db_pool, KEY_S3_LAST_ETAG, &new_etag).await?;
        Ok(())
    }

    /// Shared bundle-building path — collects all tables, decrypts every
    /// credential, and produces the Bundle struct. Used by both the
    /// local-folder and S3 writers.
    async fn build_bundle(&self) -> Result<backup::Bundle> {
        use base64::{engine::general_purpose::STANDARD as B64, Engine};
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
        let settings = db::settings::list_all(&self.db_pool).await?
            .into_iter()
            .map(|(k, v)| backup::SettingEntry { key: k, value: v })
            .collect();
        Ok(backup::Bundle {
            version: backup::BACKUP_VERSION,
            created_at: Utc::now().to_rfc3339(),
            app_version: env!("CARGO_PKG_VERSION").to_string(),
            folders,
            sessions,
            credentials,
            known_hosts,
            settings,
        })
    }

    async fn build_and_write_local(&self, path: &std::path::Path, passphrase: &str) -> Result<()> {
        let bundle = self.build_bundle().await?;
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
