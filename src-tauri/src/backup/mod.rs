//! Encrypted backup / restore.
//!
//! On export:
//!   1. Caller re-authenticates with the master password (reauth gate in the
//!      command layer) — this blocks "unlocked laptop walkup" exfiltration.
//!   2. Every credential is decrypted in-memory with the current vault key.
//!   3. All user data is serialised into `Bundle` (JSON).
//!   4. A *separate* key is derived from a user-supplied backup passphrase
//!      via Argon2id (fresh salt), the bundle is encrypted with
//!      ChaCha20-Poly1305, and the result is wrapped in a `BackupEnvelope`
//!      JSON document written to disk.
//!
//! On import:
//!   1. Envelope is parsed; KDF params + salt are re-read from the file.
//!   2. Backup passphrase derives the wrapping key and decrypts the bundle.
//!   3. Caller picks what to import; selected credentials are re-encrypted
//!      with the *target* vault key so they round-trip into the local
//!      vault. ID remapping happens in the command layer.
//!
//! The backup file never contains plaintext credentials on disk — credentials
//! live decrypted only in memory between unwrapping the bundle and re-encrypting
//! them under the target vault. The envelope schema is versioned for forward
//! compatibility; `BACKUP_VERSION` bumps on any breaking change.

use base64::{engine::general_purpose::STANDARD as B64, Engine};
use rand::{rngs::SysRng, TryRng};
use serde::{Deserialize, Serialize};
use zeroize::Zeroizing;

use crate::db::folders::Folder;
use crate::db::known_hosts::KnownHost;
use crate::db::sessions::{EnvPair, Session};
use crate::error::{AppError, Result};
use crate::vault::aead::Aead256;
use crate::vault::kdf::{self, KdfParams};

pub const MAGIC: &str = "ezterm-backup";
pub const BACKUP_VERSION: u16 = 1;

/// Minimum bytes for the user's backup passphrase. Same 8-char floor
/// the master password enforces — parity keeps one UX rule.
pub const MIN_PASSPHRASE_LEN: usize = 8;

