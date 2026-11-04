//! Single-file ops for WSL connections — mkdir / rmdir / remove /
//! rename / chmod / realpath. Pure I/O ops (mk/rm/rename) go through
//! the `\\wsl.localhost\<distro>\` UNC path so they're fast and don't
//! pay the `wsl.exe` launch cost. POSIX-aware ops (chmod, realpath)
//! shell out to the distro's coreutils because the UNC bridge maps
//! permissions to Windows ACLs and can't represent setuid/setgid/sticky.

use tokio::fs;

use crate::error::{AppError, Result};

use super::handle::WslFsHandle;

pub async fn mkdir(handle: &WslFsHandle, path: &str) -> Result<()> {
    // Parent may be (or sit under) a folder link.
    let unc = handle.physical_unc_keep_leaf(path).await?;
    fs::create_dir(&unc)
        .await
        .map_err(|e| AppError::Sftp(format!("mkdir: {e}")))
}

pub async fn rmdir(handle: &WslFsHandle, path: &str) -> Result<()> {
    // Keep the leaf: the UI only sends real directories here (links are
    // always unlinked via `remove`), so never resolve *through* the leaf.
    let unc = handle.physical_unc_keep_leaf(path).await?;
    fs::remove_dir(&unc)
        .await
        .map_err(|e| AppError::Sftp(format!("rmdir: {e}")))
}

/// Remove a file or a symlink — the link itself, never its target. Runs
/// `rm` inside the distro rather than `remove_file` on the 9P UNC path:
/// Windows sees a WSL symlink to a directory as a directory reparse
/// point, so `remove_file` refuses it. Plain `rm` (no `-r`) still refuses
/// real directories, so this can't delete a tree.
///
/// Differences from the old Windows-side delete, accepted on purpose:
/// errors read "rm: cannot remove …" (wrapped as `remove: wsl.exe exited
/// 1: …`), and a write-protected file is removed like any other — POSIX
/// semantics, where deleting depends on the directory's permissions, not
/// the file's. `rm` never prompts here: stdin isn't a terminal.
pub async fn remove(handle: &WslFsHandle, path: &str) -> Result<()> {
    handle
        .wsl_exec(&["rm", "--", path])
        .await
        .map(|_| ())
        .map_err(|e| AppError::Sftp(format!("remove: {e}")))
}

pub async fn rename(handle: &WslFsHandle, from: &str, to: &str) -> Result<()> {
    // Resolve the parents only: renaming a link must rename the link.
    let unc_from = handle.physical_unc_keep_leaf(from).await?;
    let unc_to = handle.physical_unc_keep_leaf(to).await?;
    fs::rename(&unc_from, &unc_to)
        .await
        .map_err(|e| AppError::Sftp(format!("rename: {e}")))
}

pub async fn chmod(handle: &WslFsHandle, path: &str, mode: u32) -> Result<()> {
    // Only the low 12 bits are the permission word that `chmod` cares
    // about (high nibble is file type, not settable). Format as octal
    // with up to four digits so setuid/setgid/sticky come along.
    let octal = format!("{:o}", mode & 0o7777);
    handle.wsl_exec(&["chmod", &octal, "--", path]).await?;
    Ok(())
}

pub async fn realpath(handle: &WslFsHandle, path: &str) -> Result<String> {
    // The SFTP pane calls realpath(".") on open to discover $HOME; the
    // cached home is materially cheaper than another wsl.exe round
    // trip, and the answer can never change for a connection.
    if path == "." {
        return handle.home().await;
    }
    let out = handle.wsl_exec(&["realpath", "-m", "--", path]).await?;
    Ok(out.trim().to_string())
}
