//! Pre-change SQLite snapshots. Before `change_password` or `reset`
//! mutates the vault we copy the current DB file to
//! `<data_local>/backups/vault-<timestamp>.sqlite` using SQLite's
//! `VACUUM INTO`, which produces a transactionally consistent copy
//! even while a writer is active.
//!
//! Retention: at most `KEEP` files (count cap) AND nothing older than
//! `MAX_AGE_DAYS` (time cap). Snapshots leak the encrypted vault at
//! the previous KDF parameters — useful as a rollback target, but a
//! standing offline-cracking surface for an attacker who later gains
//! local file access. The double cap keeps the standing exposure
//! bounded.
//!
//! On unix the snapshot file's permission bits are tightened to 0600
//! after `VACUUM INTO` finishes (which inherits umask). The project
//! ships on Windows, but cargo-built dev/test artefacts run on Linux,
//! and a multi-user Linux host with the default 0644 umask would leak
//! every snapshot to anyone on the box.

use std::path::{Path, PathBuf};

use sqlx::SqlitePool;

use crate::error::{AppError, Result};

const KEEP: usize = 5;
const MAX_AGE_DAYS: u64 = 30;
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

/// Take a consistent snapshot of the live SQLite DB. Returns the
/// path the snapshot was written to. After writing, rotates older
/// snapshots down to `KEEP` files AND deletes anything older than
/// `MAX_AGE_DAYS` regardless of count.
pub async fn take(pool: &SqlitePool, label: &str) -> Result<PathBuf> {
    // Defense-in-depth: `label` is interpolated into a SQL string
    // literal (sqlite refuses to bind a parameter inside `VACUUM
    // INTO`). All current callers pass a hardcoded string; reject
    // anything else so a future caller passing user input can't
    // silently introduce SQL injection.
    if !label.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_') {
        return Err(AppError::Validation("snapshot label must be [A-Za-z0-9_-]".into()));
    }

    let dir = backups_dir()?;
    let stamp = chrono::Utc::now().format("%Y%m%d-%H%M%S");
    let filename = format!("{SNAPSHOT_PREFIX}{label}-{stamp}{SNAPSHOT_SUFFIX}");
    let target = dir.join(&filename);
    let escaped = target.to_string_lossy().replace('\'', "''");
    sqlx::query(&format!("VACUUM INTO '{escaped}'"))
        .execute(pool).await?;

    // Lock the snapshot down on unix so it can't be read by other
    // users on a shared machine. No-op on Windows where data_local_dir
    // is already per-user.
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        if let Ok(meta) = std::fs::metadata(&target) {
            let mut p = meta.permissions();
            p.set_mode(0o600);
            let _ = std::fs::set_permissions(&target, p);
        }
    }

    if let Err(e) = rotate(&dir) {
        tracing::warn!("vault snapshot rotation failed: {e}");
    }
    Ok(target)
}

fn rotate(dir: &Path) -> std::io::Result<()> {
    let max_age = std::time::Duration::from_secs(MAX_AGE_DAYS * 86_400);
    let now = std::time::SystemTime::now();
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

    // Drop by count cap.
    for (_, path) in entries.iter().skip(KEEP) {
        let _ = std::fs::remove_file(path);
    }
    // Drop by age cap — survives the count cap if KEEP itself was
    // raised; keeps the offline-cracking exposure window bounded.
    for (when, path) in entries.iter().take(KEEP) {
        if let Ok(age) = now.duration_since(*when) {
            if age > max_age {
                let _ = std::fs::remove_file(path);
            }
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use sqlx::sqlite::SqlitePoolOptions;

    #[tokio::test]
    async fn snapshot_creates_a_file() {
        let tmp = tempfile::tempdir().unwrap();
        let db_path = tmp.path().join("src.sqlite");
        let url = format!("sqlite://{}?mode=rwc", db_path.display());
        let pool = SqlitePoolOptions::new()
            .max_connections(1)
            .connect(&url).await.unwrap();
        sqlx::query("CREATE TABLE t (x INTEGER)")
            .execute(&pool).await.unwrap();

        let target = tmp.path().join("snap.sqlite");
        let escaped = target.to_string_lossy().replace('\'', "''");
        sqlx::query(&format!("VACUUM INTO '{escaped}'"))
            .execute(&pool).await.unwrap();
        assert!(target.exists());
    }

    #[test]
    fn snapshot_rotation_keeps_recent_and_drops_old() {
        // Write 8 fake snapshots in sequence. Each takes long enough
        // for mtimes to differ by at least filesystem resolution
        // (ext4/NTFS are nanosecond; APFS is one-second). After
        // rotate(), only KEEP=5 should remain (none are >30 days).
        let tmp = tempfile::tempdir().unwrap();
        let dir = tmp.path();
        for i in 0..8 {
            let p = dir.join(format!(
                "{}{}.sqlite",
                super::SNAPSHOT_PREFIX,
                format!("test-{i:03}")
            ));
            std::fs::write(&p, b"").unwrap();
            // Force ordering by sleeping briefly so even coarse-mtime
            // filesystems give a stable sort.
            std::thread::sleep(std::time::Duration::from_millis(15));
        }
        super::rotate(dir).unwrap();
        let remaining = std::fs::read_dir(dir).unwrap()
            .filter_map(|e| e.ok())
            .filter(|e| {
                let n = e.file_name();
                let s = n.to_string_lossy();
                s.starts_with(super::SNAPSHOT_PREFIX) && s.ends_with(super::SNAPSHOT_SUFFIX)
            })
            .count();
        assert_eq!(remaining, 5);
    }
}
