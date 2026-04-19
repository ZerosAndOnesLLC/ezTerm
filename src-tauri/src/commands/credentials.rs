use tauri::State;
use zeroize::Zeroize;

use crate::commands::require_unlocked;
use crate::db::credentials::{self, CredentialMeta};
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
    mut plaintext: String,
) -> Result<CredentialMeta> {
    require_unlocked(&state).await?;
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
        plaintext.zeroize();
        return Err(AppError::Validation("secret too long".into()));
    }

    // Scope the vault read guard so it is dropped before the DB insert.
    let (nonce, ct) = {
        let vault_state = state.vault.read().await;
        vault::encrypt_with(&vault_state, plaintext.as_bytes())?
    };
    plaintext.zeroize();

    let id = credentials::insert(&state.db, &kind, label.trim(), &nonce, &ct).await?;
    Ok(CredentialMeta {
        id,
        kind,
        label: label.trim().into(),
    })
}

#[tauri::command]
pub async fn credential_delete(state: State<'_, AppState>, id: i64) -> Result<()> {
    require_unlocked(&state).await?;
    credentials::delete(&state.db, id).await
}
