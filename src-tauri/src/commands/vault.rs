use std::sync::atomic::Ordering;

use chrono::Utc;
use serde::Serialize;
use tauri::State;
use zeroize::{Zeroize, Zeroizing};

use crate::error::{AppError, Result};
use crate::state::AppState;
use crate::sync::SyncTarget;
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

/// Server-side sentinel for `vault_reset`. The Tauri command requires
/// the caller to send this exact string; any other path (a stray
/// invoke from inside the webview, a rogue page reached via the xterm
/// web-links addon, a future XSS in a session label rendered into the
/// React tree) can't trigger a wipe without knowing it. The "DELETE"
/// the UI asks the user to type is mapped to this on submit.
const RESET_CONFIRMATION_TOKEN: &str = "DELETE-MY-VAULT";

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
    check_cooldown(state, now)?;

    match vault::unlock(&state.db, password).await {
        Ok(new_state) => {
            *state.vault.write().await = new_state;
            clear_failures(state);
            let vs = state.vault.read().await;
            if let Err(e) = state.sync.reload_from_db(&state.db, &vs).await {
                tracing::warn!("sync reload_from_db failed: {e}");
            }
            Ok(())
        }
        Err(AppError::BadPassword) => {
            record_failure(state, now);
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
/// credentials" or "enter master password to generate a recovery
/// code"). Shares the same lockout cooldown as `vault_unlock` so an
/// attacker can't bypass it by routing through this endpoint.
#[tauri::command]
pub async fn vault_verify_password(state: State<'_, AppState>, password: String) -> Result<bool> {
    let mut password = password;
    let result = vault_verify_password_inner(&state, &password).await;
    password.zeroize();
    result
}

async fn vault_verify_password_inner(
    state: &State<'_, AppState>,
    password: &str,
) -> Result<bool> {
    if password.len() > MAX_PASSWORD_LEN {
        return Err(AppError::Validation("password too long".into()));
    }
    let now = Utc::now().timestamp();
    check_cooldown(state, now)?;
    let ok = vault::verify_password(&state.db, password).await?;
    if ok {
        clear_failures(state);
    } else {
        record_failure(state, now);
    }
    Ok(ok)
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
/// SQLite file *after* old-password verification (so wrong-password
/// typos don't churn the snapshot rotation). On success the vault is
/// locked AND every active SSH/SFTP/local connection is closed —
/// they hold credentials decrypted under the old key, and keeping
/// them open across a rotation leaks resources on every change.
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
    validate_new_password(new_password)?;
    if old_password == new_password {
        return Err(AppError::Validation(
            "new password must differ from old password".into(),
        ));
    }

    // Share cooldown with unlock paths — change_password runs the same
    // Argon2id verifier as vault_unlock and would otherwise be the
    // weak link in the lockout policy.
    let now = Utc::now().timestamp();
    check_cooldown(state, now)?;

    // Hold the vault write lock for the entire operation. This blocks
    // every other command that reads `state.vault` (sync writer,
    // credential_create, ssh_connect's load_auth_material, etc.) while
    // we re-key, so a concurrent reader can't observe a torn rekey.
    // Combined with `change_password`'s BEGIN IMMEDIATE tx, that means
    // both the on-disk and in-memory states flip atomically from the
    // perspective of any other vault user.
    let mut vault_guard = state.vault.write().await;

    // Verify the old password and derive the key in one Argon2 run —
    // we reuse the derived key as the "old key" passed to
    // change_password, which avoids running KDF a second time just to
    // get the same bytes the in-memory state already holds.
    let old_key = match vault::verify_and_derive(&state.db, old_password).await? {
        Some(k) => k,
        None => {
            record_failure(state, now);
            return Err(AppError::BadPassword);
        }
    };

    // Snapshot only AFTER we know the old password verifies — a
    // typo'd attempt would otherwise burn one of the KEEP slots.
    let snapshot = vault::snapshot::take(&state.db, "change-password").await?;

    let _new_key: Zeroizing<[u8; 32]> =
        vault::change_password(&state.db, &old_key, new_password).await?;

    // Lock + clear lockout counters; the user must re-unlock with the
    // new password.
    *vault_guard = vault::VaultState::Locked;
    drop(vault_guard);
    clear_failures(state);

    // Tear down every active session and sync target. Open SSH/SFTP
    // connections were authenticated with the old key, and the sync
    // writer is holding the old passphrase in memory. Both must drop
    // before the user re-unlocks under the new key.
    teardown_after_vault_rotation(state).await;

    Ok(ChangePasswordResult {
        snapshot_path: snapshot.to_string_lossy().into_owned(),
    })
}

#[derive(Serialize)]
pub struct RecoveryStatus {
    pub provisioned: bool,
}

/// Whether the vault has a recovery code provisioned. Deliberately
/// exposed without `require_unlocked` because the unlock screen polls
/// it to decide whether to show "Use recovery code". The result is a
/// single bit — same information disclosure as the user typing a
/// recovery code and finding out it doesn't work, except cheaper.
#[tauri::command]
pub async fn vault_recovery_status(state: State<'_, AppState>) -> Result<RecoveryStatus> {
    let provisioned = vault::recovery::is_provisioned(&state.db).await?;
    Ok(RecoveryStatus { provisioned })
}

#[derive(Serialize)]
pub struct GenerateRecoveryResult {
    /// The new code, shown to the user exactly once.
    pub code: String,
    /// Where the pre-regeneration snapshot was written, if any. None
    /// when no recovery code was previously provisioned.
    pub snapshot_path: Option<String>,
}

/// Generate (or regenerate) a one-time recovery code. Requires the
/// caller to re-verify the master password — being unlocked alone
/// isn't enough, otherwise anyone with access to a momentarily
/// unattended laptop could provision a recovery backdoor.
#[tauri::command]
pub async fn vault_generate_recovery_code(
    state: State<'_, AppState>,
    password: String,
) -> Result<GenerateRecoveryResult> {
    let mut password = password;
    let result = vault_generate_recovery_code_inner(&state, &password).await;
    password.zeroize();
    result
}

async fn vault_generate_recovery_code_inner(
    state: &State<'_, AppState>,
    password: &str,
) -> Result<GenerateRecoveryResult> {
    super::require_unlocked(state).await?;
    if password.len() > MAX_PASSWORD_LEN {
        return Err(AppError::Validation("password too long".into()));
    }
    let now = Utc::now().timestamp();
    check_cooldown(state, now)?;
    if !vault::verify_password(&state.db, password).await? {
        record_failure(state, now);
        return Err(AppError::BadPassword);
    }
    clear_failures(state);

    // Hold the vault write lock so a concurrent change_password can't
    // re-key the vault between our read of the in-memory key and our
    // write to recovery_*; otherwise the wrap could bind a stale key
    // and the freshly-issued code would be broken from issuance.
    let vault_guard = state.vault.write().await;
    let (code, snapshot) = vault::recovery::generate_with_snapshot(&state.db, &vault_guard).await?;
    drop(vault_guard);

    Ok(GenerateRecoveryResult {
        code,
        snapshot_path: snapshot.map(|p| p.to_string_lossy().into_owned()),
    })
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
    let now = Utc::now().timestamp();
    check_cooldown(state, now)?;
    match vault::recovery::unlock_with_code(&state.db, code).await {
        Ok(key) => {
            *state.vault.write().await = vault::VaultState::Unlocked { key };
            clear_failures(state);
            let vs = state.vault.read().await;
            if let Err(e) = state.sync.reload_from_db(&state.db, &vs).await {
                tracing::warn!("sync reload_from_db failed after recovery unlock: {e}");
            }
            Ok(())
        }
        Err(AppError::BadPassword) => {
            record_failure(state, now);
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
/// sessions list intact (minus their credential references).
///
/// Requires an explicit confirmation token (the UI asks the user to
/// type "DELETE" and maps it to the sentinel). Without that token a
/// stray invoke from inside the webview — a future XSS in a session
/// label, a rogue page reached via the xterm web-links addon — can't
/// silently wipe the vault.
///
/// Snapshots the DB first so a user who panic-clicks can pull data
/// back from the file we wrote. Also closes every active connection
/// and clears the in-memory sync target — the latter is critical:
/// the sync writer holds the old passphrase in memory and would
/// otherwise keep PUTting to the configured remote with credentials
/// the vault no longer has.
#[tauri::command]
pub async fn vault_reset(
    state: State<'_, AppState>,
    confirmation: String,
) -> Result<ResetResult> {
    if confirmation != RESET_CONFIRMATION_TOKEN {
        return Err(AppError::Validation(
            "missing or invalid confirmation token".into(),
        ));
    }
    if !vault::is_initialized(&state.db).await? {
        return Err(AppError::Validation(
            "vault is not initialized; nothing to reset".into(),
        ));
    }
    let snapshot = vault::snapshot::take(&state.db, "reset").await?;
    vault::reset(&state.db).await?;
    *state.vault.write().await = vault::VaultState::Uninitialized;
    clear_failures(&state);
    teardown_after_vault_rotation(&state).await;
    Ok(ResetResult {
        snapshot_path: snapshot.to_string_lossy().into_owned(),
    })
}

// ===== helpers ===========================================================

fn validate_new_password(new_password: &str) -> Result<()> {
    if new_password.len() < 12 {
        return Err(AppError::Validation(
            "new master password must be at least 12 characters".into(),
        ));
    }
    if new_password.len() > MAX_PASSWORD_LEN {
        return Err(AppError::Validation("new password too long".into()));
    }
    // Require at least two character classes so a 12×'a' string is
    // rejected. Cheap floor; the UI strength meter handles nuance.
    let has_lower = new_password.chars().any(|c| c.is_ascii_lowercase());
    let has_upper = new_password.chars().any(|c| c.is_ascii_uppercase());
    let has_digit = new_password.chars().any(|c| c.is_ascii_digit());
    let has_other = new_password.chars().any(|c| !c.is_ascii_alphanumeric());
    let classes = [has_lower, has_upper, has_digit, has_other]
        .into_iter().filter(|b| *b).count();
    if classes < 2 {
        return Err(AppError::Validation(
            "new password must mix at least two of: lowercase, uppercase, digit, symbol".into(),
        ));
    }
    Ok(())
}

fn check_cooldown(state: &State<'_, AppState>, now: i64) -> Result<()> {
    let locked_until = state.unlock_locked_until_unix.load(Ordering::Acquire);
    if locked_until > now {
        let remaining = locked_until - now;
        return Err(AppError::Validation(format!(
            "too many attempts; try again in {remaining}s"
        )));
    }
    Ok(())
}

fn record_failure(state: &State<'_, AppState>, now: i64) {
    let failures = state.unlock_failures.fetch_add(1, Ordering::AcqRel) + 1;
    if failures >= UNLOCK_FAILURE_THRESHOLD {
        let exp = failures - UNLOCK_FAILURE_THRESHOLD;
        let shift = exp.min(24);
        let cooldown = UNLOCK_BASE_COOLDOWN_SECS
            .saturating_mul(1_i64 << shift)
            .min(UNLOCK_MAX_COOLDOWN_SECS);
        state
            .unlock_locked_until_unix
            .store(now + cooldown, Ordering::Release);
    }
}

fn clear_failures(state: &State<'_, AppState>) {
    state.unlock_failures.store(0, Ordering::Release);
    state.unlock_locked_until_unix.store(0, Ordering::Release);
}

/// Close every active SSH/SFTP/local connection and clear the sync
/// target. Called after a successful vault rotation (change_password,
/// reset) so no in-flight resource keeps credentials decrypted under
/// the old key and no background task keeps pushing to the previous
/// sync remote.
async fn teardown_after_vault_rotation(state: &State<'_, AppState>) {
    // Snapshot ids first, then drop them outside the registry locks.
    let ssh_ids = state.ssh.list_all().await.into_iter().map(|c| c.id).collect::<Vec<_>>();
    for id in ssh_ids {
        state.close_connection(id).await;
    }
    let sftp_ids = state.sftp.list_ids().await;
    for id in sftp_ids {
        state.sftp.remove(id).await;
    }
    let local_ids = state.local.list_ids().await;
    for id in local_ids {
        state.local.close(id).await;
    }
    state.sync.set_target(SyncTarget::None).await;
    // The sync writer task itself stays alive; it just won't fire
    // until the user reconfigures sync (or unlock hydrates a new
    // target from settings).
}
