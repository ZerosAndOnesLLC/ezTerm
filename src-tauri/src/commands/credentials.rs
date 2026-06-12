use tauri::State;
use zeroize::Zeroizing;

use crate::commands::require_unlocked;
use crate::db::credentials::{self, CredentialDetail, CredentialMeta};
use crate::error::{AppError, Result};
use crate::state::AppState;
use crate::vault;

// 64 KiB accommodates even large OpenSSH/PEM private keys while bounding
// memory and ciphertext blob size written to SQLite.
const MAX_PLAINTEXT_LEN: usize = 65_536;
const MAX_LABEL_LEN: usize = 256;

#[tauri::command]
pub async fn credential_list(state: State<'_, AppState>) -> Result<Vec<CredentialMeta>> {
    require_unlocked(&state).await?;
    credentials::list(&state.db).await
}

#[tauri::command]
pub async fn credential_create(
    state: State<'_, AppState>,
    kind: String,
    label: String,
    plaintext: String,
) -> Result<CredentialMeta> {
    require_unlocked(&state).await?;
    // Wrap immediately so every return path — validation errors and a
    // failed encrypt alike — zeroizes the secret on drop.
    let plaintext = Zeroizing::new(plaintext);
    if !matches!(kind.as_str(), "password" | "private_key" | "key_passphrase") {
        return Err(AppError::Validation("invalid kind".into()));
    }
    if label.trim().is_empty() {
        return Err(AppError::Validation("label required".into()));
    }
    if label.len() > MAX_LABEL_LEN {
        return Err(AppError::Validation("label too long".into()));
    }
    if plaintext.len() > MAX_PLAINTEXT_LEN {
        return Err(AppError::Validation("secret too long".into()));
    }

    // Scope the vault read guard so it is dropped before the DB insert.
    let (nonce, ct) = {
        let vault_state = state.vault.read().await;
        vault::encrypt_with(&vault_state, plaintext.as_bytes())?
    };

    let id = credentials::insert(&state.db, &kind, label.trim(), &nonce, &ct).await?;
    state.sync.trigger();
    Ok(CredentialMeta {
        id,
        kind,
        label: label.trim().into(),
    })
}

#[tauri::command]
pub async fn credential_list_detailed(
    state: State<'_, AppState>,
) -> Result<Vec<CredentialDetail>> {
    require_unlocked(&state).await?;
    credentials::list_detailed(&state.db).await
}

/// Rename a credential and/or replace its secret. Each field is
/// independent: `label: None` rotates the secret without touching the
/// name (so a stale UI label can't silently revert a rename), and
/// `plaintext: None` (or empty) renames without re-entering the secret.
#[tauri::command]
pub async fn credential_update(
    state: State<'_, AppState>,
    id: i64,
    label: Option<String>,
    plaintext: Option<String>,
) -> Result<()> {
    require_unlocked(&state).await?;
    // Wrap immediately so every return path zeroizes the secret on drop.
    let plaintext = plaintext.map(Zeroizing::new);

    if let Some(l) = &label {
        if l.trim().is_empty() {
            return Err(AppError::Validation("label required".into()));
        }
        if l.len() > MAX_LABEL_LEN {
            return Err(AppError::Validation("label too long".into()));
        }
    }

    let secret = match &plaintext {
        Some(pt) if !pt.is_empty() => {
            if pt.len() > MAX_PLAINTEXT_LEN {
                return Err(AppError::Validation("secret too long".into()));
            }
            // Scope the vault read guard so it is dropped before the DB write.
            let vault_state = state.vault.read().await;
            Some(vault::encrypt_with(&vault_state, pt.as_bytes())?)
        }
        _ => None,
    };
    if label.is_none() && secret.is_none() {
        return Err(AppError::Validation("nothing to update".into()));
    }

    credentials::update(
        &state.db,
        id,
        label.as_deref().map(str::trim),
        secret.as_ref().map(|(n, c)| (n.as_slice(), c.as_slice())),
    )
    .await?;
    state.sync.trigger();
    Ok(())
}

#[tauri::command]
pub async fn credential_delete(state: State<'_, AppState>, id: i64) -> Result<()> {
    require_unlocked(&state).await?;
    credentials::delete(&state.db, id).await?;
    state.sync.trigger();
    Ok(())
}
