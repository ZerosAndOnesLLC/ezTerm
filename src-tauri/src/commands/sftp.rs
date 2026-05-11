use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};

use serde::{Deserialize, Serialize};
use tauri::State;

use crate::error::{AppError, Result};
use crate::sftp::SftpHandle;
use crate::state::AppState;

/// Monotonic id for transfers. The frontend correlates progress events to a
/// ticket by subscribing to `sftp:transfer:{id}`.
static TRANSFER_ID: AtomicU64 = AtomicU64::new(0);

fn next_transfer_id() -> u64 {
    TRANSFER_ID.fetch_add(1, Ordering::Relaxed) + 1
}

/// Handle returned to the frontend so it can subscribe to progress before
/// the transfer task has started emitting.
#[derive(Serialize)]
pub struct TransferTicket {
    pub transfer_id: u64,
}

/// One entry returned by `sftp_list`. Mirrors the fields the UI needs to
/// render a directory row: name + full path for navigation, type flags,
/// size, mtime (unix seconds), and the POSIX mode bits.
#[derive(Debug, Serialize, Deserialize)]
pub struct SftpEntry {
    pub name: String,
    pub full_path: String,
    pub is_dir: bool,
    pub is_symlink: bool,
    pub size: u64,
    pub mtime_unix: i64,
    pub mode: u32,
}

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

    // Open a second session channel on the same SSH handle, then request
    // the `sftp` subsystem. `channel_open_session` takes `&self` so the
    // shared Arc<Handle> needs no further synchronisation.
    let channel = conn.ssh_handle
        .channel_open_session()
        .await
        .map_err(|e| AppError::Ssh(e.to_string()))?;
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

/// Fetch a directory listing. The returned entries are sorted directories-first,
/// name-ascending, with `.` and `..` filtered out (russh-sftp's `ReadDir` iterator
/// already drops those).
#[tauri::command]
pub async fn sftp_list(
    state: State<'_, AppState>,
    connection_id: u64,
    path: String,
) -> Result<Vec<SftpEntry>> {
    super::require_unlocked(&state).await?;
    let path = crate::sftp::normalise_remote_path(&path)?;
    let handle = sftp_handle(&state, connection_id).await?;

    let mut out = handle
        .with_session(
            async move |s: &mut russh_sftp::client::SftpSession| -> Result<Vec<SftpEntry>> {
                let dir = s
                    .read_dir(&path)
                    .await
                    .map_err(|e| AppError::Sftp(e.to_string()))?;
                let mut acc: Vec<SftpEntry> = Vec::new();
                for entry in dir {
                    let name = entry.file_name();
                    let attrs = entry.metadata();
                    let full = if path.ends_with('/') {
                        format!("{path}{name}")
                    } else {
                        format!("{path}/{name}")
                    };
                    acc.push(SftpEntry {
                        name,
                        full_path: full,
                        is_dir: attrs.is_dir(),
                        is_symlink: attrs.is_symlink(),
                        size: attrs.size.unwrap_or(0),
                        mtime_unix: attrs.mtime.map(|m| m as i64).unwrap_or(0),
                        mode: attrs.permissions.unwrap_or(0),
                    });
                }
                Ok(acc)
            },
        )
        .await?;

    out.sort_by(|a, b| b.is_dir.cmp(&a.is_dir).then_with(|| a.name.cmp(&b.name)));
    Ok(out)
}

#[tauri::command]
pub async fn sftp_mkdir(
    state: State<'_, AppState>,
    connection_id: u64,
    path: String,
) -> Result<()> {
    super::require_unlocked(&state).await?;
    let path = crate::sftp::normalise_remote_path(&path)?;
    let handle = sftp_handle(&state, connection_id).await?;
    handle
        .with_session(async move |s: &mut russh_sftp::client::SftpSession| -> Result<()> {
            s.create_dir(&path)
                .await
                .map_err(|e| AppError::Sftp(e.to_string()))
        })
        .await
}

#[tauri::command]
pub async fn sftp_rmdir(
    state: State<'_, AppState>,
    connection_id: u64,
    path: String,
) -> Result<()> {
    super::require_unlocked(&state).await?;
    let path = crate::sftp::normalise_remote_path(&path)?;
    let handle = sftp_handle(&state, connection_id).await?;
    handle
        .with_session(async move |s: &mut russh_sftp::client::SftpSession| -> Result<()> {
            s.remove_dir(&path)
                .await
                .map_err(|e| AppError::Sftp(e.to_string()))
        })
        .await
}

#[tauri::command]
pub async fn sftp_remove(
    state: State<'_, AppState>,
    connection_id: u64,
    path: String,
) -> Result<()> {
    super::require_unlocked(&state).await?;
    let path = crate::sftp::normalise_remote_path(&path)?;
    let handle = sftp_handle(&state, connection_id).await?;
    handle
        .with_session(async move |s: &mut russh_sftp::client::SftpSession| -> Result<()> {
            s.remove_file(&path)
                .await
                .map_err(|e| AppError::Sftp(e.to_string()))
        })
        .await
}

