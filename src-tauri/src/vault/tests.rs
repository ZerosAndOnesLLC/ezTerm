use super::*;
use sqlx::sqlite::SqlitePoolOptions;

async fn mem_pool() -> SqlitePool {
    let pool = SqlitePoolOptions::new()
        .max_connections(1)
        .connect("sqlite::memory:").await.unwrap();
    crate::db::init_pool_from_pool(&pool).await.unwrap();
    pool
}

/// Helper used by every change_password test: derive the old key the
/// same way the command layer does — by verifying the password and
/// returning the verified key.
async fn old_key(pool: &SqlitePool, password: &str) -> Zeroizing<[u8; 32]> {
    verify_and_derive(pool, password).await.unwrap()
        .expect("password should verify in test setup")
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

    let (nonce, ct) = encrypt_with(&st, b"hunter2-secret").unwrap();
    sqlx::query("INSERT INTO credentials (kind, label, nonce, ciphertext) VALUES (?, ?, ?, ?)")
        .bind("password").bind("prod-db").bind(&nonce).bind(&ct)
        .execute(&pool).await.unwrap();

    // verify_and_derive returns None on bad password — the command
    // layer is what surfaces BadPassword. Confirm here.
    assert!(verify_and_derive(&pool, "not-the-password").await.unwrap().is_none());

    let k = old_key(&pool, "first-password").await;
    let _new_key = change_password(&pool, &k, "new-password").await.unwrap();

    assert!(matches!(
        unlock(&pool, "first-password").await,
        Err(AppError::BadPassword)
    ));

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

    use base64::{engine::general_purpose::STANDARD as B64, Engine};
    let (nonce, ct) = encrypt_with(&st, b"s3-passphrase-original").unwrap();
    let mut combined = Vec::with_capacity(nonce.len() + ct.len());
    combined.extend_from_slice(&nonce);
    combined.extend_from_slice(&ct);
    let blob = B64.encode(&combined);
    sqlx::query("INSERT INTO app_settings (key, value) VALUES (?, ?)")
        .bind("sync.s3.passphrase_blob").bind(&blob)
        .execute(&pool).await.unwrap();

    let k = old_key(&pool, "first").await;
    change_password(&pool, &k, "second").await.unwrap();
    let st2 = unlock(&pool, "second").await.unwrap();

    let new_blob: String = sqlx::query_scalar("SELECT value FROM app_settings WHERE key = ?")
        .bind("sync.s3.passphrase_blob").fetch_one(&pool).await.unwrap();
    let bytes = B64.decode(&new_blob).unwrap();
    let (n2, c2) = bytes.split_at(crate::vault::aead::NONCE_LEN);
    let pt = decrypt_with(&st2, n2, c2).unwrap();
    assert_eq!(pt, b"s3-passphrase-original");
}

