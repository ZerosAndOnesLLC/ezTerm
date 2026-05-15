pub mod aead;
pub mod kdf;
pub mod recovery;
pub mod snapshot;
#[cfg(test)]
mod tests;

use base64::{engine::general_purpose::STANDARD as B64, Engine};
use rand::{rngs::SysRng, TryRng};
use serde::{Deserialize, Serialize};
use sqlx::{Acquire, SqlitePool};
use zeroize::Zeroizing;

use crate::error::{AppError, Result};
use aead::{Aead256, NONCE_LEN};
use kdf::KdfParams;

const VERIFIER_PLAINTEXT: &[u8] = b"ezterm-v0.1-vault";

/// app_settings keys whose value is a base64(nonce || ciphertext) blob
/// wrapped under the vault key. Listed here so `change_password` can
/// re-encrypt them in one place — adding a new vault-encrypted setting
/// without updating this list will leave it unreadable after a password
/// change.
const VAULT_BLOB_SETTING_KEYS: &[&str] = &[
    "sync.local.passphrase_blob",
    "sync.s3.secret_blob",
    "sync.s3.passphrase_blob",
];

pub enum VaultState {
    Uninitialized,
    Locked,
    Unlocked { key: Zeroizing<[u8; 32]> },
}

impl VaultState {
    pub fn is_unlocked(&self) -> bool { matches!(self, VaultState::Unlocked { .. }) }
}

#[derive(Serialize, Deserialize)]
struct StoredKdfParams {
    m: u32, t: u32, p: u32,
}

impl From<KdfParams> for StoredKdfParams {
    fn from(v: KdfParams) -> Self { Self { m: v.m_cost_kib, t: v.t_cost, p: v.p_cost } }
}
impl From<StoredKdfParams> for KdfParams {
    fn from(v: StoredKdfParams) -> Self {
        KdfParams { m_cost_kib: v.m, t_cost: v.t, p_cost: v.p }
    }
}

pub async fn is_initialized(pool: &SqlitePool) -> Result<bool> {
    let row: Option<(i64,)> = sqlx::query_as("SELECT 1 FROM vault_meta WHERE id = 1")
        .fetch_optional(pool).await?;
    Ok(row.is_some())
}

pub async fn init(pool: &SqlitePool, password: &str) -> Result<VaultState> {
    if is_initialized(pool).await? { return Err(AppError::VaultAlreadyInitialized); }
    let mut salt = [0u8; 16];
    SysRng
        .try_fill_bytes(&mut salt)
        .map_err(|_| AppError::Crypto)?;
    let params = KdfParams::default();
    let key = kdf::derive_key(password.as_bytes(), &salt, params)?;
    let aead = Aead256::new(&key);
    let (nonce, ct) = aead.encrypt(VERIFIER_PLAINTEXT)?;
    // Store verifier as nonce || ct concatenation
    let mut verifier = Vec::with_capacity(nonce.len() + ct.len());
    verifier.extend_from_slice(&nonce);
    verifier.extend_from_slice(&ct);
    let stored_params = serde_json::to_string(&StoredKdfParams::from(params))?;
    sqlx::query("INSERT INTO vault_meta (id, salt, kdf_params, verifier) VALUES (1, ?, ?, ?)")
        .bind(&salt[..]).bind(stored_params).bind(&verifier)
        .execute(pool).await?;
    Ok(VaultState::Unlocked { key })
}

pub async fn unlock(pool: &SqlitePool, password: &str) -> Result<VaultState> {
    let row: (Vec<u8>, String, Vec<u8>) =
        sqlx::query_as("SELECT salt, kdf_params, verifier FROM vault_meta WHERE id = 1")
            .fetch_optional(pool).await?.ok_or(AppError::NotFound)?;
    let (salt, params_json, verifier) = row;
    let stored: StoredKdfParams = serde_json::from_str(&params_json)?;
    let params: KdfParams = stored.into();
    let key = kdf::derive_key(password.as_bytes(), &salt, params)?;
    if verifier.len() < NONCE_LEN { return Err(AppError::Crypto); }
    let (nonce, ct) = verifier.split_at(NONCE_LEN);
    let aead = Aead256::new(&key);
    let pt = aead.decrypt(nonce, ct).map_err(|_| AppError::BadPassword)?;
    if pt != VERIFIER_PLAINTEXT { return Err(AppError::BadPassword); }
    Ok(VaultState::Unlocked { key })
}

