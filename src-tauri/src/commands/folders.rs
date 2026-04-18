use tauri::State;

use crate::db::folders::{self, Folder};
use crate::error::Result;
use crate::state::AppState;

#[tauri::command]
pub async fn folder_list(state: State<'_, AppState>) -> Result<Vec<Folder>> {
    folders::list(&state.db).await
}

#[tauri::command]
pub async fn folder_create(
    state: State<'_, AppState>,
    parent_id: Option<i64>,
    name: String,
) -> Result<Folder> {
    if name.trim().is_empty() {
        return Err(crate::error::AppError::Validation("name required".into()));
    }
    folders::create(&state.db, parent_id, name.trim()).await
}

#[tauri::command]
pub async fn folder_rename(state: State<'_, AppState>, id: i64, name: String) -> Result<()> {
    if name.trim().is_empty() {
        return Err(crate::error::AppError::Validation("name required".into()));
    }
    folders::rename(&state.db, id, name.trim()).await
}

#[tauri::command]
pub async fn folder_delete(state: State<'_, AppState>, id: i64) -> Result<()> {
    folders::delete(&state.db, id).await
}

#[tauri::command]
pub async fn folder_move(
    state: State<'_, AppState>,
    id: i64,
    parent_id: Option<i64>,
    sort: i64,
) -> Result<()> {
    folders::mv(&state.db, id, parent_id, sort).await
}
