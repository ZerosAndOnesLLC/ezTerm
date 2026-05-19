//! WSL file-browser handle. Owns the distro name + optional user, a
//! cached `$HOME`, and the helpers that translate Linux paths into the
//! Windows UNC path Plan 9 exposes them under (`\\wsl.localhost\<distro>\…`).
//!
//! All POSIX-aware operations (ls -la, chmod, realpath) shell out via
//! `wsl.exe -d <distro> [-u <user>]`. Pure file I/O (mkdir, rmdir,
//! rename, remove, copy bytes) goes through the UNC path with
//! `tokio::fs`. This split keeps the common verbs fast while preserving
//! correct POSIX semantics for the bits Windows can't represent.

use std::path::PathBuf;

use tokio::process::Command;
use tokio::sync::OnceCell;

use crate::error::{AppError, Result};

/// One per WSL connection. Stored inside the `FileBrowser` enum in the
/// shared SFTP registry so the existing `sftp_*` commands dispatch
/// uniformly between real SFTP and the WSL adapter.
pub struct WslFsHandle {
    distro: String,
    user:   Option<String>,
    /// Cached `$HOME` for the distro/user pair. Populated on first
    /// `sftp_realpath('.')` and reused for subsequent calls so we don't
    /// shell out to `wsl.exe` on every refresh.
    home:   OnceCell<String>,
}

impl WslFsHandle {
    pub fn new(distro: String, user: Option<String>) -> Self {
        Self {
            distro,
            user,
            home: OnceCell::new(),
        }
    }

    /// Resolve and cache the user's `$HOME` in the distro. WSL's plan9
    /// bridge has no API for "what's the home of this user" — we have
    /// to ask the distro itself. `printf %s "$HOME"` avoids a trailing
    /// newline that `pwd`/`echo` would add.
    pub async fn home(&self) -> Result<String> {
        self.home
            .get_or_try_init(|| async {
                let out = self
                    .wsl_exec(&["sh", "-c", "printf %s \"$HOME\""])
                    .await?;
                let home = out.trim().to_string();
                if home.is_empty() {
                    Ok("/".to_string())
                } else {
                    Ok(home)
                }
            })
            .await
            .cloned()
    }

    /// Translate a Linux-style path to the Windows UNC path Plan 9
    /// exposes the distro's filesystem under. Caller is expected to
    /// have already run the path through `sftp::normalise_remote_path`
    /// so we know there are no NUL bytes, backslashes, or `..`
    /// segments.
    ///
    /// `/foo/bar` → `\\wsl.localhost\<distro>\foo\bar`
    /// `/`       → `\\wsl.localhost\<distro>\`
    pub fn linux_to_unc(&self, path: &str) -> PathBuf {
        let trimmed = path.trim_start_matches('/');
        let win = trimmed.replace('/', "\\");
        if win.is_empty() {
            PathBuf::from(format!(r"\\wsl.localhost\{}\", self.distro))
        } else {
            PathBuf::from(format!(r"\\wsl.localhost\{}\{}", self.distro, win))
        }
    }

    /// Spawn `wsl.exe -d <distro> [-u <user>] -- <argv…>` and return
    /// captured stdout on success, or an error string built from the
    /// process exit code + stderr. Used by `ls -la`, `chmod`, `realpath`.
    pub async fn wsl_exec(&self, argv: &[&str]) -> Result<String> {
        let mut cmd = Command::new("wsl.exe");
        // Distro name may be empty here — that means "default distro",
        // which `wsl.exe` selects when `-d` is omitted entirely. Skip
        // the flag rather than passing an empty argument.
        if !self.distro.is_empty() {
            cmd.arg("-d").arg(&self.distro);
        }
        if let Some(u) = &self.user {
            cmd.arg("-u").arg(u);
        }
        // LANG=C pins month names, error messages, and whitespace in
        // tool output so the listing parser doesn't need locale logic.
        // `--` separates wsl.exe flags from the inner argv.
        cmd.arg("-e");
        cmd.arg("env").arg("LANG=C").arg("LC_ALL=C");
        for a in argv {
            cmd.arg(a);
        }
        let output = cmd
            .output()
            .await
            .map_err(|e| AppError::Sftp(format!("wsl.exe: {e}")))?;
        if !output.status.success() {
            let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
            return Err(AppError::Sftp(format!(
                "wsl.exe exited {}: {stderr}",
                output.status.code().unwrap_or(-1),
            )));
        }
        // wsl.exe emits UTF-16 on Windows when stdout is not a TTY in
        // some host configurations, but the `-e` form pipes the inner
        // program's stdout directly and our payload comes from
        // POSIX tools that emit UTF-8. Lossy decode is a safety net.
        Ok(String::from_utf8_lossy(&output.stdout).into_owned())
    }
}
