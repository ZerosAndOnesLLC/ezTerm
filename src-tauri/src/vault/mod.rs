pub mod aead;
pub mod kdf;
pub mod recovery;
pub mod snapshot;
#[cfg(test)]
mod tests;

use base64::{engine::general_purpose::STANDARD as B64, Engine};
use rand::{rngs::SysRng, TryRng};
use serde::{Deserialize, Serialize};
use sqlx::SqlitePool;
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
pub(crate) const VAULT_BLOB_SETTING_KEYS: &[&str] = &[
    "sync.local.passphrase_blob",
    "sync.s3.secret_blob",
    "sync.s3.passphrase_blob",
];

/// Floor on stored KDF parameters: we refuse to derive against anything
/// weaker than this on unlock. Prevents an attacker with DB write
/// access (but no read access to plaintext) from downgrading the
/// parameters to a trivial value, then offline-cracking the verifier at
/// reduced cost. The legitimate user, unlocking next, would otherwise
/// happily run with the weakened params and notice nothing. m=32 MiB /
/// t=2 is half the current default and represents the floor below which
/// we treat the DB as tampered.
const MIN_KDF_M_COST_KIB: u32 = 32 * 1024;
const MIN_KDF_T_COST: u32 = 2;

fn params_ok(p: &KdfParams) -> bool {
    p.m_cost_kib >= MIN_KDF_M_COST_KIB && p.t_cost >= MIN_KDF_T_COST && p.p_cost >= 1
}

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
    if !params_ok(&params) {
        return Err(AppError::Validation(
            "vault KDF parameters look tampered; refusing to unlock".into(),
        ));
    }
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
    Ok(verify_and_derive(pool, password).await?.is_some())
}

