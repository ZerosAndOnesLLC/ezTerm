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
    pub key_passphrase_credential_id: Option<i64>,
    pub color: Option<String>,
    pub sort: i64,
    // Terminal + advanced session settings (v0.5).
    pub initial_command: Option<String>,
    pub scrollback_lines: i64,
    pub font_size: i64,
    pub cursor_style: String, // 'block' | 'bar' | 'underline'
    pub compression: i64,     // 0 | 1 (SQLite has no bool)
    pub keepalive_secs: i64,
    pub connect_timeout_secs: i64,
    /// 'ssh' | 'wsl' | 'local'. For wsl/local, `host` re-purposes as the
    /// distro name or shell program, and `username` re-purposes as the
    /// wsl user or starting directory. Auth fields are forced to
    /// agent/NULL for non-ssh rows by the command-layer validator.
    pub session_kind: String,
    /// 0/1 — SSH-only. When 1, the connect flow asks russh for X11
    /// forwarding and starts a local VcXsrv display to receive the
    /// forwarded GUI apps. Ignored for wsl/local rows.
    pub forward_x11: i64,
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
    pub key_passphrase_credential_id: Option<i64>,
    pub color: Option<String>,
    pub initial_command: Option<String>,
    pub scrollback_lines: i64,
    pub font_size: i64,
    pub cursor_style: String,
    pub compression: i64,
    pub keepalive_secs: i64,
    pub connect_timeout_secs: i64,
    /// Environment variables sent via `channel.set_env` at connect time.
    /// Sent separately from the sessions row; see `session_env` table.
    pub env: Vec<EnvPair>,
    #[serde(default = "default_session_kind")]
    pub session_kind: String,
    #[serde(default)]
    pub forward_x11: i64,
}

