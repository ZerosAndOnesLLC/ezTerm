//! Recovery code: an out-of-band path to unlock the vault when the
//! master password is lost. The code is a random 24-character RFC 4648
//! base32 string (120 bits of entropy, shown to the user once, never
//! stored in plaintext).
//!
//! How it's wired:
//! - At creation time we derive a recovery key from `code || recovery_salt`
//!   via Argon2id with the current default KDF params, then AEAD-encrypt
//!   the *current vault key* (the password-derived key) under it. The
//!   wrap is stored as `nonce || ciphertext` in `vault_meta`.
//! - To unlock with the recovery code we re-derive the recovery key,
//!   decrypt the wrap, get the vault key, and use it like a normal
//!   unlock.
//! - Password change invalidates the wrap (the new password derives a
//!   new vault key) — `change_password` clears the recovery_* columns.
//! - A successful recovery-unlock also clears the wrap. The recovery
//!   code is single-use; if a user wants another, they regenerate
//!   while unlocked. This is the only way to make a leaked code stop
//!   being a permanent backdoor without forcing a same-flow password
//!   change (which we can't, because the user invoked recovery
//!   *because* they forgot the password).

use rand::{rngs::SysRng, TryRng};
use sqlx::SqlitePool;
use zeroize::Zeroizing;

use crate::error::{AppError, Result};
use super::{
    aead::{Aead256, NONCE_LEN},
    kdf::{self, KdfParams},
    snapshot, StoredKdfParams, VaultState, VERIFIER_PLAINTEXT,
};

const RECOVERY_CODE_BYTES: usize = 15; // 120 bits — encodes to exactly 24 base32 chars (no padding)

/// RFC 4648 base32 alphabet (uppercase, no padding). 24 chars × 5 bits = 120 bits.
const B32_ALPHA: &[u8; 32] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

fn encode_base32(bytes: &[u8]) -> String {
    let mut out = String::with_capacity((bytes.len() * 8).div_ceil(5));
    let mut buf: u32 = 0;
    let mut bits: u32 = 0;
    for b in bytes {
        buf = (buf << 8) | (*b as u32);
        bits += 8;
        while bits >= 5 {
            bits -= 5;
            let idx = ((buf >> bits) & 0x1f) as usize;
            out.push(B32_ALPHA[idx] as char);
        }
    }
    if bits > 0 {
        let idx = ((buf << (5 - bits)) & 0x1f) as usize;
        out.push(B32_ALPHA[idx] as char);
    }
    out
}

/// Decode a user-typed recovery code into raw bytes. Returns
/// `Zeroizing<Vec<u8>>` so the decoded key material doesn't sit on
/// the heap after this call. Every decode failure (invalid character,
/// bad length, anything else) maps to `BadPassword` so an attacker
/// can't distinguish "you typed a letter outside the alphabet" from
/// "the code is wrong" via the response code — same threat model as
/// `unlock` itself.
fn decode_base32(s: &str) -> Result<Zeroizing<Vec<u8>>> {
    let mut buf: u32 = 0;
    let mut bits: u32 = 0;
    let mut out = Zeroizing::new(Vec::with_capacity(s.len() * 5 / 8));
    for ch in s.chars() {
        if ch == ' ' || ch == '-' || ch == '\t' || ch == '\n' || ch == '\r' {
            continue;
        }
        let upper = ch.to_ascii_uppercase();
        // Normalise common transcription substitutions: 0→O, 1→I, 8→B.
        // The alphabet has none of {0,1,8,9}; 9 has no good analogue
        // and falls through to the unified "BadPassword" rejection at
        // the position() call below.
        let upper = match upper {
            '0' => 'O',
            '1' => 'I',
            '8' => 'B',
            c => c,
        };
        let idx = B32_ALPHA.iter().position(|&c| c as char == upper)
            .ok_or(AppError::BadPassword)?;
        buf = (buf << 5) | (idx as u32);
        bits += 5;
        if bits >= 8 {
            bits -= 8;
            out.push(((buf >> bits) & 0xff) as u8);
        }
    }
    Ok(out)
}