/// Verify a password against the stored vault metadata without returning
/// the derived key or changing any state. Mirrors `unlock`'s crypto
/// exactly so timing / error surface is identical, but the derived key
/// is dropped (zeroised via `Zeroizing`) before return. Returns true on
/// match, false on mismatch, Err on storage / KDF failures.
pub async fn verify_password(pool: &SqlitePool, password: &str) -> Result<bool> {
    let row: (Vec<u8>, String, Vec<u8>) =
        sqlx::query_as("SELECT salt, kdf_params, verifier FROM vault_meta WHERE id = 1")
            .fetch_optional(pool).await?.ok_or(AppError::NotFound)?;
    let (salt, params_json, verifier) = row;
    let stored: StoredKdfParams = serde_json::from_str(&params_json)?;
    let params: KdfParams = stored.into();
    let key = kdf::derive_key(password.as_bytes(), &salt, params)?;
    if verifier.len() < NONCE_LEN {
        return Err(AppError::Crypto);
    }
    let (nonce, ct) = verifier.split_at(NONCE_LEN);
    let aead = Aead256::new(&key);
    Ok(matches!(aead.decrypt(nonce, ct), Ok(pt) if pt == VERIFIER_PLAINTEXT))
}

pub fn encrypt_with(state: &VaultState, plaintext: &[u8]) -> Result<(Vec<u8>, Vec<u8>)> {
    match state {
        VaultState::Unlocked { key } => Aead256::new(key).encrypt(plaintext),
        _ => Err(AppError::VaultLocked),
    }
}

pub fn decrypt_with(state: &VaultState, nonce: &[u8], ciphertext: &[u8]) -> Result<Vec<u8>> {
    match state {
        VaultState::Unlocked { key } => Aead256::new(key).decrypt(nonce, ciphertext),
        _ => Err(AppError::VaultLocked),
    }
}

