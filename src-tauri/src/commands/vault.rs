use std::sync::atomic::Ordering;

use chrono::Utc;
use tauri::State;
use zeroize::Zeroize;

use crate::error::{AppError, Result};
use crate::state::AppState;
use crate::vault;

/// Hard upper bound on master password byte length. Argon2 can hash arbitrary
/// inputs, but accepting unbounded strings invites resource-exhaustion abuse.
const MAX_PASSWORD_LEN: usize = 1024;
/// Number of consecutive unlock failures before we start cooling down.
const UNLOCK_FAILURE_THRESHOLD: u32 = 5;
/// Base cooldown (seconds) applied when we cross the threshold.
const UNLOCK_BASE_COOLDOWN_SECS: i64 = 30;
/// Hard cap on cooldown (seconds) regardless of failure count.
const UNLOCK_MAX_COOLDOWN_SECS: i64 = 300;

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
    let mut password = password;
    let result = vault_init_inner(&state, &password).await;
    password.zeroize();
    result
}

async fn vault_init_inner(state: &State<'_, AppState>, password: &str) -> Result<()> {
    if password.len() < 8 {
        return Err(AppError::Validation(
            "master password must be at least 8 chars".into(),
        ));
    }
    if password.len() > MAX_PASSWORD_LEN {
        return Err(AppError::Validation("password too long".into()));
    }
    let new_state = vault::init(&state.db, password).await?;
    *state.vault.write().await = new_state;
    Ok(())
}

#[tauri::command]
pub async fn vault_unlock(state: State<'_, AppState>, password: String) -> Result<()> {
    let mut password = password;
    let result = vault_unlock_inner(&state, &password).await;
    password.zeroize();
    result
}

async fn vault_unlock_inner(state: &State<'_, AppState>, password: &str) -> Result<()> {
    // Deliberately do not enforce a minimum length here: a user who set their
    // password before the 8-char floor was introduced must still be able to
    // unlock their vault.
    if password.len() > MAX_PASSWORD_LEN {
        return Err(AppError::Validation("password too long".into()));
    }

    let now = Utc::now().timestamp();
    let locked_until = state.unlock_locked_until_unix.load(Ordering::Acquire);
    if locked_until > now {
        let remaining = locked_until - now;
        return Err(AppError::Validation(format!(
            "too many attempts; try again in {remaining}s"
        )));
    }

    match vault::unlock(&state.db, password).await {
        Ok(new_state) => {
            *state.vault.write().await = new_state;
            state.unlock_failures.store(0, Ordering::Release);
            state.unlock_locked_until_unix.store(0, Ordering::Release);
            // Hydrate sync config from settings now that we have the
            // vault key to decrypt the stored passphrase blob. Failures
            // are logged but don't block unlock — bad sync config
            // shouldn't lock the user out.
            let vs = state.vault.read().await;
            if let Err(e) = state.sync.reload_from_db(&state.db, &vs).await {
                tracing::warn!("sync reload_from_db failed: {e}");
            }
            Ok(())
        }
        Err(AppError::BadPassword) => {
            let failures = state.unlock_failures.fetch_add(1, Ordering::AcqRel) + 1;
            if failures >= UNLOCK_FAILURE_THRESHOLD {
                // 30s * 2^(failures-5), capped: after N failures past the
                // threshold we wait 30, 60, 120, 240, then clamp at 300.
                let exp = failures - UNLOCK_FAILURE_THRESHOLD;
                // Guard against shift overflow; 2^24 already far exceeds the cap.
                let shift = exp.min(24);
                let cooldown = UNLOCK_BASE_COOLDOWN_SECS
                    .saturating_mul(1_i64 << shift)
                    .min(UNLOCK_MAX_COOLDOWN_SECS);
                state
                    .unlock_locked_until_unix
                    .store(now + cooldown, Ordering::Release);
            }
            Err(AppError::BadPassword)
        }
        Err(e) => Err(e),
    }
}

#[tauri::command]
pub async fn vault_lock(state: State<'_, AppState>) -> Result<()> {
    *state.vault.write().await = vault::VaultState::Locked;
    Ok(())
}

/// Verify a master password without changing vault state. Used for
/// re-authentication gates (e.g. "enter master password to export
/// credentials") so that someone who walks up to an unlocked laptop
/// can't exfiltrate vault contents without the password. Runs the same
/// Argon2id derivation as `vault_unlock` so timing is consistent.
#[tauri::command]
pub async fn vault_verify_password(state: State<'_, AppState>, password: String) -> Result<bool> {
    let mut password = password;
    if password.len() > MAX_PASSWORD_LEN {
        password.zeroize();
        return Err(AppError::Validation("password too long".into()));
    }
    let result = vault::verify_password(&state.db, &password).await;
    password.zeroize();
    match result {
        Ok(ok) => Ok(ok),
        Err(e) => Err(e),
    }
}
