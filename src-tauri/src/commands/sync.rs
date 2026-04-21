//! Cloud-sync Tauri commands (Phase 1 — local folder).

use chrono::{TimeZone, Utc};
use std::path::PathBuf;
use tauri::State;
use zeroize::Zeroize;

use crate::commands::require_unlocked;
use crate::db;
use crate::error::{AppError, Result};
use crate::state::AppState;
use crate::sync::{
    self, SyncStatus, SyncTarget, KEY_KIND, KEY_LAST_ERROR, KEY_LAST_SUCCESS_AT,
    KEY_LOCAL_PASSPHRASE_BLOB, KEY_LOCAL_PATH,
    KEY_S3_ACCESS_KEY_ID, KEY_S3_BUCKET, KEY_S3_ENDPOINT, KEY_S3_LAST_ETAG,
    KEY_S3_PASSPHRASE_BLOB, KEY_S3_PREFIX, KEY_S3_REGION, KEY_S3_SECRET_BLOB,
};

#[tauri::command]
pub async fn sync_status(state: State<'_, AppState>) -> Result<SyncStatus> {
    require_unlocked(&state).await?;

    let kind = state.sync.target_kind().await.to_string();
    let local_path = state
        .sync
        .local_path()
        .await
        .map(|p| p.to_string_lossy().into_owned());
    let last_success_at = db::settings::get(&state.db, KEY_LAST_SUCCESS_AT)
        .await?
        .filter(|s| !s.is_empty());
    let last_error = db::settings::get(&state.db, KEY_LAST_ERROR)
        .await?
        .filter(|s| !s.is_empty());
    // Fall back to the in-memory last_success_ms when settings has
    // nothing yet (e.g. never-saved config). Keeps the UI honest on the
    // first successful push after enabling sync.
    let last_success_at = last_success_at.or_else(|| {
        let ms = state.sync.last_success_ms();
        if ms == 0 {
            None
        } else {
            Utc.timestamp_millis_opt(ms).single().map(|d| d.to_rfc3339())
        }
    });

    // Load S3 display-only fields (endpoint / bucket / region / prefix /
    // access-key id) from settings rather than the in-memory target so the
    // UI can still render the config even when the vault hasn't been
    // unlocked yet on this boot and reload_from_db hasn't run.
    let s3_endpoint = db::settings::get(&state.db, KEY_S3_ENDPOINT).await?.filter(|s| !s.is_empty());
    let s3_region = db::settings::get(&state.db, KEY_S3_REGION).await?.filter(|s| !s.is_empty());
    let s3_bucket = db::settings::get(&state.db, KEY_S3_BUCKET).await?.filter(|s| !s.is_empty());
    let s3_prefix = db::settings::get(&state.db, KEY_S3_PREFIX).await?.filter(|s| !s.is_empty());
    let s3_access_key_id = db::settings::get(&state.db, KEY_S3_ACCESS_KEY_ID).await?.filter(|s| !s.is_empty());
    let s3_last_etag = db::settings::get(&state.db, KEY_S3_LAST_ETAG).await?.filter(|s| !s.is_empty());

    Ok(SyncStatus {
        kind,
        local_path,
        s3_endpoint,
        s3_bucket,
        s3_prefix,
        s3_region,
        s3_access_key_id,
        s3_last_etag,
        last_success_at,
        last_error,
        pending: state.sync.pending_flag(),
    })
}

#[tauri::command]
pub async fn sync_configure_local(
    state: State<'_, AppState>,
    path: String,
    passphrase: String,
) -> Result<()> {
    let mut passphrase = passphrase;
    let result = sync_configure_local_inner(&state, &path, &passphrase).await;
    passphrase.zeroize();
    result
}

