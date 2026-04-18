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
