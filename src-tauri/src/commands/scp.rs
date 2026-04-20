use tauri::{AppHandle, State};

use crate::error::{AppError, Result};
use crate::state::AppState;

/// One-shot SCP upload. Currently a v0.3 stub — returns a clear message
/// pointing the caller at the SFTP pane. The surface is present so the
/// frontend can stabilise against the real implementation in a later release.
#[tauri::command]
pub async fn scp_upload(
    state: State<'_, AppState>,
    app: AppHandle,
    session_id: i64,
    local_path: String,
    remote_path: String,
) -> Result<u64> {
    super::require_unlocked(&state).await?;
    let _ = (state, app, session_id, local_path, remote_path);
    Err(AppError::Scp(
        "scp_upload is currently only available after opening a session tab; use the SFTP pane"
            .into(),
    ))
}

/// One-shot SCP download. See `scp_upload`.
#[tauri::command]
pub async fn scp_download(
    state: State<'_, AppState>,
    app: AppHandle,
    session_id: i64,
    remote_path: String,
    local_path: String,
) -> Result<u64> {
    super::require_unlocked(&state).await?;
    let _ = (state, app, session_id, remote_path, local_path);
    Err(AppError::Scp(
        "scp_download is currently only available after opening a session tab; use the SFTP pane"
            .into(),
    ))
}