async fn sync_configure_local_inner(
    state: &State<'_, AppState>,
    path: &str,
    passphrase: &str,
) -> Result<()> {
    require_unlocked(state).await?;
    if path.trim().is_empty() {
        return Err(AppError::Validation("folder path required".into()));
    }
    if passphrase.len() < 8 {
        return Err(AppError::Validation(
            "sync passphrase must be at least 8 characters".into(),
        ));
    }

    // Normalise + pre-create the folder so we error out here (user fixable)
    // rather than from the background task on first write.
    let canonical = PathBuf::from(path);
    tokio::fs::create_dir_all(&canonical).await?;

    let blob_b64 = {
        let vs = state.vault.read().await;
        sync::encrypt_stored_blob(passphrase, &vs)?
    };

    db::settings::set(&state.db, KEY_KIND, "local").await?;
    db::settings::set(&state.db, KEY_LOCAL_PATH, canonical.to_string_lossy().as_ref()).await?;
    db::settings::set(&state.db, KEY_LOCAL_PASSPHRASE_BLOB, &blob_b64).await?;
    // Clear any stale success/error bookkeeping from a previous config.
    db::settings::set(&state.db, KEY_LAST_SUCCESS_AT, "").await?;
    db::settings::set(&state.db, KEY_LAST_ERROR, "").await?;

    state
        .sync
        .set_target(SyncTarget::LocalFolder {
            path: canonical,
            passphrase: passphrase.to_string(),
        })
        .await;

    // Fire an immediate backup so the folder isn't empty after save.
    state.sync.trigger();
    Ok(())
}

#[tauri::command]
pub async fn sync_disable(state: State<'_, AppState>) -> Result<()> {
    require_unlocked(&state).await?;
    db::settings::set(&state.db, KEY_KIND, "none").await?;
    // Clear local-folder + S3 fields. Secrets (blobs) are zeroed in
    // settings — the underlying vault isn't touched.
    db::settings::set(&state.db, KEY_LOCAL_PATH, "").await?;
    db::settings::set(&state.db, KEY_LOCAL_PASSPHRASE_BLOB, "").await?;
    db::settings::set(&state.db, KEY_S3_ENDPOINT, "").await?;
    db::settings::set(&state.db, KEY_S3_REGION, "").await?;
    db::settings::set(&state.db, KEY_S3_BUCKET, "").await?;
    db::settings::set(&state.db, KEY_S3_PREFIX, "").await?;
    db::settings::set(&state.db, KEY_S3_ACCESS_KEY_ID, "").await?;
    db::settings::set(&state.db, KEY_S3_SECRET_BLOB, "").await?;
    db::settings::set(&state.db, KEY_S3_PASSPHRASE_BLOB, "").await?;
    db::settings::set(&state.db, KEY_S3_LAST_ETAG, "").await?;
    state.sync.set_target(SyncTarget::None).await;
    Ok(())
}

#[derive(Debug, serde::Deserialize)]
pub struct S3ConfigInput {
    pub endpoint:          String,
    pub region:            String,
    pub bucket:            String,
    pub prefix:            String,
    pub access_key_id:     String,
    pub secret_access_key: String,
    pub passphrase:        String,
}

#[tauri::command]
pub async fn sync_configure_s3(
    state: State<'_, AppState>,
    cfg: S3ConfigInput,
) -> Result<()> {
    let mut cfg = cfg;
    let result = sync_configure_s3_inner(&state, &cfg).await;
    // Zero secrets in memory once stored (they're now encrypted in
    // app_settings). Shadowing `cfg` keeps scope tight.
    cfg.secret_access_key.zeroize();
    cfg.passphrase.zeroize();
    result
}

