use tauri::State;

use crate::db::settings;
use crate::error::Result;
use crate::state::AppState;

#[tauri::command]
pub async fn settings_get(state: State<'_, AppState>, key: String) -> Result<Option<String>> {
    settings::get(&state.db, &key).await
}

#[tauri::command]
pub async fn settings_set(state: State<'_, AppState>, key: String, value: String) -> Result<()> {
    settings::set(&state.db, &key, &value).await
}
