use sqlx::SqlitePool;

use crate::error::Result;

pub async fn get(pool: &SqlitePool, key: &str) -> Result<Option<String>> {
    let row: Option<(String,)> = sqlx::query_as("SELECT value FROM app_settings WHERE key = ?")
        .bind(key)
        .fetch_optional(pool)
        .await?;
    Ok(row.map(|(v,)| v))
}

/// Keys under this prefix belong to this install only (e.g. the
/// persistent-session install id). They are never listed, exported to a
/// backup / sync bundle, restored from one, or writable from the webview.
pub const LOCAL_ONLY_PREFIX: &str = "local.";

pub fn is_local_only(key: &str) -> bool {
    key.starts_with(LOCAL_ONLY_PREFIX)
}

/// Every non-local setting. Feeds the frontend store and backup / sync
/// bundles, so local-only keys are filtered out here once.
pub async fn list_all(pool: &SqlitePool) -> Result<Vec<(String, String)>> {
    Ok(sqlx::query_as::<_, (String, String)>(
        "SELECT key, value FROM app_settings WHERE substr(key, 1, 6) <> 'local.' ORDER BY key",
    )
    .fetch_all(pool)
    .await?)
}

/// Insert only when the key has no value yet; an existing value wins.
pub async fn set_if_absent(pool: &SqlitePool, key: &str, value: &str) -> Result<()> {
    sqlx::query("INSERT INTO app_settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO NOTHING")
        .bind(key)
        .bind(value)
        .execute(pool)
        .await?;
    Ok(())
}

pub async fn set(pool: &SqlitePool, key: &str, value: &str) -> Result<()> {
    sqlx::query(
        "INSERT INTO app_settings (key, value) VALUES (?, ?) \
         ON CONFLICT(key) DO UPDATE SET value = excluded.value",
    )
    .bind(key)
    .bind(value)
    .execute(pool)
    .await?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use sqlx::sqlite::SqlitePoolOptions;

    #[tokio::test]
    async fn upsert() {
        let p = SqlitePoolOptions::new()
            .max_connections(1)
            .connect("sqlite::memory:")
            .await
            .unwrap();
        crate::db::init_pool_from_pool(&p).await.unwrap();
        set(&p, "theme", "dark").await.unwrap();
        assert_eq!(get(&p, "theme").await.unwrap(), Some("dark".into()));
        set(&p, "theme", "light").await.unwrap();
        assert_eq!(get(&p, "theme").await.unwrap(), Some("light".into()));
    }
}
