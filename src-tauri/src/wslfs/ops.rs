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
    let unc = handle.linux_to_unc(path);
    fs::create_dir(&unc)
        .await
        .map_err(|e| AppError::Sftp(format!("mkdir: {e}")))
}

pub async fn rmdir(handle: &WslFsHandle, path: &str) -> Result<()> {
    let unc = handle.linux_to_unc(path);
    fs::remove_dir(&unc)
        .await
        .map_err(|e| AppError::Sftp(format!("rmdir: {e}")))
}

pub async fn remove(handle: &WslFsHandle, path: &str) -> Result<()> {
    let unc = handle.linux_to_unc(path);
    fs::remove_file(&unc)
        .await
        .map_err(|e| AppError::Sftp(format!("remove: {e}")))
}

pub async fn rename(handle: &WslFsHandle, from: &str, to: &str) -> Result<()> {
    let unc_from = handle.linux_to_unc(from);
    let unc_to = handle.linux_to_unc(to);
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
    let out = handle
        .wsl_exec(&["realpath", "-m", "--", path])
        .await?;
    Ok(out.trim().to_string())
}
