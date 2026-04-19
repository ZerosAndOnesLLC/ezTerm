use sqlx::sqlite::{SqliteConnectOptions, SqlitePoolOptions};
use sqlx::SqlitePool;
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
    MIGRATOR.run(&pool).await?;
    Ok(pool)
}

#[cfg(test)]
pub async fn init_pool_from_pool(pool: &SqlitePool) -> crate::error::Result<()> {
    MIGRATOR.run(pool).await?;
    Ok(())
}