#[tauri::command]
pub async fn sftp_rename(
    state: State<'_, AppState>,
    connection_id: u64,
    from: String,
    to: String,
) -> Result<()> {
    super::require_unlocked(&state).await?;
    let from = crate::sftp::normalise_remote_path(&from)?;
    let to = crate::sftp::normalise_remote_path(&to)?;
    let handle = sftp_handle(&state, connection_id).await?;
    handle
        .with_session(async move |s: &mut russh_sftp::client::SftpSession| -> Result<()> {
            s.rename(&from, &to)
                .await
                .map_err(|e| AppError::Sftp(e.to_string()))
        })
        .await
}

#[tauri::command]
pub async fn sftp_chmod(
    state: State<'_, AppState>,
    connection_id: u64,
    path: String,
    mode: u32,
) -> Result<()> {
    super::require_unlocked(&state).await?;
    let path = crate::sftp::normalise_remote_path(&path)?;
    let handle = sftp_handle(&state, connection_id).await?;
    handle
        .with_session(async move |s: &mut russh_sftp::client::SftpSession| -> Result<()> {
            // Only the permission bits are mutated — leave size/uid/gid/atime/mtime
            // untouched on the server.
            let mut attrs = russh_sftp::protocol::FileAttributes::empty();
            attrs.permissions = Some(mode);
            s.set_metadata(&path, attrs)
                .await
                .map_err(|e| AppError::Sftp(e.to_string()))
        })
        .await
}

#[tauri::command]
pub async fn sftp_realpath(
    state: State<'_, AppState>,
    connection_id: u64,
    path: String,
) -> Result<String> {
    super::require_unlocked(&state).await?;
    let path = crate::sftp::normalise_remote_path(&path)?;
    let handle = sftp_handle(&state, connection_id).await?;
    handle
        .with_session(
            async move |s: &mut russh_sftp::client::SftpSession| -> Result<String> {
                s.canonicalize(&path)
                    .await
                    .map_err(|e| AppError::Sftp(e.to_string()))
            },
        )
        .await
}

async fn sftp_handle(
    state: &State<'_, AppState>,
    connection_id: u64,
) -> Result<std::sync::Arc<SftpHandle>> {
    state
        .sftp
        .get(connection_id)
        .await
        .ok_or(AppError::NotFound)
}

/// Start a streaming upload. Returns a ticket immediately; progress flows
/// through `sftp:transfer:{transfer_id}` events. The final event has
/// `done = true` (success) or populates `error` (failure).
#[tauri::command]
pub async fn sftp_upload(
    state: State<'_, AppState>,
    app: tauri::AppHandle,
    connection_id: u64,
    local_path: String,
    remote_path: String,
) -> Result<TransferTicket> {
    super::require_unlocked(&state).await?;
    let remote_path = crate::sftp::normalise_remote_path(&remote_path)?;
    let handle = sftp_handle(&state, connection_id).await?;
    let transfer_id = next_transfer_id();

    tokio::spawn(async move {
        let _ = crate::sftp::transfer::upload(
            &app,
            &handle,
            transfer_id,
            &PathBuf::from(&local_path),
            &remote_path,
        )
        .await;
    });
    Ok(TransferTicket { transfer_id })
}

/// Hard cap on drag-drop upload size. The Chromium webview holds the whole
/// file in memory before shipping it to Rust, and ballooning past a few
/// hundred MB OOM-risks the webview. Users with larger uploads should hit
/// the Upload button (native file dialog → path-based streaming).
const MAX_DRAG_DROP_BYTES: usize = 256 * 1024 * 1024;

/// Drag-drop upload variant: file contents are passed inline (the webview
/// can't expose a local path on Chromium for security reasons, so the
/// frontend reads the File via FileReader and sends bytes here).
#[tauri::command]
pub async fn sftp_upload_bytes(
    state: State<'_, AppState>,
    app: tauri::AppHandle,
    connection_id: u64,
    remote_path: String,
    bytes: Vec<u8>,
) -> Result<TransferTicket> {
    super::require_unlocked(&state).await?;
    if bytes.len() > MAX_DRAG_DROP_BYTES {
        return Err(AppError::Validation(format!(
            "drag-drop upload capped at {} MB; use the Upload button for larger files",
            MAX_DRAG_DROP_BYTES / (1024 * 1024)
        )));
    }
    let remote_path = crate::sftp::normalise_remote_path(&remote_path)?;
    let handle = sftp_handle(&state, connection_id).await?;
    let transfer_id = next_transfer_id();

    tokio::spawn(async move {
        let _ = crate::sftp::transfer::upload_bytes(
            &app,
            &handle,
            transfer_id,
            &bytes,
            &remote_path,
        )
        .await;
    });
    Ok(TransferTicket { transfer_id })
}

/// Start a streaming download. See `sftp_upload` for the progress-event model.
#[tauri::command]
pub async fn sftp_download(
    state: State<'_, AppState>,
    app: tauri::AppHandle,
    connection_id: u64,
    remote_path: String,
    local_path: String,
) -> Result<TransferTicket> {
    super::require_unlocked(&state).await?;
    let remote_path = crate::sftp::normalise_remote_path(&remote_path)?;
    let handle = sftp_handle(&state, connection_id).await?;
    let transfer_id = next_transfer_id();

    tokio::spawn(async move {
        let _ = crate::sftp::transfer::download(
            &app,
            &handle,
            transfer_id,
            &remote_path,
            &PathBuf::from(&local_path),
        )
        .await;
    });
    Ok(TransferTicket { transfer_id })
}
