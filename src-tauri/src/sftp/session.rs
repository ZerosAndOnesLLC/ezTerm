use tokio::sync::{Mutex, MutexGuard};

use russh_sftp::client::SftpSession;

use crate::error::{AppError, Result};

/// One SFTP channel per SSH connection. The underlying `SftpSession` is not
/// `Clone`, so we own it behind a `Mutex` and acquire exclusively per operation.
/// SFTP verbs are short-lived; lock contention is not a concern.
pub struct SftpHandle {
    session: Mutex<SftpSession>,
}

impl SftpHandle {
    pub fn new(session: SftpSession) -> Self {
        Self {
            session: Mutex::new(session),
        }
    }

    /// Acquire exclusive access to the underlying `SftpSession`. Prefer
    /// `with_session` for the common one-shot-verb pattern; this exists for
    /// callers that need to interleave multiple SFTP operations while holding
    /// a consistent view (e.g. open handle + sequential reads).
    #[allow(dead_code)] // consumed by Bundle 2 transfer module
    pub async fn lock(&self) -> MutexGuard<'_, SftpSession> {
        self.session.lock().await
    }

    /// Convenience wrapper: locks the session, passes it to `f`, releases lock
    /// on exit. `f` must be an `AsyncFnOnce` so it can borrow the session
    /// across `.await` points.
    #[allow(dead_code)] // consumed by Bundle 2 SFTP commands
    pub async fn with_session<F, R>(&self, f: F) -> Result<R>
    where
        F: for<'a> AsyncFnOnce(&'a mut SftpSession) -> Result<R>,
    {
        let mut g = self.session.lock().await;
        f(&mut g).await
    }
}

/// Normalise a remote path: reject `..` segments, `\0`, and empty input. This
/// is the ONLY place path normalisation happens. Every SFTP command must route
/// through `normalise_remote_path`.
#[allow(dead_code)] // consumed by Bundle 2 SFTP commands
pub fn normalise_remote_path(raw: &str) -> Result<String> {
    if raw.is_empty() {
        return Err(AppError::Validation("empty path".into()));
    }
    if raw.contains('\0') {
        return Err(AppError::PathTraversal);
    }
    // Disallow bare "..". Allow "." only as the current dir literal the UI
    // passes at cwd.
    for seg in raw.split('/') {
        if seg == ".." {
            return Err(AppError::PathTraversal);
        }
    }
    Ok(raw.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn normalise_rejects_dot_dot() {
        assert!(normalise_remote_path("/etc/../secret").is_err());
        assert!(normalise_remote_path("..").is_err());
    }

    #[test]
    fn normalise_rejects_nul() {
        assert!(normalise_remote_path("/etc/\0").is_err());
    }

    #[test]
    fn normalise_allows_dot() {
        assert!(normalise_remote_path("/home/user/.").is_ok());
    }

    #[test]
    fn normalise_rejects_empty() {
        assert!(normalise_remote_path("").is_err());
    }
}