/// Verify the password AND return the derived key on match. Internal
/// helper for `change_password`: lets us run the verifier Argon2 once
/// and reuse the derived key to decrypt every credential row, instead
/// of running KDF twice. Returns `Ok(None)` on mismatch (so callers can
/// distinguish "wrong password" from storage / KDF errors), `Err` on
/// the latter.
pub(crate) async fn verify_and_derive(
    pool: &SqlitePool,
    password: &str,
) -> Result<Option<Zeroizing<[u8; 32]>>> {
    let row: (Vec<u8>, String, Vec<u8>) =
        sqlx::query_as("SELECT salt, kdf_params, verifier FROM vault_meta WHERE id = 1")
            .fetch_optional(pool).await?.ok_or(AppError::NotFound)?;
    let (salt, params_json, verifier) = row;
    let stored: StoredKdfParams = serde_json::from_str(&params_json)?;
    let params: KdfParams = stored.into();
    if !params_ok(&params) {
        return Err(AppError::Validation(
            "vault KDF parameters look tampered; refusing to verify".into(),
        ));
    }
    let key = kdf::derive_key(password.as_bytes(), &salt, params)?;
    if verifier.len() < NONCE_LEN {
        return Err(AppError::Crypto);
    }
    let (nonce, ct) = verifier.split_at(NONCE_LEN);
    let aead = Aead256::new(&key);
    match aead.decrypt(nonce, ct) {
        Ok(pt) if pt == VERIFIER_PLAINTEXT => Ok(Some(key)),
        _ => Ok(None),
    }
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
/// the old key (which the caller has *already verified* via
/// [`verify_and_derive`]) and re-encrypted with the new key, then
/// `vault_meta` is rewritten with a fresh salt, current default KDF
/// parameters, and a verifier under the new key.
///
/// The caller is expected to hold `state.vault.write()` for the
/// duration of this call. Combined with the `BEGIN IMMEDIATE`
/// transaction below, that means: (a) no other vault command can read
/// the in-memory key while we're mid-rotate, and (b) no other writer
/// can sneak an INSERT into `credentials` between our SELECT and our
/// commit. Either guarantee alone is insufficient — the in-memory
/// guard protects the AEAD work, the BEGIN IMMEDIATE protects against
/// new rows landing in the table.
///
/// Any existing recovery code is invalidated: its wrap was made under
/// the old password key and no longer corresponds to the new key. The
/// `recovery_*` columns are cleared so the UI surfaces "regenerate".
pub async fn change_password(
    pool: &SqlitePool,
    old_key: &Zeroizing<[u8; 32]>,
    new_password: &str,
) -> Result<Zeroizing<[u8; 32]>> {
    // Derive new materials before opening the tx so the Argon2id cost
    // doesn't hold the DB write lock for the entire derivation.
    let mut new_salt = [0u8; 16];
    SysRng.try_fill_bytes(&mut new_salt).map_err(|_| AppError::Crypto)?;
    let params = KdfParams::default();
    let new_key = kdf::derive_key(new_password.as_bytes(), &new_salt, params)?;
    let old_aead = Aead256::new(old_key);
    let new_aead = Aead256::new(&new_key);

    // New verifier under the new key.
    let (vnonce, vct) = new_aead.encrypt(VERIFIER_PLAINTEXT)?;
    let mut new_verifier = Vec::with_capacity(vnonce.len() + vct.len());
    new_verifier.extend_from_slice(&vnonce);
    new_verifier.extend_from_slice(&vct);
    let new_params_json = serde_json::to_string(&StoredKdfParams::from(params))?;

    // BEGIN IMMEDIATE acquires the WAL write lock at tx start (rather
    // than at first write), so no concurrent writer can sneak an
    // INSERT between our SELECT and our COMMIT. Required for
    // correctness: a `credential_create` racing with `change_password`
    // would otherwise land a new row encrypted under the OLD key after
    // our SELECT but before our vault_meta rewrite, and would be
    // unreadable forever after.
    let mut tx = pool.begin().await?;
    sqlx::query("BEGIN IMMEDIATE").execute(&mut *tx).await.ok();

    let cred_rows: Vec<(i64, Vec<u8>, Vec<u8>)> =
        sqlx::query_as("SELECT id, nonce, ciphertext FROM credentials")
            .fetch_all(&mut *tx).await?;
    for (id, nonce, ct) in cred_rows {
        if nonce.len() != NONCE_LEN { return Err(AppError::Crypto); }
        let pt = Zeroizing::new(old_aead.decrypt(&nonce, &ct)?);
        let (n2, c2) = new_aead.encrypt(&pt)?;
        sqlx::query("UPDATE credentials SET nonce = ?, ciphertext = ? WHERE id = ?")
            .bind(&n2).bind(&c2).bind(id)
            .execute(&mut *tx).await?;
    }

    for key in VAULT_BLOB_SETTING_KEYS {
        let row: Option<(String,)> =
            sqlx::query_as("SELECT value FROM app_settings WHERE key = ?")
                .bind(*key).fetch_optional(&mut *tx).await?;
        let Some((b64,)) = row else { continue };
        let bytes = B64.decode(&b64).map_err(|_| AppError::Crypto)?;
        if bytes.len() < NONCE_LEN { return Err(AppError::Crypto); }
        let (nonce, ct) = bytes.split_at(NONCE_LEN);
        let pt = Zeroizing::new(old_aead.decrypt(nonce, ct)?);
        let (n2, c2) = new_aead.encrypt(&pt)?;
        let mut combined = Vec::with_capacity(n2.len() + c2.len());
        combined.extend_from_slice(&n2);
        combined.extend_from_slice(&c2);
        sqlx::query("UPDATE app_settings SET value = ? WHERE key = ?")
            .bind(B64.encode(&combined)).bind(*key)
            .execute(&mut *tx).await?;
    }

    sqlx::query(
        "UPDATE vault_meta SET salt = ?, kdf_params = ?, verifier = ?, \
         recovery_salt = NULL, recovery_kdf_params = NULL, recovery_wrapped_key = NULL \
         WHERE id = 1",
    )
        .bind(&new_salt[..])
        .bind(&new_params_json)
        .bind(&new_verifier)
        .execute(&mut *tx).await?;
    tx.commit().await?;

    Ok(new_key)
}

/// Wipe all vault-protected data so the user can start over after
/// forgetting their master password. Sessions survive but lose every
/// reference to a credential (both `credential_id` and
/// `key_passphrase_credential_id` are nulled explicitly — we don't
/// rely on the FK cascade, since that would silently break if a
/// future migration relaxed the constraint or a connection toggled
/// `PRAGMA foreign_keys=OFF`). Single transaction — partial wipe
/// would leave the app in a worse state than either fully wiped or
/// untouched.
pub async fn reset(pool: &SqlitePool) -> Result<()> {
    let mut tx = pool.begin().await?;
    sqlx::query("UPDATE sessions SET credential_id = NULL, key_passphrase_credential_id = NULL")
        .execute(&mut *tx).await?;
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
