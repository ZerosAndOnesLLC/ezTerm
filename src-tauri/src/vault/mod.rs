pub mod kdf;

pub enum VaultState {
    Uninitialized,
    Locked,
    Unlocked { key: zeroize::Zeroizing<[u8; 32]> },
}