/// Generate a new recovery code, wrap the supplied vault key under it,
/// and persist the wrap to `vault_meta`. Returns the human-readable
/// code (24 base32 chars, hyphen-grouped) — the only time the caller
/// gets to see it. Overwrites any existing recovery wrap; the caller
/// is responsible for taking a snapshot first if there was a prior
/// wrap to preserve.
pub async fn generate(
    pool: &SqlitePool,
    state: &VaultState,
) -> Result<String> {
    let VaultState::Unlocked { key } = state else {
        return Err(AppError::VaultLocked);
    };

    let mut code_bytes = Zeroizing::new([0u8; RECOVERY_CODE_BYTES]);
    SysRng.try_fill_bytes(&mut *code_bytes).map_err(|_| AppError::Crypto)?;
    let code = Zeroizing::new(encode_base32(&*code_bytes));

    let mut salt = [0u8; 16];
    SysRng.try_fill_bytes(&mut salt).map_err(|_| AppError::Crypto)?;
    let params = KdfParams::default();
    let recovery_key = kdf::derive_key(code.as_bytes(), &salt, params)?;
    let aead = Aead256::new(&recovery_key);
    let (nonce, ct) = aead.encrypt(&**key)?;
    let mut wrapped = Vec::with_capacity(nonce.len() + ct.len());
    wrapped.extend_from_slice(&nonce);
    wrapped.extend_from_slice(&ct);
    let params_json = serde_json::to_string(&StoredKdfParams::from(params))?;

    sqlx::query(
        "UPDATE vault_meta SET recovery_salt = ?, recovery_kdf_params = ?, \
         recovery_wrapped_key = ? WHERE id = 1",
    )
        .bind(&salt[..]).bind(params_json).bind(&wrapped)
        .execute(pool).await?;

    Ok(format_for_display(&code))
}

/// Same as `generate`, but takes a pre-change snapshot when an
/// existing recovery wrap is being overwritten. Used by the
/// command layer when the caller is the user explicitly regenerating
/// a recovery code (versus an automated path that's already
/// snapshotted, like the change-password tx). Returns the new code
/// and the snapshot path if one was written.
pub async fn generate_with_snapshot(
    pool: &SqlitePool,
    state: &VaultState,
) -> Result<(String, Option<std::path::PathBuf>)> {
    let snap = if is_provisioned(pool).await? {
        Some(snapshot::take(pool, "regenerate-recovery").await?)
    } else {
        None
    };
    let code = generate(pool, state).await?;
    Ok((code, snap))
}

/// Returns true if the vault has a recovery code provisioned.
pub async fn is_provisioned(pool: &SqlitePool) -> Result<bool> {
    let row: Option<(Option<Vec<u8>>,)> =
        sqlx::query_as("SELECT recovery_wrapped_key FROM vault_meta WHERE id = 1")
            .fetch_optional(pool).await?;
    Ok(matches!(row, Some((Some(_),))))
}

