use serde::Serialize;
use tauri::{AppHandle, State};

use crate::db::known_hosts::{self, KnownHost};
use crate::error::Result;
use crate::ssh::{self, ConnectRequest};
use crate::state::AppState;

#[derive(Serialize)]
pub struct ConnectResult {
    pub connection_id: u64,
    pub fingerprint_sha256: String,
}

#[tauri::command]
pub async fn ssh_connect(
    state: State<'_, AppState>,
    app: AppHandle,
    session_id: i64,
    cols: u16,
    rows: u16,
    trust_any: bool,
    disable_x11: Option<bool>,
) -> Result<ConnectResult> {
    super::require_unlocked(&state).await?;
    let out = ssh::connect(
        &state,
        app,
        ConnectRequest {
            session_id,
            cols,
            rows,
            trust_any,
            disable_x11: disable_x11.unwrap_or(false),
        },
    )
    .await?;
    Ok(ConnectResult {
        connection_id: out.connection_id,
        fingerprint_sha256: out.fingerprint_sha256,
    })
}

#[tauri::command]
pub async fn ssh_write(
    state: State<'_, AppState>,
    connection_id: u64,
    bytes: Vec<u8>,
) -> Result<()> {
    state.ssh.write(connection_id, bytes).await;
    Ok(())
}

#[tauri::command]
pub async fn ssh_resize(
    state: State<'_, AppState>,
    connection_id: u64,
    cols: u16,
    rows: u16,
) -> Result<()> {
    state.ssh.resize(connection_id, cols, rows).await;
    Ok(())
}

#[tauri::command]
pub async fn ssh_disconnect(state: State<'_, AppState>, connection_id: u64) -> Result<()> {
    // Route through `close_connection` so SFTP state is dropped alongside the
    // SSH session. Going through `state.ssh.close` directly would leak the
    // per-connection `SftpHandle` (audit I-1).
    state.close_connection(connection_id).await;
    Ok(())
}

#[tauri::command]
pub async fn known_host_list(state: State<'_, AppState>) -> Result<Vec<KnownHost>> {
    super::require_unlocked(&state).await?;
    known_hosts::list(&state.db).await
}

#[tauri::command]
pub async fn known_host_remove(
    state: State<'_, AppState>,
    host: String,
    port: i64,
) -> Result<()> {
    super::require_unlocked(&state).await?;
    known_hosts::remove(&state.db, &host, port).await
}
