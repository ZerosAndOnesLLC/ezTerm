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

    Ok(SyncStatus {
        kind,
        local_path,
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
    db::settings::set(&state.db, KEY_LOCAL_PATH, "").await?;
    db::settings::set(&state.db, KEY_LOCAL_PASSPHRASE_BLOB, "").await?;
    state.sync.set_target(SyncTarget::None).await;
    Ok(())
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
