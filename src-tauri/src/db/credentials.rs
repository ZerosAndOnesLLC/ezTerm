use serde::{Deserialize, Serialize};
use sqlx::SqlitePool;

use crate::error::Result;

#[derive(Clone, Debug, Serialize, Deserialize, sqlx::FromRow)]
pub struct CredentialMeta {
    pub id: i64,
    pub kind: String, // 'password' | 'private_key' | 'key_passphrase'
    pub label: String,
}

#[derive(sqlx::FromRow)]
pub(crate) struct CredentialRow {
    pub id: i64,
    pub kind: String,
    pub label: String,
    pub nonce: Vec<u8>,
    pub ciphertext: Vec<u8>,
}

pub async fn list(pool: &SqlitePool) -> Result<Vec<CredentialMeta>> {
    Ok(sqlx::query_as::<_, CredentialMeta>(
        "SELECT id, kind, label FROM credentials ORDER BY id DESC",
    )
    .fetch_all(pool)
    .await?)
}

pub(crate) async fn insert(
    pool: &SqlitePool,
    kind: &str,
    label: &str,
    nonce: &[u8],
    ciphertext: &[u8],
) -> Result<i64> {
    let id = sqlx::query(
        "INSERT INTO credentials (kind, label, nonce, ciphertext) VALUES (?, ?, ?, ?)",
    )
    .bind(kind)
    .bind(label)
    .bind(nonce)
    .bind(ciphertext)
    .execute(pool)
    .await?
    .last_insert_rowid();
    Ok(id)
}

pub(crate) async fn get(pool: &SqlitePool, id: i64) -> Result<CredentialRow> {
    sqlx::query_as::<_, CredentialRow>(
        "SELECT id, kind, label, nonce, ciphertext FROM credentials WHERE id = ?",
    )
    .bind(id)
    .fetch_optional(pool)
    .await?
    .ok_or(crate::error::AppError::NotFound)
}

pub async fn delete(pool: &SqlitePool, id: i64) -> Result<()> {
    sqlx::query("DELETE FROM credentials WHERE id = ?")
        .bind(id)
        .execute(pool)
        .await?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use sqlx::sqlite::SqlitePoolOptions;

    async fn pool() -> SqlitePool {
        let p = SqlitePoolOptions::new()
            .max_connections(1)
            .connect("sqlite::memory:")
            .await
            .unwrap();
        crate::db::init_pool_from_pool(&p).await.unwrap();
        p
    }

    #[tokio::test]
    async fn insert_list_delete() {
        let p = pool().await;
        let id = insert(&p, "password", "prod-db", &[0u8; 12], &[1, 2, 3])
            .await
            .unwrap();
        assert_eq!(list(&p).await.unwrap().len(), 1);
        let row = get(&p, id).await.unwrap();
        assert_eq!(row.nonce.len(), 12);
        delete(&p, id).await.unwrap();
        assert_eq!(list(&p).await.unwrap().len(), 0);
    }
}
