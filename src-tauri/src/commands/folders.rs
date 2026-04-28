use tauri::State;

use crate::commands::require_unlocked;
use crate::db::folders::{self, Folder};
use crate::error::Result;
use crate::state::AppState;

#[tauri::command]
pub async fn folder_list(state: State<'_, AppState>) -> Result<Vec<Folder>> {
    require_unlocked(&state).await?;
    folders::list(&state.db).await
}

#[tauri::command]
pub async fn folder_create(
    state: State<'_, AppState>,
    parent_id: Option<i64>,
    name: String,
) -> Result<Folder> {
    require_unlocked(&state).await?;
    if name.trim().is_empty() {
        return Err(crate::error::AppError::Validation("name required".into()));
    }
    let out = folders::create(&state.db, parent_id, name.trim()).await?;
    state.sync.trigger();
    Ok(out)
}

#[tauri::command]
pub async fn folder_rename(state: State<'_, AppState>, id: i64, name: String) -> Result<()> {
    require_unlocked(&state).await?;
    if name.trim().is_empty() {
        return Err(crate::error::AppError::Validation("name required".into()));
    }
    folders::rename(&state.db, id, name.trim()).await?;
    state.sync.trigger();
    Ok(())
}

#[tauri::command]
pub async fn folder_delete(state: State<'_, AppState>, id: i64) -> Result<()> {
    require_unlocked(&state).await?;
    folders::delete(&state.db, id).await?;
    state.sync.trigger();
    Ok(())
}

#[tauri::command]
pub async fn folder_move(
    state: State<'_, AppState>,
    id: i64,
    parent_id: Option<i64>,
    sort: i64,
) -> Result<()> {
    require_unlocked(&state).await?;
    folders::mv(&state.db, id, parent_id, sort).await?;
    state.sync.trigger();
    Ok(())
}

/// Renumber sibling folders under `parent_id` in the supplied order.
/// Used by the intra-folder DnD reorder path when the dragged row is a
/// folder landing among its siblings.
#[tauri::command]
pub async fn folder_reorder(
    state: State<'_, AppState>,
    parent_id: Option<i64>,
    ids: Vec<i64>,
) -> Result<()> {
    require_unlocked(&state).await?;
    folders::reorder(&state.db, parent_id, &ids).await?;
    state.sync.trigger();
    Ok(())
}
