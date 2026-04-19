use tauri::State;

use crate::commands::require_unlocked;
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
    if input.name.len() > 128 {
        return Err(AppError::Validation("name too long".into()));
    }
    // RFC 1035: DNS names are capped at 253 octets. This also bounds IPv4/IPv6 literals.
    if input.host.len() > 253 {
        return Err(AppError::Validation("host too long".into()));
    }
    // POSIX/Linux useradd caps usernames at 32; we allow 64 to cover AD/UPN forms.
    if input.username.len() > 64 {
        return Err(AppError::Validation("username too long".into()));
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
    require_unlocked(&state).await?;
    sessions::list(&state.db).await
}

#[tauri::command]
pub async fn session_get(state: State<'_, AppState>, id: i64) -> Result<Session> {
    require_unlocked(&state).await?;
    sessions::get(&state.db, id).await
}

#[tauri::command]
pub async fn session_create(state: State<'_, AppState>, input: SessionInput) -> Result<Session> {
    require_unlocked(&state).await?;
    validate(&input)?;
    sessions::create(&state.db, &input).await
}

#[tauri::command]
pub async fn session_update(
    state: State<'_, AppState>,
    id: i64,
    input: SessionInput,
) -> Result<Session> {
    require_unlocked(&state).await?;
    validate(&input)?;
    sessions::update(&state.db, id, &input).await
}

#[tauri::command]
pub async fn session_delete(state: State<'_, AppState>, id: i64) -> Result<()> {
    require_unlocked(&state).await?;
    sessions::delete(&state.db, id).await
}

#[tauri::command]
pub async fn session_duplicate(state: State<'_, AppState>, id: i64) -> Result<Session> {
    require_unlocked(&state).await?;
    sessions::duplicate(&state.db, id).await
}
