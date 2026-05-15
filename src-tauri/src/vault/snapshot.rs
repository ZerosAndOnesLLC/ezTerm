//! Pre-change SQLite snapshots. Before `change_password` or `reset`
//! mutates the vault we copy the current DB file to
//! `<data_local>/backups/vault-<timestamp>.sqlite` using SQLite's
//! `VACUUM INTO`, which produces a transactionally consistent copy even
//! while a writer is active. The most recent five snapshots are kept;
//! older ones are deleted on a best-effort basis.

use std::path::{Path, PathBuf};

use sqlx::SqlitePool;

use crate::error::{AppError, Result};

const KEEP: usize = 5;
const SNAPSHOT_PREFIX: &str = "vault-";
const SNAPSHOT_SUFFIX: &str = ".sqlite";

/// Resolve the on-disk backups directory and ensure it exists.
pub fn backups_dir() -> Result<PathBuf> {
    let dirs = directories::ProjectDirs::from("com", "ZerosAndOnes", "ezTerm")
        .ok_or_else(|| AppError::Validation("could not resolve data directory".into()))?;
    let path = dirs.data_local_dir().join("backups");
    std::fs::create_dir_all(&path)?;
    Ok(path)
}

/// Take a consistent snapshot of the live SQLite DB. Returns the path
/// the snapshot was written to. After writing, rotates older snapshots
/// down to `KEEP` files.
pub async fn take(pool: &SqlitePool, label: &str) -> Result<PathBuf> {
    let dir = backups_dir()?;
    let stamp = chrono::Utc::now().format("%Y%m%d-%H%M%S");
    let filename = format!("{SNAPSHOT_PREFIX}{label}-{stamp}{SNAPSHOT_SUFFIX}");
    let target = dir.join(&filename);
    // sqlx interpolates path arguments via parameter binding, but
    // VACUUM INTO won't accept a bound parameter — it has to be a
    // literal. We quote with single quotes and escape any embedded
    // quotes (paranoid; the path is built from a timestamp).
    let escaped = target.to_string_lossy().replace('\'', "''");
    sqlx::query(&format!("VACUUM INTO '{escaped}'"))
        .execute(pool).await?;
    rotate(&dir).ok();
    Ok(target)
}

/// Delete older snapshots until at most `KEEP` remain. Failures are
/// non-fatal — a snapshot still being written by another tool, a
/// permission glitch, etc. shouldn't block the password change.
fn rotate(dir: &Path) -> std::io::Result<()> {
    let mut entries: Vec<(std::time::SystemTime, PathBuf)> = std::fs::read_dir(dir)?
        .filter_map(|e| e.ok())
        .filter(|e| {
            let name = e.file_name();
            let s = name.to_string_lossy();
            s.starts_with(SNAPSHOT_PREFIX) && s.ends_with(SNAPSHOT_SUFFIX)
        })
        .filter_map(|e| {
            let p = e.path();
            let m = e.metadata().ok()?.modified().ok()?;
            Some((m, p))
        })
        .collect();
    entries.sort_by(|a, b| b.0.cmp(&a.0)); // newest first
    for (_, path) in entries.into_iter().skip(KEEP) {
        let _ = std::fs::remove_file(path);
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use sqlx::sqlite::SqlitePoolOptions;

    #[tokio::test]
    async fn snapshot_creates_a_file() {
        // Use a tempfile-backed sqlite so VACUUM INTO has somewhere
        // real to copy to. In-memory DBs don't support VACUUM INTO
        // across attached files reliably.
        let tmp = tempfile::tempdir().unwrap();
        let db_path = tmp.path().join("src.sqlite");
        let url = format!("sqlite://{}?mode=rwc", db_path.display());
        let pool = SqlitePoolOptions::new()
            .max_connections(1)
            .connect(&url).await.unwrap();
        sqlx::query("CREATE TABLE t (x INTEGER)")
            .execute(&pool).await.unwrap();

        // Target our own temp dir, not the platform data dir.
        let target = tmp.path().join("snap.sqlite");
        let escaped = target.to_string_lossy().replace('\'', "''");
        sqlx::query(&format!("VACUUM INTO '{escaped}'"))
            .execute(&pool).await.unwrap();
        assert!(target.exists());
    }
}
