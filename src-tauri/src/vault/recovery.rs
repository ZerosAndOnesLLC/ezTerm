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

use rand::{rngs::SysRng, TryRng};
use sqlx::SqlitePool;
use zeroize::Zeroizing;

use crate::error::{AppError, Result};
use super::{
    aead::{Aead256, NONCE_LEN},
    kdf::{self, KdfParams},
    StoredKdfParams, VaultState, VERIFIER_PLAINTEXT,
};

const RECOVERY_CODE_BYTES: usize = 15; // 120 bits — encodes to exactly 24 base32 chars (no padding)

/// RFC 4648 base32 alphabet (uppercase, no padding). 24 chars × 5 bits = 120 bits.
const B32_ALPHA: &[u8; 32] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

fn encode_base32(bytes: &[u8]) -> String {
    // Encode in 5-byte (40-bit) chunks → 8 chars. RECOVERY_CODE_BYTES = 15
    // gives three chunks → 24 chars exactly, no padding required.
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

fn decode_base32(s: &str) -> Result<Vec<u8>> {
    // Accept lowercase, ignore separators (spaces, dashes) so a user
    // who reads the code back from a printout doesn't get a mismatch
    // over formatting. Reject any character outside the alphabet.
    let mut buf: u32 = 0;
    let mut bits: u32 = 0;
    let mut out = Vec::with_capacity(s.len() * 5 / 8);
    for ch in s.chars() {
        if ch == ' ' || ch == '-' || ch == '\t' || ch == '\n' || ch == '\r' {
            continue;
        }
        let upper = ch.to_ascii_uppercase();
        // Normalise common transcription substitutions: 0→O, 1→I, 8→B.
        // The alphabet has none of {0,1,8,9}; map them to the closest
        // visual match. The 9 has no good analogue so we reject it.
        let upper = match upper {
            '0' => 'O',
            '1' => 'I',
            '8' => 'B',
            c => c,
        };
        let idx = B32_ALPHA.iter().position(|&c| c as char == upper)
            .ok_or_else(|| AppError::Validation(format!("invalid recovery code character: {ch}")))?;
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
/// code (24 base32 chars, space-grouped) — the only time the caller
/// gets to see it. Overwrites any existing recovery wrap.
pub async fn generate(
    pool: &SqlitePool,
    state: &VaultState,
) -> Result<String> {
    let VaultState::Unlocked { key } = state else {
        return Err(AppError::VaultLocked);
    };

    let mut code_bytes = [0u8; RECOVERY_CODE_BYTES];
    SysRng.try_fill_bytes(&mut code_bytes).map_err(|_| AppError::Crypto)?;
    let code = encode_base32(&code_bytes);

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

/// Returns true if the vault has a recovery code provisioned.
pub async fn is_provisioned(pool: &SqlitePool) -> Result<bool> {
    let row: Option<(Option<Vec<u8>>,)> =
        sqlx::query_as("SELECT recovery_wrapped_key FROM vault_meta WHERE id = 1")
            .fetch_optional(pool).await?;
    Ok(matches!(row, Some((Some(_),))))
}

/// Try to unlock the vault using a recovery code. Returns the unwrapped
/// vault key (same key the master password would derive) on success;
/// `BadPassword` if the code doesn't decrypt the wrap.
pub async fn unlock_with_code(pool: &SqlitePool, code: &str) -> Result<Zeroizing<[u8; 32]>> {
    let row: Option<(Option<Vec<u8>>, Option<String>, Option<Vec<u8>>, Vec<u8>)> = sqlx::query_as(
        "SELECT recovery_salt, recovery_kdf_params, recovery_wrapped_key, verifier \
         FROM vault_meta WHERE id = 1",
    )
        .fetch_optional(pool).await?;
    let (Some(salt), Some(params_json), Some(wrapped), verifier) =
        row.ok_or(AppError::NotFound)?
    else {
        return Err(AppError::NotFound);
    };

    // Decode the user-supplied code. Reject anything that doesn't decode
    // to the expected byte length so length mismatches surface as
    // BadPassword, not a downstream KDF surprise.
    let decoded = decode_base32(code)?;
    if decoded.len() != RECOVERY_CODE_BYTES {
        return Err(AppError::BadPassword);
    }
    let normalised = encode_base32(&decoded);

    let stored: StoredKdfParams = serde_json::from_str(&params_json)?;
    let params: KdfParams = stored.into();
    let recovery_key = kdf::derive_key(normalised.as_bytes(), &salt, params)?;
    if wrapped.len() < NONCE_LEN { return Err(AppError::Crypto); }
    let (nonce, ct) = wrapped.split_at(NONCE_LEN);
    let aead = Aead256::new(&recovery_key);
    let vault_key_bytes = aead.decrypt(nonce, ct).map_err(|_| AppError::BadPassword)?;
    if vault_key_bytes.len() != 32 { return Err(AppError::Crypto); }
    let mut key_arr = Zeroizing::new([0u8; 32]);
    key_arr.copy_from_slice(&vault_key_bytes);

    // Sanity-check: the recovered key should decrypt the verifier. This
    // protects against a stale recovery wrap (e.g. someone edited
    // recovery_wrapped_key out of band) silently returning a wrong key.
    if verifier.len() < NONCE_LEN { return Err(AppError::Crypto); }
    let (vnonce, vct) = verifier.split_at(NONCE_LEN);
    let pt = Aead256::new(&key_arr).decrypt(vnonce, vct).map_err(|_| AppError::BadPassword)?;
    if pt != VERIFIER_PLAINTEXT { return Err(AppError::BadPassword); }

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
        assert_eq!(decoded, bytes);
    }

    #[test]
    fn base32_decoder_accepts_separators_and_case() {
        let bytes = [1u8; 15];
        let s = encode_base32(&bytes);
        let formatted = format_for_display(&s).to_ascii_lowercase();
        let decoded = decode_base32(&formatted).unwrap();
        assert_eq!(decoded, bytes);
    }

    #[test]
    fn base32_substitutes_zero_one_eight() {
        let bytes = [0xff; 15];
        let s = encode_base32(&bytes);
        // Force a transcription error: lowercase, with 0/1/8 typed
        // instead of O/I/B (which appear in many random codes).
        let mangled: String = s.chars()
            .map(|c| match c { 'O' => '0', 'I' => '1', 'B' => '8', c => c })
            .collect();
        let decoded = decode_base32(&mangled).unwrap();
        assert_eq!(decoded, bytes);
    }

    #[test]
    fn base32_rejects_invalid_chars() {
        assert!(decode_base32("ABC!").is_err());
    }
}
