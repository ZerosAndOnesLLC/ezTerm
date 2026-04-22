use sqlx::sqlite::{SqliteConnectOptions, SqlitePoolOptions};
use sqlx::{Row, SqlitePool};
use std::path::Path;
use std::str::FromStr;

pub mod credentials;
pub mod folders;
pub mod known_hosts;
pub mod sessions;
pub mod settings;

static MIGRATOR: sqlx::migrate::Migrator = sqlx::migrate!("../migrations");

pub async fn init_pool(db_path: &Path) -> crate::error::Result<SqlitePool> {
    if let Some(parent) = db_path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let url = format!("sqlite://{}", db_path.display());
    let opts = SqliteConnectOptions::from_str(&url)?
        .create_if_missing(true)
        .foreign_keys(true)
        .journal_mode(sqlx::sqlite::SqliteJournalMode::Wal);
    let pool = SqlitePoolOptions::new().max_connections(8).connect_with(opts).await?;
    heal_line_ending_checksums(&pool).await?;
    MIGRATOR.run(&pool).await?;
    Ok(pool)
}

#[cfg(test)]
pub async fn init_pool_from_pool(pool: &SqlitePool) -> crate::error::Result<()> {
    MIGRATOR.run(pool).await?;
    Ok(())
}

/// Silently repair stored migration checksums that differ from the embedded
/// ones only by line endings. `sqlx::migrate!` hashes raw bytes, so a
/// migration that lives as LF on disk in one build and CRLF in another
/// produces two different sha384s for the same SQL. When a DB populated
/// under the first build boots under the second, sqlx panics with
/// `VersionMismatch` — even though the SQL is semantically identical.
///
/// This is a one-shot heal per row: if the stored checksum matches either
/// the LF or CRLF rendering of the currently embedded SQL, rewrite it to
/// the embedded checksum. Anything that *isn't* a pure line-ending variant
/// is left alone so genuine tampering still trips the sqlx check.
async fn heal_line_ending_checksums(pool: &SqlitePool) -> crate::error::Result<()> {
    use sha2::{Digest, Sha384};

    // Fresh DBs don't have this table yet — nothing to heal.
    let table_exists: Option<i64> = sqlx::query_scalar(
        "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = '_sqlx_migrations'",
    )
    .fetch_optional(pool)
    .await?;
    if table_exists.is_none() {
        return Ok(());
    }

    let rows = sqlx::query("SELECT version, checksum FROM _sqlx_migrations WHERE success = 1")
        .fetch_all(pool)
        .await?;

    for row in rows {
        let version: i64 = row.try_get("version")?;
        let stored: Vec<u8> = row.try_get("checksum")?;

        let Some(embedded) = MIGRATOR.iter().find(|m| m.version == version) else {
            continue;
        };
        if embedded.checksum.as_ref() == stored.as_slice() {
            continue;
        }

        let lf = embedded.sql.replace("\r\n", "\n");
        let crlf = lf.replace('\n', "\r\n");
        let lf_hash = Sha384::digest(lf.as_bytes());
        let crlf_hash = Sha384::digest(crlf.as_bytes());

        let is_line_ending_variant = stored.as_slice() == lf_hash.as_slice()
            || stored.as_slice() == crlf_hash.as_slice();

        if is_line_ending_variant {
            sqlx::query("UPDATE _sqlx_migrations SET checksum = ? WHERE version = ?")
                .bind(embedded.checksum.as_ref())
                .bind(version)
                .execute(pool)
                .await?;
            tracing::info!(
                version,
                "healed migration checksum (line-ending variant of embedded SQL)"
            );
        }
        // Otherwise leave the row alone — MIGRATOR.run() will surface the
        // real mismatch, which is what we want for genuine edits.
    }

    Ok(())
}
