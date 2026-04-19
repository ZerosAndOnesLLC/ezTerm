use tauri::State;
use zeroize::Zeroize;

use crate::db::credentials::{self, CredentialMeta};
use crate::error::{AppError, Result};
use crate::state::AppState;
use crate::vault;

#[tauri::command]
pub async fn credential_list(state: State<'_, AppState>) -> Result<Vec<CredentialMeta>> {
    credentials::list(&state.db).await
}

#[tauri::command]
pub async fn credential_create(
    state: State<'_, AppState>,
    kind: String,
    label: String,
    mut plaintext: String,
) -> Result<CredentialMeta> {
    if !matches!(kind.as_str(), "password" | "private_key" | "key_passphrase") {
        return Err(AppError::Validation("invalid kind".into()));
    }
    if label.trim().is_empty() {
        return Err(AppError::Validation("label required".into()));
    }
    let vault_state = state.vault.read().await;
    let (nonce, ct) = vault::encrypt_with(&vault_state, plaintext.as_bytes())?;
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
    credentials::delete(&state.db, id).await
}
