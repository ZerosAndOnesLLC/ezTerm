use serde::{Deserialize, Serialize};
use sqlx::{FromRow, SqlitePool};

use crate::error::{AppError, Result};

#[derive(Clone, Debug, Serialize, Deserialize, FromRow)]
pub struct Forward {
    pub id:         i64,
    pub session_id: i64,
    pub name:       String,
    pub kind:       String,        // 'local' | 'remote' | 'dynamic'
    pub bind_addr:  String,
    pub bind_port:  i64,
    pub dest_addr:  String,
    pub dest_port:  i64,
    pub auto_start: i64,
    pub sort:       i64,
    pub created_at: String,
}

#[derive(Clone, Debug, Deserialize)]
pub struct ForwardInput {
    pub name:       String,
    pub kind:       String,
    pub bind_addr:  String,
    pub bind_port:  i64,
    pub dest_addr:  String,
    pub dest_port:  i64,
    pub auto_start: i64,
}

/// Validates the kind-specific shape of a `ForwardInput`. Local/Remote
/// require non-empty `dest_addr` and a 1..=65535 `dest_port`. Dynamic
/// requires `dest_addr` empty and `dest_port` zero (the destination is
/// chosen per-connection by the SOCKS5 client).
pub fn validate_input(input: &ForwardInput) -> Result<()> {
    match input.kind.as_str() {
        "local" | "remote" => {
            if input.dest_addr.trim().is_empty() {
                return Err(AppError::Validation(
                    "dest_addr is required for local/remote forwards".into(),
                ));
            }
            if !(1..=65535).contains(&input.dest_port) {
                return Err(AppError::Validation(
                    "dest_port must be 1..=65535".into(),
                ));
            }
        }
        "dynamic" => {
            if !input.dest_addr.is_empty() || input.dest_port != 0 {
                return Err(AppError::Validation(
                    "dynamic forwards must have empty dest_addr and dest_port=0".into(),
                ));
            }
        }
        other => {
            return Err(AppError::Validation(format!("invalid forward kind: {other}")));
        }
    }
    if !(1..=65535).contains(&input.bind_port) {
        return Err(AppError::Validation("bind_port must be 1..=65535".into()));
    }
    Ok(())
}

const SELECT_COLS: &str = "id, session_id, name, kind, bind_addr, bind_port, \
                           dest_addr, dest_port, auto_start, sort, created_at";

pub async fn list_for_session(pool: &SqlitePool, session_id: i64) -> Result<Vec<Forward>> {
    let sql = format!(
        "SELECT {SELECT_COLS} FROM session_forwards \
         WHERE session_id = ? ORDER BY sort, id"
    );
    Ok(sqlx::query_as::<_, Forward>(&sql).bind(session_id).fetch_all(pool).await?)
}

pub async fn list_auto_start(pool: &SqlitePool, session_id: i64) -> Result<Vec<Forward>> {
    let sql = format!(
        "SELECT {SELECT_COLS} FROM session_forwards \
         WHERE session_id = ? AND auto_start = 1 ORDER BY sort, id"
    );
    Ok(sqlx::query_as::<_, Forward>(&sql).bind(session_id).fetch_all(pool).await?)
}

pub async fn get(pool: &SqlitePool, id: i64) -> Result<Forward> {
    let sql = format!("SELECT {SELECT_COLS} FROM session_forwards WHERE id = ?");
    sqlx::query_as::<_, Forward>(&sql).bind(id)
        .fetch_optional(pool).await?
        .ok_or(AppError::NotFound)
}

pub async fn create(
    pool: &SqlitePool,
    session_id: i64,
    input: &ForwardInput,
) -> Result<Forward> {
    validate_input(input)?;
    let next_sort: i64 = sqlx::query_scalar(
        "SELECT COALESCE(MAX(sort), -1) + 1 FROM session_forwards WHERE session_id = ?",
    )
    .bind(session_id)
    .fetch_one(pool)
    .await?;

    let id: i64 = sqlx::query_scalar(
        "INSERT INTO session_forwards \
         (session_id, name, kind, bind_addr, bind_port, dest_addr, dest_port, auto_start, sort) \
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id",
    )
    .bind(session_id)
    .bind(&input.name)
    .bind(&input.kind)
    .bind(&input.bind_addr)
    .bind(input.bind_port)
    .bind(&input.dest_addr)
    .bind(input.dest_port)
    .bind(input.auto_start)
    .bind(next_sort)
    .fetch_one(pool)
    .await?;
    get(pool, id).await
}

pub async fn update(pool: &SqlitePool, id: i64, input: &ForwardInput) -> Result<Forward> {
    validate_input(input)?;
    sqlx::query(
        "UPDATE session_forwards \
         SET name = ?, kind = ?, bind_addr = ?, bind_port = ?, \
             dest_addr = ?, dest_port = ?, auto_start = ? \
         WHERE id = ?",
    )
    .bind(&input.name)
    .bind(&input.kind)
    .bind(&input.bind_addr)
    .bind(input.bind_port)
    .bind(&input.dest_addr)
    .bind(input.dest_port)
    .bind(input.auto_start)
    .bind(id)
    .execute(pool)
    .await?;
    get(pool, id).await
}

pub async fn delete(pool: &SqlitePool, id: i64) -> Result<()> {
    sqlx::query("DELETE FROM session_forwards WHERE id = ?")
        .bind(id).execute(pool).await?;
    Ok(())
}

pub async fn reorder(pool: &SqlitePool, session_id: i64, ids: &[i64]) -> Result<()> {
    let mut tx = pool.begin().await?;
    for (i, fid) in ids.iter().enumerate() {
        sqlx::query("UPDATE session_forwards SET sort = ? WHERE id = ? AND session_id = ?")
            .bind(i as i64).bind(fid).bind(session_id)
            .execute(&mut *tx).await?;
    }
    tx.commit().await?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn base() -> ForwardInput {
        ForwardInput {
            name: String::new(),
            kind: "local".into(),
            bind_addr: "127.0.0.1".into(),
            bind_port: 5432,
            dest_addr: "db.internal".into(),
            dest_port: 5432,
            auto_start: 1,
        }
    }

    #[test]
    fn local_requires_dest() {
        let mut i = base(); i.dest_addr = "".into();
        assert!(validate_input(&i).is_err());
    }

    #[test]
    fn local_dest_port_range() {
        let mut i = base(); i.dest_port = 0;
        assert!(validate_input(&i).is_err());
        i.dest_port = 70_000;
        assert!(validate_input(&i).is_err());
    }

    #[test]
    fn dynamic_must_have_no_dest() {
        let mut i = base();
        i.kind = "dynamic".into();
        i.dest_addr = "".into();
        i.dest_port = 0;
        assert!(validate_input(&i).is_ok());

        i.dest_addr = "evil".into();
        assert!(validate_input(&i).is_err());
    }

    #[test]
    fn bind_port_range() {
        let mut i = base(); i.bind_port = 0;
        assert!(validate_input(&i).is_err());
    }

    #[test]
    fn unknown_kind_rejected() {
        let mut i = base(); i.kind = "udp".into();
        assert!(validate_input(&i).is_err());
    }
}
