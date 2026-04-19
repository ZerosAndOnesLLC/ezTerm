use tauri::State;

use crate::commands::require_unlocked;
use crate::db::settings;
use crate::error::Result;
use crate::state::AppState;

/// Settings keys that may be read without unlocking the vault.
///
/// The unlock screen needs the active theme before the user authenticates.
/// Every other settings key is gated behind `require_unlocked`.
const PUBLIC_SETTINGS_KEYS: &[&str] = &["theme"];

#[tauri::command]
pub async fn settings_get(state: State<'_, AppState>, key: String) -> Result<Option<String>> {
    if !PUBLIC_SETTINGS_KEYS.contains(&key.as_str()) {
        require_unlocked(&state).await?;
    }
    settings::get(&state.db, &key).await
}

#[tauri::command]
pub async fn settings_set(state: State<'_, AppState>, key: String, value: String) -> Result<()> {
    require_unlocked(&state).await?;
    settings::set(&state.db, &key, &value).await
}
