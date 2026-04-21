pub mod aead;
pub mod kdf;
#[cfg(test)]
mod tests;

use rand::{rngs::SysRng, TryRng};
use serde::{Deserialize, Serialize};
use sqlx::SqlitePool;
use zeroize::Zeroizing;

use crate::error::{AppError, Result};
use aead::{Aead256, NONCE_LEN};
use kdf::KdfParams;

const VERIFIER_PLAINTEXT: &[u8] = b"ezterm-v0.1-vault";

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
