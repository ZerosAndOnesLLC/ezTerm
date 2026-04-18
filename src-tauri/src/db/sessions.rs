use serde::{Deserialize, Serialize};
use sqlx::SqlitePool;

use crate::error::Result;

#[derive(Clone, Debug, Serialize, Deserialize, sqlx::FromRow)]
pub struct Session {
    pub id: i64,
    pub folder_id: Option<i64>,
    pub name: String,
    pub host: String,
    pub port: i64,
    pub username: String,
    pub auth_type: String, // 'password' | 'key' | 'agent'
    pub credential_id: Option<i64>,
    pub color: Option<String>,
    pub sort: i64,
}

#[derive(Debug, Deserialize)]
pub struct SessionInput {
    pub folder_id: Option<i64>,
    pub name: String,
    pub host: String,
    pub port: i64,
    pub username: String,
    pub auth_type: String,
    pub credential_id: Option<i64>,
    pub color: Option<String>,
}

pub async fn list(pool: &SqlitePool) -> Result<Vec<Session>> {
    Ok(sqlx::query_as::<_, Session>(
        "SELECT id, folder_id, name, host, port, username, auth_type, credential_id, color, sort \
         FROM sessions ORDER BY folder_id, sort, id",
    )
    .fetch_all(pool)
    .await?)
}

pub async fn get(pool: &SqlitePool, id: i64) -> Result<Session> {
    sqlx::query_as::<_, Session>(
        "SELECT id, folder_id, name, host, port, username, auth_type, credential_id, color, sort \
         FROM sessions WHERE id = ?",
    )
    .bind(id)
    .fetch_optional(pool)
    .await?
    .ok_or(crate::error::AppError::NotFound)
}

pub async fn create(pool: &SqlitePool, input: &SessionInput) -> Result<Session> {
    let id = sqlx::query(
        "INSERT INTO sessions (folder_id, name, host, port, username, auth_type, credential_id, color) \
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    )
    .bind(input.folder_id)
    .bind(&input.name)
    .bind(&input.host)
    .bind(input.port)
    .bind(&input.username)
    .bind(&input.auth_type)
    .bind(input.credential_id)
    .bind(&input.color)
    .execute(pool)
    .await?
    .last_insert_rowid();
    get(pool, id).await
}

pub async fn update(pool: &SqlitePool, id: i64, input: &SessionInput) -> Result<Session> {
    sqlx::query(
        "UPDATE sessions SET folder_id = ?, name = ?, host = ?, port = ?, username = ?, \
         auth_type = ?, credential_id = ?, color = ? WHERE id = ?",
    )
    .bind(input.folder_id)
    .bind(&input.name)
    .bind(&input.host)
    .bind(input.port)
    .bind(&input.username)
    .bind(&input.auth_type)
    .bind(input.credential_id)
    .bind(&input.color)
    .bind(id)
    .execute(pool)
    .await?;
    get(pool, id).await
}

pub async fn delete(pool: &SqlitePool, id: i64) -> Result<()> {
    sqlx::query("DELETE FROM sessions WHERE id = ?")
        .bind(id)
        .execute(pool)
        .await?;
    Ok(())
}

pub async fn duplicate(pool: &SqlitePool, id: i64) -> Result<Session> {
    let src = get(pool, id).await?;
    let input = SessionInput {
        folder_id: src.folder_id,
        name: format!("{} (copy)", src.name),
        host: src.host,
        port: src.port,
        username: src.username,
        auth_type: src.auth_type,
        credential_id: src.credential_id,
        color: src.color,
    };
    create(pool, &input).await
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

    fn input(name: &str) -> SessionInput {
        SessionInput {
            folder_id: None,
            name: name.into(),
            host: "example.com".into(),
            port: 22,
            username: "root".into(),
            auth_type: "agent".into(),
            credential_id: None,
            color: None,
        }
    }

    #[tokio::test]
    async fn crud() {
        let p = pool().await;
        let s = create(&p, &input("alpha")).await.unwrap();
        assert_eq!(list(&p).await.unwrap().len(), 1);
        let dupe = duplicate(&p, s.id).await.unwrap();
        assert_eq!(dupe.name, "alpha (copy)");
        let mut upd = input("alpha2");
        upd.port = 2222;
        update(&p, s.id, &upd).await.unwrap();
        let got = get(&p, s.id).await.unwrap();
        assert_eq!(got.port, 2222);
        delete(&p, s.id).await.unwrap();
        assert_eq!(list(&p).await.unwrap().len(), 1); // duplicate remains
    }
}