/// Everything worth round-tripping. Credential secrets are *decrypted*
/// inside this structure — it only exists in memory and inside the
/// passphrase-encrypted envelope.
#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct Bundle {
    pub version:      u16,
    pub created_at:   String,
    pub app_version:  String,
    pub folders:      Vec<Folder>,
    pub sessions:     Vec<SessionEntry>,
    pub credentials:  Vec<CredentialEntry>,
    pub known_hosts:  Vec<KnownHost>,
    pub settings:     Vec<SettingEntry>,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct SessionEntry {
    #[serde(flatten)]
    pub session: Session,
    #[serde(default)]
    pub env: Vec<EnvPair>,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct CredentialEntry {
    pub id:        i64,
    pub kind:      String,
    pub label:     String,
    /// Plaintext secret, base64. Bytes-only, since private keys have
    /// line endings and whitespace that matter, and passwords may be UTF-8.
    pub secret_b64: String,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct SettingEntry {
    pub key:   String,
    pub value: String,
}

/// Envelope written to disk. The `ciphertext_b64` unwraps (via the
/// passphrase-derived key) to a JSON-encoded `Bundle`.
#[derive(Serialize, Deserialize)]
pub struct BackupEnvelope {
    pub magic:          String,
    pub version:        u16,
    pub kdf:            KdfParams,
    pub salt_b64:       String,
    pub nonce_b64:      String,
    pub ciphertext_b64: String,
}

/// Encrypt a bundle under a passphrase-derived key and produce the JSON
/// envelope bytes ready to write to disk.
pub fn encrypt_bundle(bundle: &Bundle, passphrase: &str) -> Result<Vec<u8>> {
    if passphrase.len() < MIN_PASSPHRASE_LEN {
        return Err(AppError::Validation(format!(
            "backup passphrase must be at least {MIN_PASSPHRASE_LEN} chars"
        )));
    }

    let mut salt = [0u8; 16];
    SysRng
        .try_fill_bytes(&mut salt)
        .map_err(|_| AppError::Crypto)?;
    let params = KdfParams::default();
    let key: Zeroizing<[u8; 32]> = kdf::derive_key(passphrase.as_bytes(), &salt, params)?;
    let aead = Aead256::new(&key);

    let plaintext = serde_json::to_vec(bundle)?;
    let (nonce, ciphertext) = aead.encrypt(&plaintext)?;

    let env = BackupEnvelope {
        magic:          MAGIC.to_string(),
        version:        BACKUP_VERSION,
        kdf:            params,
        salt_b64:       B64.encode(salt),
        nonce_b64:      B64.encode(&nonce),
        ciphertext_b64: B64.encode(&ciphertext),
    };
    Ok(serde_json::to_vec_pretty(&env)?)
}

/// Inverse of `encrypt_bundle`. Returns a sharp error if the magic /
/// version check fails, and the generic `BadPassword` if decryption
/// fails (wrong passphrase or tampered bytes).
pub fn decrypt_bundle(bytes: &[u8], passphrase: &str) -> Result<Bundle> {
    let env: BackupEnvelope = serde_json::from_slice(bytes)
        .map_err(|_| AppError::Validation("not an ezTerm backup file".into()))?;
    if env.magic != MAGIC {
        return Err(AppError::Validation("wrong backup file magic".into()));
    }
    if env.version > BACKUP_VERSION {
        return Err(AppError::Validation(format!(
            "backup version {} is newer than this build supports ({})",
            env.version, BACKUP_VERSION
        )));
    }

    let salt = B64
        .decode(&env.salt_b64)
        .map_err(|_| AppError::Validation("bad salt encoding".into()))?;
    let nonce = B64
        .decode(&env.nonce_b64)
        .map_err(|_| AppError::Validation("bad nonce encoding".into()))?;
    let ciphertext = B64
        .decode(&env.ciphertext_b64)
        .map_err(|_| AppError::Validation("bad ciphertext encoding".into()))?;

    let key: Zeroizing<[u8; 32]> = kdf::derive_key(passphrase.as_bytes(), &salt, env.kdf)?;
    let aead = Aead256::new(&key);
    let plaintext = aead.decrypt(&nonce, &ciphertext).map_err(|_| AppError::BadPassword)?;
    let bundle: Bundle = serde_json::from_slice(&plaintext)
        .map_err(|_| AppError::Validation("backup contents are not valid JSON".into()))?;
    Ok(bundle)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sample_bundle() -> Bundle {
        Bundle {
            version:     BACKUP_VERSION,
            created_at:  "2026-01-01T00:00:00Z".into(),
            app_version: "test".into(),
            folders:     Vec::new(),
            sessions:    Vec::new(),
            credentials: vec![CredentialEntry {
                id: 1,
                kind: "password".into(),
                label: "prod-db".into(),
                secret_b64: B64.encode(b"sup3rsecret"),
            }],
            known_hosts: Vec::new(),
            settings:    Vec::new(),
        }
    }

    #[test]
    fn roundtrip_encrypt_decrypt() {
        let b = sample_bundle();
        let bytes = encrypt_bundle(&b, "correct horse battery").unwrap();
        let back = decrypt_bundle(&bytes, "correct horse battery").unwrap();
        assert_eq!(back.credentials.len(), 1);
        assert_eq!(back.credentials[0].label, "prod-db");
    }

    #[test]
    fn wrong_passphrase_is_bad_password() {
        let b = sample_bundle();
        let bytes = encrypt_bundle(&b, "correct horse battery").unwrap();
        let err = decrypt_bundle(&bytes, "wrong pass").unwrap_err();
        assert!(matches!(err, AppError::BadPassword));
    }

    #[test]
    fn short_passphrase_rejected() {
        let b = sample_bundle();
        let err = encrypt_bundle(&b, "short").unwrap_err();
        assert!(matches!(err, AppError::Validation(_)));
    }

    #[test]
    fn garbage_file_errors_validation() {
        let err = decrypt_bundle(b"{}", "whatever").unwrap_err();
        // Missing required fields → JSON parse fails at serde level.
        assert!(matches!(err, AppError::Validation(_)));
    }

    #[test]
    fn tampered_ciphertext_fails() {
        let b = sample_bundle();
        let bytes = encrypt_bundle(&b, "passphrase123").unwrap();
        // Flip a byte in the ciphertext_b64 field. The base64 still
        // decodes but the AEAD auth tag rejects it.
        let mut env: BackupEnvelope = serde_json::from_slice(&bytes).unwrap();
        let mut ct = B64.decode(&env.ciphertext_b64).unwrap();
        ct[0] ^= 0x01;
        env.ciphertext_b64 = B64.encode(&ct);
        let tampered = serde_json::to_vec(&env).unwrap();
        let err = decrypt_bundle(&tampered, "passphrase123").unwrap_err();
        assert!(matches!(err, AppError::BadPassword));
    }
}
