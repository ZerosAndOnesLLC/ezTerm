use chacha20poly1305::{aead::{Aead, KeyInit}, ChaCha20Poly1305, Key, Nonce};
use rand::{rngs::OsRng, RngCore};
use zeroize::Zeroizing;

use crate::error::{AppError, Result};

pub const NONCE_LEN: usize = 12;

pub struct Aead256(Zeroizing<[u8; 32]>);

impl Aead256 {
    pub fn new(key: &[u8; 32]) -> Self { Self(Zeroizing::new(*key)) }

    pub fn encrypt(&self, plaintext: &[u8]) -> Result<(Vec<u8>, Vec<u8>)> {
        let cipher = ChaCha20Poly1305::new(Key::from_slice(&*self.0));
        let mut nonce_bytes = [0u8; NONCE_LEN];
        OsRng.fill_bytes(&mut nonce_bytes);
        let nonce = Nonce::from_slice(&nonce_bytes);
        let ct = cipher.encrypt(nonce, plaintext).map_err(|_| AppError::Crypto)?;
        Ok((nonce_bytes.to_vec(), ct))
    }

    pub fn decrypt(&self, nonce: &[u8], ciphertext: &[u8]) -> Result<Vec<u8>> {
        if nonce.len() != NONCE_LEN { return Err(AppError::Crypto); }
        let cipher = ChaCha20Poly1305::new(Key::from_slice(&*self.0));
        let nonce = Nonce::from_slice(nonce);
        cipher.decrypt(nonce, ciphertext).map_err(|_| AppError::Crypto)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn roundtrip() {
        let key = [9u8; 32];
        let a = Aead256::new(&key);
        let (nonce, ct) = a.encrypt(b"hello secret").unwrap();
        let pt = a.decrypt(&nonce, &ct).unwrap();
        assert_eq!(pt, b"hello secret");
    }

    #[test]
    fn wrong_key_fails() {
        let a = Aead256::new(&[1u8; 32]);
        let b = Aead256::new(&[2u8; 32]);
        let (nonce, ct) = a.encrypt(b"data").unwrap();
        assert!(b.decrypt(&nonce, &ct).is_err());
    }

    #[test]
    fn tamper_fails() {
        let a = Aead256::new(&[3u8; 32]);
        let (nonce, mut ct) = a.encrypt(b"data").unwrap();
        ct[0] ^= 0x01;
        assert!(a.decrypt(&nonce, &ct).is_err());
    }
}
