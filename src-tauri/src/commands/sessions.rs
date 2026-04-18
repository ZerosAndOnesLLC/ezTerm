use tauri::State;

use crate::db::sessions::{self, Session, SessionInput};
use crate::error::{AppError, Result};
use crate::state::AppState;

fn validate(input: &SessionInput) -> Result<()> {
    if input.name.trim().is_empty() {
        return Err(AppError::Validation("name required".into()));
    }
    if input.host.trim().is_empty() {
        return Err(AppError::Validation("host required".into()));
    }
    if input.username.trim().is_empty() {
        return Err(AppError::Validation("username required".into()));
    }
    if input.port <= 0 || input.port > 65535 {
        return Err(AppError::Validation("port out of range".into()));
    }
    if !matches!(input.auth_type.as_str(), "password" | "key" | "agent") {
        return Err(AppError::Validation("invalid auth_type".into()));
    }
    Ok(())
}

#[tauri::command]
pub async fn session_list(state: State<'_, AppState>) -> Result<Vec<Session>> {
    sessions::list(&state.db).await
}

#[tauri::command]
pub async fn session_get(state: State<'_, AppState>, id: i64) -> Result<Session> {
    sessions::get(&state.db, id).await
}

#[tauri::command]
pub async fn session_create(state: State<'_, AppState>, input: SessionInput) -> Result<Session> {
    validate(&input)?;
    sessions::create(&state.db, &input).await
}

#[tauri::command]
pub async fn session_update(
    state: State<'_, AppState>,
    id: i64,
    input: SessionInput,
) -> Result<Session> {
    validate(&input)?;
    sessions::update(&state.db, id, &input).await
}

#[tauri::command]
pub async fn session_delete(state: State<'_, AppState>, id: i64) -> Result<()> {
    sessions::delete(&state.db, id).await
}

#[tauri::command]
pub async fn session_duplicate(state: State<'_, AppState>, id: i64) -> Result<Session> {
    sessions::duplicate(&state.db, id).await
}