async fn sync_configure_s3_inner(
    state: &State<'_, AppState>,
    cfg: &S3ConfigInput,
) -> Result<()> {
    require_unlocked(state).await?;
    if cfg.endpoint.trim().is_empty() {
        return Err(AppError::Validation("endpoint required".into()));
    }
    if cfg.bucket.trim().is_empty() {
        return Err(AppError::Validation("bucket required".into()));
    }
    if cfg.access_key_id.trim().is_empty() {
        return Err(AppError::Validation("access_key_id required".into()));
    }
    if cfg.secret_access_key.is_empty() {
        return Err(AppError::Validation("secret_access_key required".into()));
    }
    if cfg.passphrase.len() < 8 {
        return Err(AppError::Validation(
            "sync passphrase must be at least 8 characters".into(),
        ));
    }

    // Smoke-test connectivity + permissions before saving so a typoed
    // secret doesn't silently configure a broken target. We HEAD the
    // object — 200 or 404 are both fine; 403/401 means bad creds.
    let driver = crate::sync::s3::S3Driver::new(crate::sync::s3::S3Config {
        endpoint: &cfg.endpoint,
        region:   &cfg.region,
        bucket:   &cfg.bucket,
        prefix:   &cfg.prefix,
        access_key_id:     &cfg.access_key_id,
        secret_access_key: &cfg.secret_access_key,
    })?;
    let _ = driver.head().await?;

    // Encrypt the two secret-grade fields under the vault key.
    let (secret_blob, passphrase_blob) = {
        let vs = state.vault.read().await;
        (
            sync::encrypt_stored_blob(&cfg.secret_access_key, &vs)?,
            sync::encrypt_stored_blob(&cfg.passphrase, &vs)?,
        )
    };

    db::settings::set(&state.db, KEY_KIND, "s3").await?;
    db::settings::set(&state.db, KEY_S3_ENDPOINT, cfg.endpoint.trim()).await?;
    db::settings::set(&state.db, KEY_S3_REGION, cfg.region.trim()).await?;
    db::settings::set(&state.db, KEY_S3_BUCKET, cfg.bucket.trim()).await?;
    db::settings::set(&state.db, KEY_S3_PREFIX, cfg.prefix.trim()).await?;
    db::settings::set(&state.db, KEY_S3_ACCESS_KEY_ID, cfg.access_key_id.trim()).await?;
    db::settings::set(&state.db, KEY_S3_SECRET_BLOB, &secret_blob).await?;
    db::settings::set(&state.db, KEY_S3_PASSPHRASE_BLOB, &passphrase_blob).await?;
    // Reset per-config bookkeeping on reconfigure.
    db::settings::set(&state.db, KEY_S3_LAST_ETAG, "").await?;
    db::settings::set(&state.db, KEY_LAST_SUCCESS_AT, "").await?;
    db::settings::set(&state.db, KEY_LAST_ERROR, "").await?;

    state
        .sync
        .set_target(SyncTarget::S3 {
            endpoint:          cfg.endpoint.trim().to_string(),
            region:            cfg.region.trim().to_string(),
            bucket:            cfg.bucket.trim().to_string(),
            prefix:            cfg.prefix.trim().to_string(),
            access_key_id:     cfg.access_key_id.trim().to_string(),
            secret_access_key: cfg.secret_access_key.clone(),
            passphrase:        cfg.passphrase.clone(),
        })
        .await;

    // Kick off an immediate first-push so the bucket isn't empty after save.
    state.sync.trigger();
    Ok(())
}

/// Download the remote object to a temp file and return its absolute
/// path. The frontend hands that path + the backup passphrase to the
/// existing RestoreDialog — same preview + selection flow as a manual
/// backup file.
#[tauri::command]
pub async fn sync_pull_to_temp(state: State<'_, AppState>) -> Result<String> {
    require_unlocked(&state).await?;
    let kind = state.sync.target_kind().await;
    if kind != "s3" {
        return Err(AppError::Validation(
            "pull is only meaningful with an S3 target configured".into(),
        ));
    }
    let target = state
        .sync
        .s3_target()
        .await
        .ok_or_else(|| AppError::Validation("S3 target not loaded".into()))?;
    let SyncTarget::S3 {
        endpoint, region, bucket, prefix, access_key_id, secret_access_key, ..
    } = target
    else {
        return Err(AppError::Validation("unexpected target kind".into()));
    };
    let driver = crate::sync::s3::S3Driver::new(crate::sync::s3::S3Config {
        endpoint: &endpoint, region: &region, bucket: &bucket, prefix: &prefix,
        access_key_id: &access_key_id, secret_access_key: &secret_access_key,
    })?;
    let (bytes, etag) = driver
        .get()
        .await?
        .ok_or_else(|| AppError::NotFound)?;

    let mut path = std::env::temp_dir();
    path.push(format!("ezterm-pull-{}.json", chrono::Utc::now().timestamp_millis()));
    tokio::fs::write(&path, &bytes).await?;
    // Record that we've now observed this ETag — subsequent pushes won't
    // fire the conflict check against it.
    db::settings::set(&state.db, KEY_S3_LAST_ETAG, &etag).await?;
    Ok(path.to_string_lossy().into_owned())
}

#[tauri::command]
pub async fn sync_push_now(state: State<'_, AppState>) -> Result<()> {
    require_unlocked(&state).await?;
    if state.sync.target_kind().await == "none" {
        return Err(AppError::Validation(
            "sync is not configured — enable a target first".into(),
        ));
    }
    state.sync.trigger();
    Ok(())
}
