use serde::{Deserialize, Serialize};
use sqlx::SqlitePool;

use crate::error::Result;

#[derive(Clone, Debug, Serialize, Deserialize, sqlx::FromRow)]
pub struct KnownHost {
    pub host: String,
    pub port: i64,
    pub key_type: String,
    pub fingerprint: String,
    pub fingerprint_sha256: String,
    pub first_seen: String,
}

pub async fn list(pool: &SqlitePool) -> Result<Vec<KnownHost>> {
    Ok(sqlx::query_as::<_, KnownHost>(
        "SELECT host, port, key_type, fingerprint, fingerprint_sha256, first_seen \
         FROM known_hosts ORDER BY host, port",
    )
    .fetch_all(pool)
    .await?)
}

pub async fn get(
    pool: &SqlitePool,
    host: &str,
    port: i64,
) -> Result<Option<KnownHost>> {
    Ok(sqlx::query_as::<_, KnownHost>(
        "SELECT host, port, key_type, fingerprint, fingerprint_sha256, first_seen \
         FROM known_hosts WHERE host = ? AND port = ? LIMIT 1",
    )
    .bind(host)
    .bind(port)
    .fetch_optional(pool)
    .await?)
}

pub async fn upsert(
    pool: &SqlitePool,
    host: &str,
    port: i64,
    key_type: &str,
    fingerprint: &str,
    fingerprint_sha256: &str,
) -> Result<()> {
    sqlx::query(
        "INSERT INTO known_hosts (host, port, key_type, fingerprint, fingerprint_sha256) \
         VALUES (?, ?, ?, ?, ?) \
         ON CONFLICT(host, port) DO UPDATE SET \
           key_type = excluded.key_type, \
           fingerprint = excluded.fingerprint, \
           fingerprint_sha256 = excluded.fingerprint_sha256",
    )
    .bind(host)
    .bind(port)
    .bind(key_type)
    .bind(fingerprint)
    .bind(fingerprint_sha256)
    .execute(pool)
    .await?;
    Ok(())
}

pub async fn remove(pool: &SqlitePool, host: &str, port: i64) -> Result<()> {
    sqlx::query("DELETE FROM known_hosts WHERE host = ? AND port = ?")
        .bind(host)
        .bind(port)
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
    async fn upsert_and_get() {
        let p = pool().await;
        assert!(get(&p, "host.example", 22).await.unwrap().is_none());
        upsert(&p, "host.example", 22, "ssh-ed25519", "legacy-fp", "sha256:abc").await.unwrap();
        let row = get(&p, "host.example", 22).await.unwrap().unwrap();
        assert_eq!(row.fingerprint_sha256, "sha256:abc");
        upsert(&p, "host.example", 22, "ssh-ed25519", "legacy-fp", "sha256:def").await.unwrap();
        let row = get(&p, "host.example", 22).await.unwrap().unwrap();
        assert_eq!(row.fingerprint_sha256, "sha256:def");
        remove(&p, "host.example", 22).await.unwrap();
        assert!(get(&p, "host.example", 22).await.unwrap().is_none());
    }
}