/// Try to unlock the vault using a recovery code. Returns the
/// unwrapped vault key (same key the master password would derive) on
/// success; **always** runs a full Argon2id derive — even when no
/// recovery code is provisioned — so an attacker can't distinguish
/// "vault has no recovery code" from "wrong code" by timing or by
/// error code (every failure surfaces as `BadPassword`).
///
/// On success the recovery wrap is consumed: the `recovery_*` columns
/// are cleared so the same code can't unlock the vault again. The
/// caller is responsible for forcing the user to set a new master
/// password (or regenerate a recovery code) before locking.
pub async fn unlock_with_code(pool: &SqlitePool, code: &str) -> Result<Zeroizing<[u8; 32]>> {
    let row: Option<(Option<Vec<u8>>, Option<String>, Option<Vec<u8>>, Vec<u8>)> = sqlx::query_as(
        "SELECT recovery_salt, recovery_kdf_params, recovery_wrapped_key, verifier \
         FROM vault_meta WHERE id = 1",
    )
        .fetch_optional(pool).await?;

    // Decode the user-supplied code (no separators, case-insensitive,
    // 0/1/8 substitutions tolerated). On any decode failure we still
    // want to pay roughly the same Argon2id cost as a "real" attempt
    // before returning, so timing doesn't leak whether the input was
    // even valid base32. Decode now, defer the Err until after KDF.
    let decoded = decode_base32(code);
    let decoded_ok = match &decoded {
        Ok(d) => d.len() == RECOVERY_CODE_BYTES,
        Err(_) => false,
    };

    // Pull provisioning state out of the row. If the vault has no
    // recovery code, we still derive against a dummy salt + the
    // configured wrap-shaped placeholder so the work runs.
    let (salt, params_json, wrapped, verifier, provisioned) = match row {
        Some((Some(s), Some(p), Some(w), v)) => (s, p, w, v, true),
        Some((_, _, _, v)) => {
            // Not provisioned. Use a dummy salt + the current default
            // KDF params + an empty wrap; the result will be discarded
            // and we'll return BadPassword regardless. v (verifier)
            // is still kept so the timing tail matches the provisioned
            // failure path's verifier-decrypt step.
            let dummy_salt = [0u8; 16];
            let dummy_params = serde_json::to_string(
                &StoredKdfParams::from(KdfParams::default())
            )?;
            (dummy_salt.to_vec(), dummy_params, vec![0u8; NONCE_LEN + 32], v, false)
        }
        None => return Err(AppError::NotFound),
    };

    let stored: StoredKdfParams = serde_json::from_str(&params_json)?;
    let params: KdfParams = stored.into();
    // Run the KDF against the (decoded || dummy) input regardless of
    // whether decode succeeded — constant-time-ish: we always pay one
    // Argon2id run before deciding to fail.
    let kdf_input: Zeroizing<Vec<u8>> = match decoded {
        Ok(ref d) if decoded_ok => {
            // Re-encode to canonical form so transcription tolerances
            // (lowercase, separators, 0/1/8) hash identically.
            Zeroizing::new(encode_base32(d).into_bytes())
        }
        _ => Zeroizing::new(vec![0u8; 24]),
    };
    let recovery_key = kdf::derive_key(&kdf_input, &salt, params)?;

    if !provisioned || !decoded_ok || wrapped.len() < NONCE_LEN {
        return Err(AppError::BadPassword);
    }
    let (nonce, ct) = wrapped.split_at(NONCE_LEN);
    let aead = Aead256::new(&recovery_key);
    let vault_key_bytes = match aead.decrypt(nonce, ct) {
        Ok(v) => v,
        Err(_) => return Err(AppError::BadPassword),
    };
    if vault_key_bytes.len() != 32 { return Err(AppError::BadPassword); }
    let mut key_arr = Zeroizing::new([0u8; 32]);
    key_arr.copy_from_slice(&vault_key_bytes);

    if verifier.len() < NONCE_LEN { return Err(AppError::BadPassword); }
    let (vnonce, vct) = verifier.split_at(NONCE_LEN);
    let pt = Aead256::new(&key_arr).decrypt(vnonce, vct)
        .map_err(|_| AppError::BadPassword)?;
    if pt != VERIFIER_PLAINTEXT { return Err(AppError::BadPassword); }

    // Consume the recovery wrap. Once unlocked via recovery, the
    // same code MUST NOT unlock again — that's the difference between
    // "single-use escape hatch" (what the UI promises) and
    // "permanent secondary password" (what an attacker with a leaked
    // code would exploit). The caller is expected to push the user
    // through "set new master password" immediately after.
    sqlx::query(
        "UPDATE vault_meta SET recovery_salt = NULL, recovery_kdf_params = NULL, \
         recovery_wrapped_key = NULL WHERE id = 1",
    ).execute(pool).await?;

    Ok(key_arr)
}

/// Insert a hyphen every 4 characters so the user can read the code
/// back without losing their place. The decoder strips these out, so
/// formatting is purely cosmetic.
fn format_for_display(code: &str) -> String {
    let mut out = String::with_capacity(code.len() + code.len() / 4);
    for (i, ch) in code.chars().enumerate() {
        if i > 0 && i % 4 == 0 {
            out.push('-');
        }
        out.push(ch);
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn base32_roundtrip() {
        let bytes = [0xde, 0xad, 0xbe, 0xef, 0x01, 0x23, 0x45, 0x67, 0x89, 0xab,
                     0xcd, 0xef, 0x11, 0x22, 0x33];
        let s = encode_base32(&bytes);
        assert_eq!(s.len(), 24);
        let decoded = decode_base32(&s).unwrap();
        assert_eq!(&*decoded, &bytes);
    }

    #[test]
    fn base32_decoder_accepts_separators_and_case() {
        let bytes = [1u8; 15];
        let s = encode_base32(&bytes);
        let formatted = format_for_display(&s).to_ascii_lowercase();
        let decoded = decode_base32(&formatted).unwrap();
        assert_eq!(&*decoded, &bytes);
    }

    #[test]
    fn base32_substitutes_zero_one_eight() {
        let bytes = [0xff; 15];
        let s = encode_base32(&bytes);
        let mangled: String = s.chars()
            .map(|c| match c { 'O' => '0', 'I' => '1', 'B' => '8', c => c })
            .collect();
        let decoded = decode_base32(&mangled).unwrap();
        assert_eq!(&*decoded, &bytes);
    }

    #[test]
    fn base32_rejects_invalid_chars_as_bad_password() {
        // M10: all decode failures look the same as "wrong code" to
        // the caller, so an attacker can't tell whether the input
        // even decoded.
        let err = decode_base32("ABC!").err().unwrap();
        assert!(matches!(err, AppError::BadPassword));
    }
}
