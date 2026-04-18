// Real implementation arrives in Task 5; placeholder keeps state.rs compiling.
pub enum VaultState {
    Uninitialized,
    Locked,
    Unlocked { key: zeroize::Zeroizing<[u8; 32]> },
}
