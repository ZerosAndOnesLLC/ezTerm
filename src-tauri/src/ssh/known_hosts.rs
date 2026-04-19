use base64::Engine;
use sha2::{Digest, Sha256};

/// Result of comparing a server-presented host key against the known_hosts table.
#[derive(Debug, PartialEq, Eq)]
pub enum KeyCheck {
    /// No entry for (host, port) yet — caller must prompt user for TOFU.
    Untrusted,
    /// Entry exists and matches — proceed.
    Matches,
    /// Entry exists but fingerprint differs — hard fail with expected/actual.
    Mismatch {
        expected_sha256: String,
        actual_sha256: String,
    },
}

/// Compute the OpenSSH-style SHA-256 fingerprint (base64, no padding).
pub fn fingerprint_sha256(public_key_blob: &[u8]) -> String {
    let mut h = Sha256::new();
    h.update(public_key_blob);
    base64::engine::general_purpose::STANDARD_NO_PAD.encode(h.finalize())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn fingerprint_is_deterministic() {
        let a = fingerprint_sha256(b"some-public-key-blob");
        let b = fingerprint_sha256(b"some-public-key-blob");
        assert_eq!(a, b);
    }

    #[test]
    fn fingerprint_differs_per_blob() {
        let a = fingerprint_sha256(b"blob-a");
        let b = fingerprint_sha256(b"blob-b");
        assert_ne!(a, b);
    }

    #[test]
    fn fingerprint_is_unpadded_base64() {
        let fp = fingerprint_sha256(b"x");
        assert!(!fp.ends_with('='));
    }
}
