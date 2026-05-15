use super::*;
use sqlx::sqlite::SqlitePoolOptions;

async fn mem_pool() -> SqlitePool {
    let pool = SqlitePoolOptions::new()
        .max_connections(1)
        .connect("sqlite::memory:").await.unwrap();
    crate::db::init_pool_from_pool(&pool).await.unwrap();
    pool
}

#[tokio::test]
async fn init_then_unlock_roundtrip() {
    let pool = mem_pool().await;
    let _ = init(&pool, "hunter2").await.unwrap();
    let st = unlock(&pool, "hunter2").await.unwrap();
    assert!(st.is_unlocked());
}

#[tokio::test]
async fn wrong_password_rejected() {
    let pool = mem_pool().await;
    let _ = init(&pool, "right").await.unwrap();
    let err = unlock(&pool, "wrong").await.err().unwrap();
    assert!(matches!(err, AppError::BadPassword));
}

#[tokio::test]
async fn double_init_rejected() {
    let pool = mem_pool().await;
    let _ = init(&pool, "a").await.unwrap();
    let err = init(&pool, "a").await.err().unwrap();
    assert!(matches!(err, AppError::VaultAlreadyInitialized));
}

#[tokio::test]
async fn change_password_re_encrypts_credentials() {
    let pool = mem_pool().await;
    let st = init(&pool, "first-password").await.unwrap();

    // Stash a credential under the first key. We round-trip through
    // the AEAD so the row looks exactly like what `credential_create`
    // would write.
    let (nonce, ct) = encrypt_with(&st, b"hunter2-secret").unwrap();
    sqlx::query("INSERT INTO credentials (kind, label, nonce, ciphertext) VALUES (?, ?, ?, ?)")
        .bind("password").bind("prod-db").bind(&nonce).bind(&ct)
        .execute(&pool).await.unwrap();

    // Wrong old password is rejected without touching anything.
    let err = change_password(&pool, "not-the-password", "new-password").await.err().unwrap();
    assert!(matches!(err, AppError::BadPassword));

    // Change works with the right old password.
    let _new_key = change_password(&pool, "first-password", "new-password").await.unwrap();

    // Old password no longer unlocks.
    assert!(matches!(
        unlock(&pool, "first-password").await,
        Err(AppError::BadPassword)
    ));

    // New password unlocks, and credentials decrypt under the new key.
    let st2 = unlock(&pool, "new-password").await.unwrap();
    let (n2, c2): (Vec<u8>, Vec<u8>) =
        sqlx::query_as("SELECT nonce, ciphertext FROM credentials WHERE label = ?")
            .bind("prod-db").fetch_one(&pool).await.unwrap();
    let pt = decrypt_with(&st2, &n2, &c2).unwrap();
    assert_eq!(pt, b"hunter2-secret");
}

#[tokio::test]
async fn change_password_re_encrypts_sync_blobs() {
    let pool = mem_pool().await;
    let st = init(&pool, "first").await.unwrap();

    // Drop a sync blob in app_settings using the same format
    // sync::encrypt_stored_blob produces — base64(nonce || ct).
    use base64::{engine::general_purpose::STANDARD as B64, Engine};
    let (nonce, ct) = encrypt_with(&st, b"s3-passphrase-original").unwrap();
    let mut combined = Vec::with_capacity(nonce.len() + ct.len());
    combined.extend_from_slice(&nonce);
    combined.extend_from_slice(&ct);
    let blob = B64.encode(&combined);
    sqlx::query("INSERT INTO app_settings (key, value) VALUES (?, ?)")
        .bind("sync.s3.passphrase_blob").bind(&blob)
        .execute(&pool).await.unwrap();

    change_password(&pool, "first", "second").await.unwrap();
    let st2 = unlock(&pool, "second").await.unwrap();

    let new_blob: String = sqlx::query_scalar("SELECT value FROM app_settings WHERE key = ?")
        .bind("sync.s3.passphrase_blob").fetch_one(&pool).await.unwrap();
    let bytes = B64.decode(&new_blob).unwrap();
    let (n2, c2) = bytes.split_at(crate::vault::aead::NONCE_LEN);
    let pt = decrypt_with(&st2, n2, c2).unwrap();
    assert_eq!(pt, b"s3-passphrase-original");
}

#[tokio::test]
async fn reset_wipes_vault_meta_and_credentials() {
    let pool = mem_pool().await;
    let st = init(&pool, "pw").await.unwrap();
    let (n, c) = encrypt_with(&st, b"x").unwrap();
    sqlx::query("INSERT INTO credentials (kind, label, nonce, ciphertext) VALUES (?, ?, ?, ?)")
        .bind("password").bind("x").bind(&n).bind(&c)
        .execute(&pool).await.unwrap();

    reset(&pool).await.unwrap();

    assert!(!is_initialized(&pool).await.unwrap());
    let count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM credentials")
        .fetch_one(&pool).await.unwrap();
    assert_eq!(count, 0);
}

#[tokio::test]
async fn recovery_code_unlocks_vault() {
    let pool = mem_pool().await;
    let st = init(&pool, "the-password").await.unwrap();
    let code = recovery::generate(&pool, &st).await.unwrap();
    // Lock the vault, then unlock via recovery code.
    let key = recovery::unlock_with_code(&pool, &code).await.unwrap();

    // The recovered key should decrypt anything the original key
    // could — encrypt with original, decrypt with recovered.
    let unlocked = VaultState::Unlocked { key };
    let (n, c) = encrypt_with(&st, b"smuggled").unwrap();
    let pt = decrypt_with(&unlocked, &n, &c).unwrap();
    assert_eq!(pt, b"smuggled");
}

#[tokio::test]
async fn recovery_code_invalidated_by_password_change() {
    let pool = mem_pool().await;
    let st = init(&pool, "old").await.unwrap();
    let code = recovery::generate(&pool, &st).await.unwrap();
    assert!(recovery::is_provisioned(&pool).await.unwrap());
    change_password(&pool, "old", "new").await.unwrap();
    assert!(!recovery::is_provisioned(&pool).await.unwrap());
    // Old recovery code should no longer unlock.
    let err = recovery::unlock_with_code(&pool, &code).await.err().unwrap();
    assert!(matches!(err, AppError::NotFound | AppError::BadPassword));
}

#[tokio::test]
async fn recovery_code_rejects_bad_code() {
    let pool = mem_pool().await;
    let st = init(&pool, "pw").await.unwrap();
    let _ = recovery::generate(&pool, &st).await.unwrap();
    let err = recovery::unlock_with_code(&pool, "AAAA-AAAA-AAAA-AAAA-AAAA-AAAA")
        .await.err().unwrap();
    assert!(matches!(err, AppError::BadPassword));
}
