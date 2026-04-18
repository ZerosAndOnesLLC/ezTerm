use argon2::{Algorithm, Argon2, Params, Version};
use serde::{Deserialize, Serialize};
use zeroize::Zeroizing;

#[derive(Clone, Copy, Debug, Serialize, Deserialize, PartialEq, Eq)]
pub struct KdfParams {
    pub m_cost_kib: u32,
    pub t_cost: u32,
    pub p_cost: u32,
}

impl Default for KdfParams {
    fn default() -> Self {
        Self { m_cost_kib: 64 * 1024, t_cost: 3, p_cost: 1 }
    }
}

pub fn derive_key(
    password: &[u8],
    salt: &[u8],
    params: KdfParams,
) -> crate::error::Result<Zeroizing<[u8; 32]>> {
    let mut out = Zeroizing::new([0u8; 32]);
    let p = Params::new(params.m_cost_kib, params.t_cost, params.p_cost, Some(32))
        .map_err(|_| crate::error::AppError::Crypto)?;
    let a2 = Argon2::new(Algorithm::Argon2id, Version::V0x13, p);
    a2.hash_password_into(password, salt, &mut *out)
        .map_err(|_| crate::error::AppError::Crypto)?;
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn derive_is_deterministic_for_same_inputs() {
        let salt = [7u8; 16];
        let p = KdfParams { m_cost_kib: 8 * 1024, t_cost: 1, p_cost: 1 }; // fast for tests
        let a = derive_key(b"correct horse", &salt, p).unwrap();
        let b = derive_key(b"correct horse", &salt, p).unwrap();
        assert_eq!(*a, *b);
    }

    #[test]
    fn derive_differs_with_different_password() {
        let salt = [7u8; 16];
        let p = KdfParams { m_cost_kib: 8 * 1024, t_cost: 1, p_cost: 1 };
        let a = derive_key(b"aaa", &salt, p).unwrap();
        let b = derive_key(b"bbb", &salt, p).unwrap();
        assert_ne!(*a, *b);
    }
}