fn default_session_kind() -> String {
    "ssh".to_string()
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct EnvPair {
    pub key: String,
    pub value: String,
}

const SELECT_COLS: &str = "id, folder_id, name, host, port, username, auth_type, \
credential_id, key_passphrase_credential_id, color, sort, \
initial_command, scrollback_lines, font_size, cursor_style, compression, \
keepalive_secs, connect_timeout_secs, session_kind, forward_x11";

pub async fn list(pool: &SqlitePool) -> Result<Vec<Session>> {
    let sql = format!(
        "SELECT {SELECT_COLS} FROM sessions ORDER BY folder_id, sort, id"
    );
    Ok(sqlx::query_as::<_, Session>(&sql).fetch_all(pool).await?)
}

pub async fn get(pool: &SqlitePool, id: i64) -> Result<Session> {
    let sql = format!("SELECT {SELECT_COLS} FROM sessions WHERE id = ?");
    sqlx::query_as::<_, Session>(&sql)
        .bind(id)
        .fetch_optional(pool)
        .await?
        .ok_or(crate::error::AppError::NotFound)
}

pub async fn env_get(pool: &SqlitePool, session_id: i64) -> Result<Vec<EnvPair>> {
    let rows = sqlx::query_as::<_, (String, String)>(
        "SELECT key, value FROM session_env WHERE session_id = ? ORDER BY key",
    )
    .bind(session_id)
    .fetch_all(pool)
    .await?;
    Ok(rows.into_iter().map(|(key, value)| EnvPair { key, value }).collect())
}

async fn env_replace(
    tx: &mut sqlx::Transaction<'_, sqlx::Sqlite>,
    session_id: i64,
    env: &[EnvPair],
) -> Result<()> {
    // Takes an explicit transaction so callers control atomicity alongside
    // the `sessions` row write. Uses `&mut *tx` dereference so each `execute`
    // borrows the transaction for only the duration of that query, letting
    // the loop reuse it on the next iteration.
    sqlx::query("DELETE FROM session_env WHERE session_id = ?")
        .bind(session_id)
        .execute(&mut **tx)
        .await?;
    for p in env {
        sqlx::query("INSERT INTO session_env (session_id, key, value) VALUES (?, ?, ?)")
            .bind(session_id)
            .bind(&p.key)
            .bind(&p.value)
            .execute(&mut **tx)
            .await?;
    }
    Ok(())
}

pub async fn create(pool: &SqlitePool, input: &SessionInput) -> Result<Session> {
    let mut tx = pool.begin().await?;
    let id = sqlx::query(
        "INSERT INTO sessions (folder_id, name, host, port, username, auth_type, \
         credential_id, key_passphrase_credential_id, color, \
         initial_command, scrollback_lines, font_size, cursor_style, \
         compression, keepalive_secs, connect_timeout_secs, session_kind, \
         forward_x11) \
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    )
    .bind(input.folder_id)
    .bind(&input.name)
    .bind(&input.host)
    .bind(input.port)
    .bind(&input.username)
    .bind(&input.auth_type)
    .bind(input.credential_id)
    .bind(input.key_passphrase_credential_id)
    .bind(&input.color)
    .bind(&input.initial_command)
    .bind(input.scrollback_lines)
    .bind(input.font_size)
    .bind(&input.cursor_style)
    .bind(input.compression)
    .bind(input.keepalive_secs)
    .bind(input.connect_timeout_secs)
    .bind(&input.session_kind)
    .bind(input.forward_x11)
    .execute(&mut *tx)
    .await?
    .last_insert_rowid();
    env_replace(&mut tx, id, &input.env).await?;
    tx.commit().await?;
    get(pool, id).await
}

pub async fn update(pool: &SqlitePool, id: i64, input: &SessionInput) -> Result<Session> {
    let mut tx = pool.begin().await?;
    sqlx::query(
        "UPDATE sessions SET folder_id = ?, name = ?, host = ?, port = ?, username = ?, \
         auth_type = ?, credential_id = ?, key_passphrase_credential_id = ?, color = ?, \
         initial_command = ?, scrollback_lines = ?, font_size = ?, cursor_style = ?, \
         compression = ?, keepalive_secs = ?, connect_timeout_secs = ?, \
         session_kind = ?, forward_x11 = ? \
         WHERE id = ?",
    )
    .bind(input.folder_id)
    .bind(&input.name)
    .bind(&input.host)
    .bind(input.port)
    .bind(&input.username)
    .bind(&input.auth_type)
    .bind(input.credential_id)
    .bind(input.key_passphrase_credential_id)
    .bind(&input.color)
    .bind(&input.initial_command)
    .bind(input.scrollback_lines)
    .bind(input.font_size)
    .bind(&input.cursor_style)
    .bind(input.compression)
    .bind(input.keepalive_secs)
    .bind(input.connect_timeout_secs)
    .bind(&input.session_kind)
    .bind(input.forward_x11)
    .bind(id)
    .execute(&mut *tx)
    .await?;
    env_replace(&mut tx, id, &input.env).await?;
    tx.commit().await?;
    get(pool, id).await
}

pub async fn delete(pool: &SqlitePool, id: i64) -> Result<()> {
    sqlx::query("DELETE FROM sessions WHERE id = ?")
        .bind(id)
        .execute(pool)
        .await?;
    Ok(())
}

pub async fn mv(
    pool: &SqlitePool,
    id: i64,
    folder_id: Option<i64>,
    sort: i64,
) -> Result<()> {
    sqlx::query("UPDATE sessions SET folder_id = ?, sort = ? WHERE id = ?")
        .bind(folder_id)
        .bind(sort)
        .bind(id)
        .execute(pool)
        .await?;
    Ok(())
}

pub async fn duplicate(pool: &SqlitePool, id: i64) -> Result<Session> {
    let src = get(pool, id).await?;
    let env = env_get(pool, id).await?;
    let input = SessionInput {
        folder_id: src.folder_id,
        name: format!("{} (copy)", src.name),
        host: src.host,
        port: src.port,
        username: src.username,
        auth_type: src.auth_type,
        credential_id: src.credential_id,
        key_passphrase_credential_id: src.key_passphrase_credential_id,
        color: src.color,
        initial_command: src.initial_command,
        scrollback_lines: src.scrollback_lines,
        font_size: src.font_size,
        cursor_style: src.cursor_style,
        compression: src.compression,
        keepalive_secs: src.keepalive_secs,
        connect_timeout_secs: src.connect_timeout_secs,
        env,
        session_kind: src.session_kind,
        forward_x11: src.forward_x11,
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
            key_passphrase_credential_id: None,
            color: None,
            initial_command: None,
            scrollback_lines: 5000,
            font_size: 13,
            cursor_style: "block".into(),
            compression: 0,
            keepalive_secs: 0,
            connect_timeout_secs: 15,
            env: Vec::new(),
            session_kind: "ssh".into(),
            forward_x11: 0,
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
        upd.keepalive_secs = 60;
        upd.env = vec![EnvPair { key: "LANG".into(), value: "C.UTF-8".into() }];
        update(&p, s.id, &upd).await.unwrap();
        let got = get(&p, s.id).await.unwrap();
        assert_eq!(got.port, 2222);
        assert_eq!(got.keepalive_secs, 60);
        let env = env_get(&p, s.id).await.unwrap();
        assert_eq!(env.len(), 1);
        assert_eq!(env[0].key, "LANG");
        delete(&p, s.id).await.unwrap();
        assert_eq!(list(&p).await.unwrap().len(), 1); // duplicate remains
        // env cascade: deleting the source session clears its env rows, the
        // duplicate's env row count is validated via env_get above.
        let env_after = env_get(&p, s.id).await.unwrap();
        assert!(env_after.is_empty());
    }
}
