use tauri::State;

use crate::error::{AppError, Result};
use crate::state::AppState;
use crate::vault;

#[tauri::command]
pub async fn vault_status(state: State<'_, AppState>) -> Result<&'static str> {
    let initialized = vault::is_initialized(&state.db).await?;
    let unlocked = state.vault.read().await.is_unlocked();
    Ok(match (initialized, unlocked) {
        (false, _) => "uninitialized",
        (true, false) => "locked",
        (true, true) => "unlocked",
    })
}

#[tauri::command]
pub async fn vault_init(state: State<'_, AppState>, password: String) -> Result<()> {
    if password.len() < 8 {
        return Err(AppError::Validation(
            "master password must be at least 8 chars".into(),
        ));
    }
    let new_state = vault::init(&state.db, &password).await?;
    *state.vault.write().await = new_state;
    Ok(())
}

#[tauri::command]
pub async fn vault_unlock(state: State<'_, AppState>, password: String) -> Result<()> {
    let new_state = vault::unlock(&state.db, &password).await?;
    *state.vault.write().await = new_state;
    Ok(())
}

#[tauri::command]
pub async fn vault_lock(state: State<'_, AppState>) -> Result<()> {
    *state.vault.write().await = vault::VaultState::Locked;
    Ok(())
}
