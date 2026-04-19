use tauri::State;

use crate::error::{AppError, Result};
use crate::sftp::SftpHandle;
use crate::state::AppState;

/// Open an SFTP subsystem channel on the existing SSH session identified by
/// `connection_id`. Stores the resulting `SftpSession` in the `SftpRegistry`
/// so later `sftp_*` commands can reuse it. Idempotent only in the sense that
/// the last insert wins — callers should invoke this once per connection.
#[tauri::command]
pub async fn sftp_open(state: State<'_, AppState>, connection_id: u64) -> Result<()> {
    super::require_unlocked(&state).await?;

    let conn = state
        .ssh
        .get(connection_id)
        .await
        .ok_or(AppError::NotFound)?;

    // Open a second session channel on the same SSH handle, then request the
    // `sftp` subsystem. We scope the lock on the russh handle so it's released
    // before the (blocking-ish) SftpSession handshake runs.
    let channel = {
        let h = conn.ssh_handle.lock().await;
        h.channel_open_session()
            .await
            .map_err(|e| AppError::Ssh(e.to_string()))?
    };
    channel
        .request_subsystem(true, "sftp")
        .await
        .map_err(|e| AppError::Ssh(e.to_string()))?;

    let sftp = russh_sftp::client::SftpSession::new(channel.into_stream())
        .await
        .map_err(|e| AppError::Sftp(format!("init: {e}")))?;

    state
        .sftp
        .insert(connection_id, SftpHandle::new(sftp))
        .await;
    Ok(())
}
