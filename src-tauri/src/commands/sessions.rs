use tauri::State;

use crate::commands::require_unlocked;
use crate::db::sessions::{self, EnvPair, Session, SessionInput};
use crate::error::{AppError, Result};
use crate::state::AppState;

// Range limits for advanced session settings. These bound UI inputs and
// reject garbage from crafted IPC calls; the DB has no matching CHECK
// constraints (see migration comment).
const SCROLLBACK_MIN: i64 = 0;
const SCROLLBACK_MAX: i64 = 100_000;
const FONT_SIZE_MIN: i64 = 8;
const FONT_SIZE_MAX: i64 = 48;
const KEEPALIVE_MIN: i64 = 0; // 0 = disabled
const KEEPALIVE_MAX: i64 = 7_200; // 2h ceiling
const CONNECT_TIMEOUT_MIN: i64 = 1;
const CONNECT_TIMEOUT_MAX: i64 = 600; // 10m ceiling
// POSIX env name rule: [A-Z_][A-Z0-9_]* is the portable set, but OpenSSH
// accepts anything non-empty without '=' or NUL. We take the permissive
// stance and only forbid the characters that would break the SSH wire
// format or our own parsing.
const ENV_KEY_MAX: usize = 256;
const ENV_VALUE_MAX: usize = 4_096;
// Guard against accidental N² sends on connect — 64 vars is more than any
// reasonable use case and keeps the per-connect handshake bounded.
const ENV_MAX_COUNT: usize = 64;
const INITIAL_COMMAND_MAX: usize = 4_096;

fn validate(input: &SessionInput) -> Result<()> {
    if input.name.trim().is_empty() {
        return Err(AppError::Validation("name required".into()));
    }
    if input.name.len() > 128 {
        return Err(AppError::Validation("name too long".into()));
    }
    if !matches!(input.session_kind.as_str(), "ssh" | "wsl" | "local") {
        return Err(AppError::Validation("invalid session_kind".into()));
    }
    // Per-kind input rules. SSH retains the original tight checks; wsl and
    // local relax port/auth since host/username are repurposed to distro/
    // shell-program and wsl-user/cwd respectively.
    if input.session_kind == "ssh" {
        if input.host.trim().is_empty() {
            return Err(AppError::Validation("host required".into()));
        }
        if input.username.trim().is_empty() {
            return Err(AppError::Validation("username required".into()));
        }
        // RFC 1035: DNS names are capped at 253 octets. This also bounds IPv4/IPv6 literals.
        if input.host.len() > 253 {
            return Err(AppError::Validation("host too long".into()));
        }
        if input.username.len() > 64 {
            return Err(AppError::Validation("username too long".into()));
        }
        if input.port <= 0 || input.port > 65535 {
            return Err(AppError::Validation("port out of range".into()));
        }
        if !matches!(input.auth_type.as_str(), "password" | "key" | "agent") {
            return Err(AppError::Validation("invalid auth_type".into()));
        }
    } else {
        // wsl / local rows.
        //
        // host = distro name (wsl, empty ok for default distro) or shell
        //        short-name / absolute path (local, empty ok = cmd).
        // username = wsl user (wsl) or starting directory (local). Both
        //            optional.
        if input.host.len() > 512 {
            return Err(AppError::Validation("host too long".into()));
        }
        if input.username.len() > 512 {
            return Err(AppError::Validation("username too long".into()));
        }
        if input.auth_type != "agent" {
            return Err(AppError::Validation(
                "non-ssh sessions must use auth_type='agent'".into(),
            ));
        }
        if input.credential_id.is_some() || input.key_passphrase_credential_id.is_some() {
            return Err(AppError::Validation(
                "non-ssh sessions cannot attach a credential".into(),
            ));
        }
    }
    if !matches!(input.cursor_style.as_str(), "block" | "bar" | "underline") {
        return Err(AppError::Validation("invalid cursor_style".into()));
    }
    if input.compression != 0 && input.compression != 1 {
        return Err(AppError::Validation("compression must be 0 or 1".into()));
    }
    if input.scrollback_lines < SCROLLBACK_MIN || input.scrollback_lines > SCROLLBACK_MAX {
        return Err(AppError::Validation("scrollback_lines out of range".into()));
    }
    if input.font_size < FONT_SIZE_MIN || input.font_size > FONT_SIZE_MAX {
        return Err(AppError::Validation("font_size out of range".into()));
    }
    if input.keepalive_secs < KEEPALIVE_MIN || input.keepalive_secs > KEEPALIVE_MAX {
        return Err(AppError::Validation("keepalive_secs out of range".into()));
    }
    if input.connect_timeout_secs < CONNECT_TIMEOUT_MIN
        || input.connect_timeout_secs > CONNECT_TIMEOUT_MAX
    {
        return Err(AppError::Validation("connect_timeout_secs out of range".into()));
    }
    if let Some(cmd) = &input.initial_command {
        if cmd.len() > INITIAL_COMMAND_MAX {
            return Err(AppError::Validation("initial_command too long".into()));
        }
    }
    if input.env.len() > ENV_MAX_COUNT {
        return Err(AppError::Validation("too many env vars".into()));
    }
    for pair in &input.env {
        if pair.key.is_empty() {
            return Err(AppError::Validation("env key empty".into()));
        }
        if pair.key.len() > ENV_KEY_MAX {
            return Err(AppError::Validation("env key too long".into()));
        }
        if pair.value.len() > ENV_VALUE_MAX {
            return Err(AppError::Validation("env value too long".into()));
        }
        if pair.key.contains('=') || pair.key.contains('\0') {
            return Err(AppError::Validation("env key contains '=' or NUL".into()));
        }
        if pair.value.contains('\0') {
            return Err(AppError::Validation("env value contains NUL".into()));
        }
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
pub async fn session_env_get(state: State<'_, AppState>, id: i64) -> Result<Vec<EnvPair>> {
    require_unlocked(&state).await?;
    sessions::env_get(&state.db, id).await
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

#[tauri::command]
pub async fn session_move(
    state: State<'_, AppState>,
    id: i64,
    folder_id: Option<i64>,
    sort: i64,
) -> Result<()> {
    require_unlocked(&state).await?;
    sessions::mv(&state.db, id, folder_id, sort).await
}
