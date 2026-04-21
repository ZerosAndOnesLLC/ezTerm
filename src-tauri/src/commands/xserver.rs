use tauri::State;

use crate::commands::require_unlocked;
use crate::error::Result;
use crate::state::AppState;
use crate::xserver::XServerStatus;

#[tauri::command]
pub async fn xserver_status(state: State<'_, AppState>) -> Result<XServerStatus> {
    require_unlocked(&state).await?;
    Ok(state.xserver.status().await)
}