/// Re-key the entire vault under a new master password. All-or-nothing
/// via a single sqlx transaction: every encrypted row is decrypted with
/// the old key and re-encrypted with the new key, then `vault_meta` is
/// rewritten with a fresh salt, the current default KDF parameters, and
/// a verifier under the new key. If any step fails, the transaction
/// rolls back and the vault state on disk is untouched.
///
/// On success the caller should lock the vault — the returned key is the
/// new password key, but we leave the decision to the command layer so a
/// password change can force a re-unlock.
///
/// Any existing recovery code is invalidated: its wrap was made under
/// the old password key and no longer corresponds to the new key. The
/// `recovery_*` columns are cleared so the UI surfaces "regenerate".
pub async fn change_password(
    pool: &SqlitePool,
    old_password: &str,
    new_password: &str,
) -> Result<Zeroizing<[u8; 32]>> {
    // Derive the old key from the stored salt+params and verify against
    // the verifier. This is the same KDF run as `unlock`; doing it here
    // (rather than trusting an in-memory key) means a caller can't
    // silently corrupt the vault by passing stale material.
    let row: (Vec<u8>, String, Vec<u8>) =
        sqlx::query_as("SELECT salt, kdf_params, verifier FROM vault_meta WHERE id = 1")
            .fetch_optional(pool).await?.ok_or(AppError::NotFound)?;
    let (old_salt, old_params_json, verifier) = row;
    let old_stored: StoredKdfParams = serde_json::from_str(&old_params_json)?;
    let old_key = kdf::derive_key(old_password.as_bytes(), &old_salt, old_stored.into())?;
    if verifier.len() < NONCE_LEN { return Err(AppError::Crypto); }
    {
        let (nonce, ct) = verifier.split_at(NONCE_LEN);
        let pt = Aead256::new(&old_key).decrypt(nonce, ct)
            .map_err(|_| AppError::BadPassword)?;
        if pt != VERIFIER_PLAINTEXT { return Err(AppError::BadPassword); }
    }

    // Derive new key + materials before the tx so KDF cost doesn't hold
    // a write lock on the DB.
    let mut new_salt = [0u8; 16];
    SysRng.try_fill_bytes(&mut new_salt).map_err(|_| AppError::Crypto)?;
    let params = KdfParams::default();
    let new_key = kdf::derive_key(new_password.as_bytes(), &new_salt, params)?;
    let old_aead = Aead256::new(&old_key);
    let new_aead = Aead256::new(&new_key);

    // Decrypt + re-encrypt outside the tx (the heavy work is the AEAD,
    // which is fast, but pulling rows out first lets us validate the
    // whole set before mutating anything). If any row is unreadable
    // under old_key, abort — that means the supplied key didn't actually
    // match the row's nonce/ct and the vault is already corrupt.
    let cred_rows: Vec<(i64, Vec<u8>, Vec<u8>)> =
        sqlx::query_as("SELECT id, nonce, ciphertext FROM credentials")
            .fetch_all(pool).await?;
    let mut cred_rewrap: Vec<(i64, Vec<u8>, Vec<u8>)> = Vec::with_capacity(cred_rows.len());
    for (id, nonce, ct) in cred_rows {
        if nonce.len() != NONCE_LEN { return Err(AppError::Crypto); }
        let pt = Zeroizing::new(old_aead.decrypt(&nonce, &ct)?);
        let (n2, c2) = new_aead.encrypt(&pt)?;
        cred_rewrap.push((id, n2, c2));
    }

    let mut blob_rewrap: Vec<(&'static str, String)> = Vec::new();
    for key in VAULT_BLOB_SETTING_KEYS {
        let row: Option<(String,)> =
            sqlx::query_as("SELECT value FROM app_settings WHERE key = ?")
                .bind(*key).fetch_optional(pool).await?;
        let Some((b64,)) = row else { continue };
        let bytes = B64.decode(&b64).map_err(|_| AppError::Crypto)?;
        if bytes.len() < NONCE_LEN { return Err(AppError::Crypto); }
        let (nonce, ct) = bytes.split_at(NONCE_LEN);
        let pt = Zeroizing::new(old_aead.decrypt(nonce, ct)?);
        let (n2, c2) = new_aead.encrypt(&pt)?;
        let mut combined = Vec::with_capacity(n2.len() + c2.len());
        combined.extend_from_slice(&n2);
        combined.extend_from_slice(&c2);
        blob_rewrap.push((key, B64.encode(&combined)));
    }

    // New verifier under the new key.
    let (vnonce, vct) = new_aead.encrypt(VERIFIER_PLAINTEXT)?;
    let mut new_verifier = Vec::with_capacity(vnonce.len() + vct.len());
    new_verifier.extend_from_slice(&vnonce);
    new_verifier.extend_from_slice(&vct);
    let new_params_json = serde_json::to_string(&StoredKdfParams::from(params))?;

    // Single transaction: replace vault_meta, all credential rows, all
    // sync blob settings. SQLite serialises writes so concurrent readers
    // (e.g. a sync push currently consuming the vault key) will see
    // either fully-old or fully-new state.
    let mut conn = pool.acquire().await?;
    let mut tx = conn.begin().await?;

    sqlx::query(
        "UPDATE vault_meta SET salt = ?, kdf_params = ?, verifier = ?, \
         recovery_salt = NULL, recovery_kdf_params = NULL, recovery_wrapped_key = NULL \
         WHERE id = 1",
    )
        .bind(&new_salt[..])
        .bind(&new_params_json)
        .bind(&new_verifier)
        .execute(&mut *tx).await?;

    for (id, nonce, ct) in &cred_rewrap {
        sqlx::query("UPDATE credentials SET nonce = ?, ciphertext = ? WHERE id = ?")
            .bind(nonce).bind(ct).bind(id)
            .execute(&mut *tx).await?;
    }
    for (key, b64) in &blob_rewrap {
        sqlx::query("UPDATE app_settings SET value = ? WHERE key = ?")
            .bind(b64).bind(*key)
            .execute(&mut *tx).await?;
    }
    tx.commit().await?;

    Ok(new_key)
}

/// Wipe all vault-protected data so the user can start over after
/// forgetting their master password. Sessions survive but lose their
/// credential reference (`credential_id` becomes NULL). Single
/// transaction — partial wipe would leave the app in a worse state than
/// either fully wiped or untouched.
pub async fn reset(pool: &SqlitePool) -> Result<()> {
    let mut conn = pool.acquire().await?;
    let mut tx = conn.begin().await?;
    sqlx::query("UPDATE sessions SET credential_id = NULL").execute(&mut *tx).await?;
    sqlx::query("DELETE FROM credentials").execute(&mut *tx).await?;
    for key in VAULT_BLOB_SETTING_KEYS {
        sqlx::query("DELETE FROM app_settings WHERE key = ?")
            .bind(*key).execute(&mut *tx).await?;
    }
    // Also drop the sync.kind setting so the writer task doesn't keep
    // trying to push under a disabled config.
    sqlx::query("DELETE FROM app_settings WHERE key = ?")
        .bind("sync.kind").execute(&mut *tx).await?;
    sqlx::query("DELETE FROM vault_meta").execute(&mut *tx).await?;
    tx.commit().await?;
    Ok(())
}