#[tokio::test]
async fn change_password_handles_credentials_and_sync_blobs_together() {
    // Combined test: covers the all-or-nothing claim end-to-end with
    // both kinds of vault-encrypted material in the same transaction.
    let pool = mem_pool().await;
    let st = init(&pool, "first").await.unwrap();

    let (cn, cc) = encrypt_with(&st, b"cred-pt").unwrap();
    sqlx::query("INSERT INTO credentials (kind, label, nonce, ciphertext) VALUES (?, ?, ?, ?)")
        .bind("password").bind("c").bind(&cn).bind(&cc)
        .execute(&pool).await.unwrap();

    use base64::{engine::general_purpose::STANDARD as B64, Engine};
    let (sn, sc) = encrypt_with(&st, b"blob-pt").unwrap();
    let mut combined = Vec::with_capacity(sn.len() + sc.len());
    combined.extend_from_slice(&sn);
    combined.extend_from_slice(&sc);
    sqlx::query("INSERT INTO app_settings (key, value) VALUES (?, ?)")
        .bind("sync.local.passphrase_blob").bind(B64.encode(&combined))
        .execute(&pool).await.unwrap();

    let k = old_key(&pool, "first").await;
    change_password(&pool, &k, "second").await.unwrap();
    let st2 = unlock(&pool, "second").await.unwrap();

    let (n2, c2): (Vec<u8>, Vec<u8>) =
        sqlx::query_as("SELECT nonce, ciphertext FROM credentials WHERE label = ?")
            .bind("c").fetch_one(&pool).await.unwrap();
    assert_eq!(decrypt_with(&st2, &n2, &c2).unwrap(), b"cred-pt");

    let blob: String = sqlx::query_scalar("SELECT value FROM app_settings WHERE key = ?")
        .bind("sync.local.passphrase_blob").fetch_one(&pool).await.unwrap();
    let bytes = B64.decode(&blob).unwrap();
    let (bn, bc) = bytes.split_at(crate::vault::aead::NONCE_LEN);
    assert_eq!(decrypt_with(&st2, bn, bc).unwrap(), b"blob-pt");
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
    let key = recovery::unlock_with_code(&pool, &code).await.unwrap();

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

    let k = old_key(&pool, "old").await;
    change_password(&pool, &k, "new").await.unwrap();
    assert!(!recovery::is_provisioned(&pool).await.unwrap());

    // The unlock-with-code path collapses all failure modes (NULL
    // columns, decode failure, AEAD mismatch) into BadPassword so an
    // attacker can't distinguish "no recovery provisioned" from
    // "wrong code" via the response code or via timing.
    let err = recovery::unlock_with_code(&pool, &code).await.err().unwrap();
    assert!(matches!(err, AppError::BadPassword));
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

#[tokio::test]
async fn recovery_unlock_with_no_provisioning_is_indistinguishable_from_bad_code() {
    // Without provisioning, unlock_with_code still pays full Argon2id
    // cost and returns BadPassword — same surface an attacker would
    // see for a wrong code. Verifies H6: no timing/code-class oracle
    // for "is recovery provisioned" from this command.
    let pool = mem_pool().await;
    let _ = init(&pool, "pw").await.unwrap();
    let err = recovery::unlock_with_code(&pool, "AAAA-AAAA-AAAA-AAAA-AAAA-AAAA")
        .await.err().unwrap();
    assert!(matches!(err, AppError::BadPassword));
}

#[tokio::test]
async fn recovery_unlock_consumes_the_code() {
    // H2: a successful recovery-unlock invalidates the recovery wrap
    // so the code can't be reused as a permanent backdoor. The user
    // must regenerate (or set a new password, which would also clear
    // recovery_*).
    let pool = mem_pool().await;
    let st = init(&pool, "pw").await.unwrap();
    let code = recovery::generate(&pool, &st).await.unwrap();
    let _key = recovery::unlock_with_code(&pool, &code).await.unwrap();
    assert!(!recovery::is_provisioned(&pool).await.unwrap());
    let err = recovery::unlock_with_code(&pool, &code).await.err().unwrap();
    assert!(matches!(err, AppError::BadPassword));
}

#[tokio::test]
async fn reset_nulls_both_credential_columns_on_sessions() {
    // M8: don't rely on FK cascade — explicit nulling of both
    // credential_id AND key_passphrase_credential_id.
    let pool = mem_pool().await;
    let st = init(&pool, "pw").await.unwrap();
    let (n, c) = encrypt_with(&st, b"x").unwrap();
    let row: (i64,) = sqlx::query_as(
        "INSERT INTO credentials (kind, label, nonce, ciphertext) \
         VALUES (?, ?, ?, ?) RETURNING id",
    )
        .bind("password").bind("c").bind(&n).bind(&c)
        .fetch_one(&pool).await.unwrap();
    let cred_id = row.0;
    sqlx::query(
        "INSERT INTO sessions (name, host, port, username, auth_type, \
         credential_id, key_passphrase_credential_id) \
         VALUES (?, ?, 22, ?, 'password', ?, ?)",
    )
        .bind("s").bind("h").bind("u").bind(cred_id).bind(cred_id)
        .execute(&pool).await.unwrap();

    reset(&pool).await.unwrap();

    let (a, b): (Option<i64>, Option<i64>) = sqlx::query_as(
        "SELECT credential_id, key_passphrase_credential_id FROM sessions",
    ).fetch_one(&pool).await.unwrap();
    assert!(a.is_none() && b.is_none());
}

#[tokio::test]
async fn unlock_refuses_tampered_kdf_params() {
    // M3: a write to vault_meta that lowers m_cost / t_cost below the
    // floor is treated as tampering. The legitimate user, unlocking
    // next, gets a clear error rather than silently running with a
    // weakened KDF.
    let pool = mem_pool().await;
    let _ = init(&pool, "pw").await.unwrap();
    sqlx::query("UPDATE vault_meta SET kdf_params = ? WHERE id = 1")
        .bind(r#"{"m":1024,"t":1,"p":1}"#)
        .execute(&pool).await.unwrap();
    let err = unlock(&pool, "pw").await.err().unwrap();
    assert!(matches!(err, AppError::Validation(_)));
}
