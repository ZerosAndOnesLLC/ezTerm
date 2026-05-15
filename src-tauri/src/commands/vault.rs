use std::sync::atomic::Ordering;

use chrono::Utc;
use serde::Serialize;
use tauri::State;
use zeroize::{Zeroize, Zeroizing};

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

#[derive(Serialize)]
pub struct ChangePasswordResult {
    /// Where the pre-change snapshot was written.
    pub snapshot_path: String,
}

/// Change the master password. Requires the vault to be unlocked AND
/// the old password to verify — being unlocked alone isn't enough,
/// otherwise anyone with access to a momentarily unattended laptop
/// could rotate the password and lock the real user out.
///
/// Re-encrypts every credential row and every sync passphrase blob
/// under the new key in a single transaction. Takes a snapshot of the
/// SQLite file first so the user can recover if something goes wrong.
/// On success the vault is locked — the caller must re-enter the new
/// password to continue.
#[tauri::command]
pub async fn vault_change_password(
    state: State<'_, AppState>,
    old_password: String,
    new_password: String,
) -> Result<ChangePasswordResult> {
    let mut old_password = old_password;
    let mut new_password = new_password;
    let result = vault_change_password_inner(&state, &old_password, &new_password).await;
    old_password.zeroize();
    new_password.zeroize();
    result
}

async fn vault_change_password_inner(
    state: &State<'_, AppState>,
    old_password: &str,
    new_password: &str,
) -> Result<ChangePasswordResult> {
    super::require_unlocked(state).await?;
    if old_password.len() > MAX_PASSWORD_LEN {
        return Err(AppError::Validation("old password too long".into()));
    }
    if new_password.len() < 8 {
        return Err(AppError::Validation(
            "new master password must be at least 8 chars".into(),
        ));
    }
    if new_password.len() > MAX_PASSWORD_LEN {
        return Err(AppError::Validation("new password too long".into()));
    }
    if old_password == new_password {
        return Err(AppError::Validation(
            "new password must differ from old password".into(),
        ));
    }

    // Snapshot the DB before we mutate anything. If this fails we don't
    // proceed — the snapshot is the user's escape hatch.
    let snapshot = vault::snapshot::take(&state.db, "change-password").await?;

    // change_password verifies the old password internally (BadPassword
    // surfaces here if it's wrong) and re-encrypts everything under the
    // new key in one transaction.
    let new_key: Zeroizing<[u8; 32]> =
        vault::change_password(&state.db, old_password, new_password).await?;

    // Drop the new key — we lock the vault and require re-unlock to
    // confirm the user can type the password they just set.
    drop(new_key);
    *state.vault.write().await = vault::VaultState::Locked;
    state.unlock_failures.store(0, Ordering::Release);
    state.unlock_locked_until_unix.store(0, Ordering::Release);

    Ok(ChangePasswordResult {
        snapshot_path: snapshot.to_string_lossy().into_owned(),
    })
}

#[derive(Serialize)]
pub struct RecoveryStatus {
    pub provisioned: bool,
}

#[tauri::command]
pub async fn vault_recovery_status(state: State<'_, AppState>) -> Result<RecoveryStatus> {
    let provisioned = vault::recovery::is_provisioned(&state.db).await?;
    Ok(RecoveryStatus { provisioned })
}

/// Generate (or regenerate) a one-time recovery code. Requires the
/// vault to be unlocked; the code wraps the in-memory vault key so we
/// must have one. Caller MUST display the returned code to the user
/// exactly once — it is never persisted in plaintext anywhere.
#[tauri::command]
pub async fn vault_generate_recovery_code(state: State<'_, AppState>) -> Result<String> {
    super::require_unlocked(&state).await?;
    let vs = state.vault.read().await;
    vault::recovery::generate(&state.db, &vs).await
}

#[tauri::command]
pub async fn vault_unlock_with_recovery(
    state: State<'_, AppState>,
    code: String,
) -> Result<()> {
    let mut code = code;
    let result = vault_unlock_with_recovery_inner(&state, &code).await;
    code.zeroize();
    result
}

async fn vault_unlock_with_recovery_inner(
    state: &State<'_, AppState>,
    code: &str,
) -> Result<()> {
    // Apply the same lockout/cooldown the password path uses. Recovery
    // codes have 120 bits of entropy, but cooldown still costs nothing
    // legitimate users will hit and slows offline-key spray attacks if
    // an attacker somehow got the DB and is racing against a network
    // interactive guess.
    let now = Utc::now().timestamp();
    let locked_until = state.unlock_locked_until_unix.load(Ordering::Acquire);
    if locked_until > now {
        let remaining = locked_until - now;
        return Err(AppError::Validation(format!(
            "too many attempts; try again in {remaining}s"
        )));
    }
    match vault::recovery::unlock_with_code(&state.db, code).await {
        Ok(key) => {
            *state.vault.write().await = vault::VaultState::Unlocked { key };
            state.unlock_failures.store(0, Ordering::Release);
            state.unlock_locked_until_unix.store(0, Ordering::Release);
            let vs = state.vault.read().await;
            if let Err(e) = state.sync.reload_from_db(&state.db, &vs).await {
                tracing::warn!("sync reload_from_db failed after recovery unlock: {e}");
            }
            Ok(())
        }
        Err(AppError::BadPassword) => {
            let failures = state.unlock_failures.fetch_add(1, Ordering::AcqRel) + 1;
            if failures >= UNLOCK_FAILURE_THRESHOLD {
                let exp = failures - UNLOCK_FAILURE_THRESHOLD;
                let shift = exp.min(24);
                let cooldown = UNLOCK_BASE_COOLDOWN_SECS
                    .saturating_mul(1_i64 << shift)
                    .min(UNLOCK_MAX_COOLDOWN_SECS);
                state.unlock_locked_until_unix.store(now + cooldown, Ordering::Release);
            }
            Err(AppError::BadPassword)
        }
        Err(e) => Err(e),
    }
}

#[derive(Serialize)]
pub struct ResetResult {
    pub snapshot_path: String,
}

/// Forgotten-password escape hatch. Wipes every vault-protected row
/// and returns the vault to the uninitialized state, leaving the
/// sessions list intact (minus their credential references). Snapshots
/// the DB first so a user who panic-clicks can pull their data back
/// from the file we wrote.
///
/// Deliberately does NOT require any password — premise is the user
/// has lost theirs. Anyone with local file access can already read the
/// raw DB; resetting it just wipes the encrypted blobs (which they
/// couldn't decrypt anyway without the password or recovery code).
#[tauri::command]
pub async fn vault_reset(state: State<'_, AppState>) -> Result<ResetResult> {
    let snapshot = vault::snapshot::take(&state.db, "reset").await?;
    vault::reset(&state.db).await?;
    *state.vault.write().await = vault::VaultState::Uninitialized;
    state.unlock_failures.store(0, Ordering::Release);
    state.unlock_locked_until_unix.store(0, Ordering::Release);
    Ok(ResetResult {
        snapshot_path: snapshot.to_string_lossy().into_owned(),
    })
}
