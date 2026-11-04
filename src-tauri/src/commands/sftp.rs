use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};

use serde::{Deserialize, Serialize};
use tauri::State;

use crate::error::{AppError, Result};
use crate::sftp::{FileBrowser, SftpHandle};
use crate::state::AppState;
use crate::wslfs::{self, WslFsHandle};

/// Monotonic id for transfers. The frontend correlates progress events to a
/// ticket by subscribing to `sftp:transfer:{id}`.
static TRANSFER_ID: AtomicU64 = AtomicU64::new(0);

fn next_transfer_id() -> u64 {
    TRANSFER_ID.fetch_add(1, Ordering::Relaxed) + 1
}

/// Handle returned to the frontend so it can subscribe to progress before
/// the transfer task has started emitting.
#[derive(Serialize)]
pub struct TransferTicket {
    pub transfer_id: u64,
}

/// One entry returned by `sftp_list`. Mirrors the fields the UI needs to
/// render a directory row: name + full path for navigation, type flags,
/// size, mtime (unix seconds), and the POSIX mode bits.
///
/// Symlinks are resolved: `is_dir` is true for a directory *or* a link
/// that resolves to one (so it opens, sorts and accepts drops like a
/// folder), `size` is the target's size for a link to a file, and
/// `is_symlink` / `link_target` / `link_broken` describe the link itself.
/// `mode` stays the link's own mode bits (`lrwxrwxrwx`).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct SftpEntry {
    pub name: String,
    pub full_path: String,
    pub is_dir: bool,
    pub is_symlink: bool,
    pub size: u64,
    pub mtime_unix: i64,
    pub mode: u32,
    /// Where a symlink points, as stored in the link (may be relative).
    /// `None` for non-links or when the server won't read it.
    #[serde(default)]
    pub link_target: Option<String>,
    /// A symlink whose target doesn't exist or can't be reached.
    #[serde(default)]
    pub link_broken: bool,
}

/// What resolving one symlink found.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LinkResolution {
    /// Target is a directory.
    Dir,
    /// Target is a file (or other non-directory) of this size.
    File { size: u64 },
    /// Target doesn't exist or can't be stat'd.
    Broken,
}

/// Fold a resolved link back into its entry. Shared by the SFTP and WSL
/// listings so both present links identically.
pub fn apply_link_resolution(e: &mut SftpEntry, res: LinkResolution, target: Option<String>) {
    e.link_target = target;
    match res {
        LinkResolution::Dir => {
            e.is_dir = true;
            e.link_broken = false;
        }
        LinkResolution::File { size } => {
            e.is_dir = false;
            e.size = size;
            e.link_broken = false;
        }
        LinkResolution::Broken => {
            e.is_dir = false;
            e.link_broken = true;
        }
    }
}

/// List one remote directory over SFTP: entries with symlinks resolved,
/// sorted directories-first (links to directories included), then by name.
async fn list_sftp_dir(s: &russh_sftp::client::SftpSession, path: &str) -> Result<Vec<SftpEntry>> {
    let dir = s
        .read_dir(path)
        .await
        .map_err(|e| AppError::Sftp(e.to_string()))?;
    let mut acc: Vec<SftpEntry> = Vec::new();
    for entry in dir {
        let name = entry.file_name();
        let attrs = entry.metadata();
        let full = if path.ends_with('/') {
            format!("{path}{name}")
        } else {
            format!("{path}/{name}")
        };
        acc.push(SftpEntry {
            name,
            full_path: full,
            is_dir: attrs.is_dir(),
            is_symlink: attrs.is_symlink(),
            size: attrs.size.unwrap_or(0),
            mtime_unix: attrs.mtime.map(|m| m as i64).unwrap_or(0),
            mode: attrs.permissions.unwrap_or(0),
            link_target: None,
            link_broken: false,
        });
    }
    resolve_sftp_links(s, &mut acc).await;
    acc.sort_by(|a, b| b.is_dir.cmp(&a.is_dir).then_with(|| a.name.cmp(&b.name)));
    Ok(acc)
}

/// Symlinks resolved concurrently per listing. SFTP requests pipeline on
/// one channel, so this turns N round trips into ~N/16 without flooding
/// the server.
const LINK_RESOLVE_CONCURRENCY: usize = 16;

/// Resolve every symlink in `acc` with `stat` (follows the link) and
/// `readlink`. A failed `stat` marks the link broken; a failed `readlink`
/// just leaves the target unknown.
async fn resolve_sftp_links(s: &russh_sftp::client::SftpSession, acc: &mut [SftpEntry]) {
    use futures_util::stream::{self, StreamExt};
    let links: Vec<(usize, String)> = acc
        .iter()
        .enumerate()
        .filter(|(_, e)| e.is_symlink)
        .map(|(i, e)| (i, e.full_path.clone()))
        .collect();
    if links.is_empty() {
        return;
    }
    let resolved: Vec<(usize, LinkResolution, Option<String>)> = stream::iter(links)
        .map(|(i, path)| async move {
            let res = match s.metadata(path.clone()).await {
                Ok(m) if m.is_dir() => LinkResolution::Dir,
                Ok(m) => LinkResolution::File {
                    size: m.size.unwrap_or(0),
                },
                Err(_) => LinkResolution::Broken,
            };
            let target = s.read_link(path).await.ok();
            (i, res, target)
        })
        .buffer_unordered(LINK_RESOLVE_CONCURRENCY)
        .collect()
        .await;
    for (i, res, target) in resolved {
        apply_link_resolution(&mut acc[i], res, target);
    }
}

/// Open the file browser for `connection_id`. Routes by connection kind:
/// SSH connections get a real SFTP subsystem channel; WSL connections get a
/// Plan-9-backed adapter that translates Linux paths to `\\wsl.localhost`
/// UNC and shells out for POSIX-aware ops. Plain local shells (cmd, pwsh)
/// have no file browser — calling this for them returns `NotFound`.
#[tauri::command]
pub async fn sftp_open(state: State<'_, AppState>, connection_id: u64) -> Result<()> {
    super::require_unlocked(&state).await?;

    // SSH path first — established connections live in state.ssh.
    if let Some(conn) = state.ssh.get(connection_id).await {
        let channel = conn
            .ssh_handle
            .channel_open_session()
            .await
            .map_err(|e| AppError::Ssh(e.to_string()))?;
        channel
            .request_subsystem(true, "sftp")
            .await
            .map_err(|e| AppError::Ssh(e.to_string()))?;
        let sftp = russh_sftp::client::SftpSession::new(channel.into_stream())
            .await
            .map_err(|e| AppError::Sftp(format!("init: {e}")))?;
        state
            .sftp
            .insert(connection_id, FileBrowser::Sftp(SftpHandle::new(sftp)))
            .await;
        return Ok(());
    }

    // WSL path — look up the local PTY connection and confirm it was
    // spawned with WSL metadata. Plain local shells (cmd/pwsh) land
    // here without `wsl_meta` and are rejected.
    if let Some(local) = state.local.get(connection_id).await {
        let meta = local.wsl_meta.as_ref().ok_or_else(|| {
            AppError::Validation("file browser is only available for SSH and WSL sessions".into())
        })?;
        let handle = WslFsHandle::new(meta.distro.clone(), meta.user.clone());
        state
            .sftp
            .insert(connection_id, FileBrowser::Wsl(handle))
            .await;
        return Ok(());
    }

    Err(AppError::NotFound)
}

/// Fetch a directory listing. Sorted directories-first, name-ascending,
/// with `.`/`..` filtered.
#[tauri::command]
pub async fn sftp_list(
    state: State<'_, AppState>,
    connection_id: u64,
    path: String,
) -> Result<Vec<SftpEntry>> {
    super::require_unlocked(&state).await?;
    let path = crate::sftp::normalise_remote_path(&path)?;
    let browser = require_browser(&state, connection_id).await?;
    match &*browser {
        FileBrowser::Sftp(handle) => {
            handle
                .with_session(async move |s: &mut russh_sftp::client::SftpSession| {
                    list_sftp_dir(s, &path).await
                })
                .await
        }
        FileBrowser::Wsl(handle) => wslfs::list::list(handle, &path).await,
    }
}

#[tauri::command]
pub async fn sftp_mkdir(
    state: State<'_, AppState>,
    connection_id: u64,
    path: String,
) -> Result<()> {
    super::require_unlocked(&state).await?;
    let path = crate::sftp::normalise_remote_path(&path)?;
    let browser = require_browser(&state, connection_id).await?;
    match &*browser {
        FileBrowser::Sftp(handle) => {
            handle
                .with_session(
                    async move |s: &mut russh_sftp::client::SftpSession| -> Result<()> {
                        s.create_dir(&path)
                            .await
                            .map_err(|e| AppError::Sftp(e.to_string()))
                    },
                )
                .await
        }
        FileBrowser::Wsl(handle) => wslfs::ops::mkdir(handle, &path).await,
    }
}

#[tauri::command]
pub async fn sftp_rmdir(
    state: State<'_, AppState>,
    connection_id: u64,
    path: String,
) -> Result<()> {
    super::require_unlocked(&state).await?;
    let path = crate::sftp::normalise_remote_path(&path)?;
    let browser = require_browser(&state, connection_id).await?;
    match &*browser {
        FileBrowser::Sftp(handle) => {
            handle
                .with_session(
                    async move |s: &mut russh_sftp::client::SftpSession| -> Result<()> {
                        s.remove_dir(&path)
                            .await
                            .map_err(|e| AppError::Sftp(e.to_string()))
                    },
                )
                .await
        }
        FileBrowser::Wsl(handle) => wslfs::ops::rmdir(handle, &path).await,
    }
}

#[tauri::command]
pub async fn sftp_remove(
    state: State<'_, AppState>,
    connection_id: u64,
    path: String,
) -> Result<()> {
    super::require_unlocked(&state).await?;
    let path = crate::sftp::normalise_remote_path(&path)?;
    let browser = require_browser(&state, connection_id).await?;
    match &*browser {
        FileBrowser::Sftp(handle) => {
            handle
                .with_session(
                    async move |s: &mut russh_sftp::client::SftpSession| -> Result<()> {
                        s.remove_file(&path)
                            .await
                            .map_err(|e| AppError::Sftp(e.to_string()))
                    },
                )
                .await
        }
        FileBrowser::Wsl(handle) => wslfs::ops::remove(handle, &path).await,
    }
}

#[tauri::command]
pub async fn sftp_rename(
    state: State<'_, AppState>,
    connection_id: u64,
    from: String,
    to: String,
) -> Result<()> {
    super::require_unlocked(&state).await?;
    let from = crate::sftp::normalise_remote_path(&from)?;
    let to = crate::sftp::normalise_remote_path(&to)?;
    let browser = require_browser(&state, connection_id).await?;
    match &*browser {
        FileBrowser::Sftp(handle) => {
            handle
                .with_session(
                    async move |s: &mut russh_sftp::client::SftpSession| -> Result<()> {
                        s.rename(&from, &to)
                            .await
                            .map_err(|e| AppError::Sftp(e.to_string()))
                    },
                )
                .await
        }
        FileBrowser::Wsl(handle) => wslfs::ops::rename(handle, &from, &to).await,
    }
}

#[tauri::command]
pub async fn sftp_chmod(
    state: State<'_, AppState>,
    connection_id: u64,
    path: String,
    mode: u32,
) -> Result<()> {
    super::require_unlocked(&state).await?;
    let path = crate::sftp::normalise_remote_path(&path)?;
    let browser = require_browser(&state, connection_id).await?;
    match &*browser {
        FileBrowser::Sftp(handle) => {
            handle
                .with_session(
                    async move |s: &mut russh_sftp::client::SftpSession| -> Result<()> {
                        // Only the permission bits are mutated — leave
                        // size/uid/gid/atime/mtime untouched on the server.
                        let mut attrs = russh_sftp::protocol::FileAttributes::empty();
                        attrs.permissions = Some(mode);
                        s.set_metadata(&path, attrs)
                            .await
                            .map_err(|e| AppError::Sftp(e.to_string()))
                    },
                )
                .await
        }
        FileBrowser::Wsl(handle) => wslfs::ops::chmod(handle, &path, mode).await,
    }
}

#[tauri::command]
pub async fn sftp_realpath(
    state: State<'_, AppState>,
    connection_id: u64,
    path: String,
) -> Result<String> {
    super::require_unlocked(&state).await?;
    let path = crate::sftp::normalise_remote_path(&path)?;
    let browser = require_browser(&state, connection_id).await?;
    match &*browser {
        FileBrowser::Sftp(handle) => {
            handle
                .with_session(
                    async move |s: &mut russh_sftp::client::SftpSession| -> Result<String> {
                        s.canonicalize(&path)
                            .await
                            .map_err(|e| AppError::Sftp(e.to_string()))
                    },
                )
                .await
        }
        FileBrowser::Wsl(handle) => wslfs::ops::realpath(handle, &path).await,
    }
}

async fn require_browser(
    state: &State<'_, AppState>,
    connection_id: u64,
) -> Result<std::sync::Arc<FileBrowser>> {
    state
        .sftp
        .get(connection_id)
        .await
        .ok_or(AppError::NotFound)
}

/// Start a streaming upload. Returns a ticket immediately; progress flows
/// through `sftp:transfer:{transfer_id}` events. The final event has
/// `done = true` (success) or populates `error` (failure).
#[tauri::command]
pub async fn sftp_upload(
    state: State<'_, AppState>,
    app: tauri::AppHandle,
    connection_id: u64,
    local_path: String,
    remote_path: String,
) -> Result<TransferTicket> {
    super::require_unlocked(&state).await?;
    let remote_path = crate::sftp::normalise_remote_path(&remote_path)?;
    let browser = require_browser(&state, connection_id).await?;
    let transfer_id = next_transfer_id();

    tokio::spawn(async move {
        match &*browser {
            FileBrowser::Sftp(handle) => {
                let _ = crate::sftp::transfer::upload(
                    &app,
                    handle,
                    transfer_id,
                    &PathBuf::from(&local_path),
                    &remote_path,
                )
                .await;
            }
            FileBrowser::Wsl(handle) => {
                let _ = crate::wslfs::transfer::upload(
                    &app,
                    handle,
                    transfer_id,
                    &PathBuf::from(&local_path),
                    &remote_path,
                )
                .await;
            }
        }
    });
    Ok(TransferTicket { transfer_id })
}

/// Hard cap on drag-drop upload size. The Chromium webview holds the whole
/// file in memory before shipping it to Rust, and ballooning past a few
/// hundred MB OOM-risks the webview. Users with larger uploads should hit
/// the Upload button (native file dialog → path-based streaming).
const MAX_DRAG_DROP_BYTES: usize = 256 * 1024 * 1024;

/// Drag-drop upload variant: file contents are passed inline (the webview
/// can't expose a local path on Chromium for security reasons, so the
/// frontend reads the File via FileReader and sends bytes here).
#[tauri::command]
pub async fn sftp_upload_bytes(
    state: State<'_, AppState>,
    app: tauri::AppHandle,
    connection_id: u64,
    remote_path: String,
    bytes: Vec<u8>,
) -> Result<TransferTicket> {
    super::require_unlocked(&state).await?;
    if bytes.len() > MAX_DRAG_DROP_BYTES {
        return Err(AppError::Validation(format!(
            "drag-drop upload capped at {} MB; use the Upload button for larger files",
            MAX_DRAG_DROP_BYTES / (1024 * 1024)
        )));
    }
    let remote_path = crate::sftp::normalise_remote_path(&remote_path)?;
    let browser = require_browser(&state, connection_id).await?;
    let transfer_id = next_transfer_id();

    tokio::spawn(async move {
        match &*browser {
            FileBrowser::Sftp(handle) => {
                let _ = crate::sftp::transfer::upload_bytes(
                    &app,
                    handle,
                    transfer_id,
                    &bytes,
                    &remote_path,
                )
                .await;
            }
            FileBrowser::Wsl(handle) => {
                let _ = crate::wslfs::transfer::upload_bytes(
                    &app,
                    handle,
                    transfer_id,
                    &bytes,
                    &remote_path,
                )
                .await;
            }
        }
    });
    Ok(TransferTicket { transfer_id })
}

/// Start a streaming download. See `sftp_upload` for the progress-event model.
#[tauri::command]
pub async fn sftp_download(
    state: State<'_, AppState>,
    app: tauri::AppHandle,
    connection_id: u64,
    remote_path: String,
    local_path: String,
) -> Result<TransferTicket> {
    super::require_unlocked(&state).await?;
    let remote_path = crate::sftp::normalise_remote_path(&remote_path)?;
    let browser = require_browser(&state, connection_id).await?;
    let transfer_id = next_transfer_id();

    tokio::spawn(async move {
        match &*browser {
            FileBrowser::Sftp(handle) => {
                let _ = crate::sftp::transfer::download(
                    &app,
                    handle,
                    transfer_id,
                    &remote_path,
                    &PathBuf::from(&local_path),
                )
                .await;
            }
            FileBrowser::Wsl(handle) => {
                let _ = crate::wslfs::transfer::download(
                    &app,
                    handle,
                    transfer_id,
                    &remote_path,
                    &PathBuf::from(&local_path),
                )
                .await;
            }
        }
    });
    Ok(TransferTicket { transfer_id })
}

/// Streaming upload — phase A3 of issue #28. Lifts the 256 MB cap by
/// letting the frontend slice the dropped `File` and ship chunks one
/// at a time. Returns an `upload_id` the frontend uses to push
/// chunks; remember to call `sftp_upload_finish` (or
/// `sftp_upload_abort` on cancel) to release the file handle.
#[tauri::command]
pub async fn sftp_upload_begin(
    state: State<'_, AppState>,
    connection_id: u64,
    remote_path: String,
) -> Result<u64> {
    super::require_unlocked(&state).await?;
    let remote_path = crate::sftp::normalise_remote_path(&remote_path)?;
    let browser = require_browser(&state, connection_id).await?;
    state.upload_streams.begin(browser, remote_path).await
}

/// Append one chunk. Returns when the chunk has been acknowledged by
/// the writer task — surfaces per-chunk remote write errors so the
/// frontend can stop slicing rather than pushing chunks into a
/// already-failed upload. Bounded channel depth means this awaits if
/// the SFTP link is slower than the frontend.
#[tauri::command]
pub async fn sftp_upload_chunk(
    state: State<'_, AppState>,
    upload_id: u64,
    bytes: Vec<u8>,
) -> Result<()> {
    super::require_unlocked(&state).await?;
    state.upload_streams.chunk(upload_id, bytes).await
}

#[tauri::command]
pub async fn sftp_upload_finish(state: State<'_, AppState>, upload_id: u64) -> Result<()> {
    super::require_unlocked(&state).await?;
    state.upload_streams.finish(upload_id).await
}

#[tauri::command]
pub async fn sftp_upload_abort(state: State<'_, AppState>, upload_id: u64) -> Result<()> {
    super::require_unlocked(&state).await?;
    state.upload_streams.abort(upload_id).await
}

// NOTE on SFTP drag-out: an earlier iteration shipped an OLE
// IDataObject + IStream drag-source so the user could drag a remote
// file from the SFTP pane directly into Windows Explorer. That code
// hit an unworkable WebView2 limitation — `DoDragDrop` from the host
// process always returns E_FAIL once WebView2 is loaded (process-wide
// claim by Chromium's drag controller), and the HTML5
// `dragstart` → OS drag conversion also never fires from a Tauri
// webview. There is no current Microsoft-supplied API surface to
// initiate an OS-level virtual-file drag from a WebView2 host. We
// retain the right-click → Download… save-dialog path in the SFTP
// pane as the supported download UX until WebView2 exposes a drag
// API or we move off WebView2.

#[cfg(test)]
mod link_tests {
    use super::{LinkResolution, SftpEntry, apply_link_resolution};

    fn link() -> SftpEntry {
        SftpEntry {
            name: "current".into(),
            full_path: "/srv/app/current".into(),
            is_dir: false,
            is_symlink: true,
            size: 27,
            mtime_unix: 1,
            mode: 0o120777,
            link_target: None,
            link_broken: false,
        }
    }

    #[test]
    fn dir_link_becomes_a_directory() {
        let mut e = link();
        apply_link_resolution(&mut e, LinkResolution::Dir, Some("releases/42".into()));
        assert!(e.is_dir && e.is_symlink && !e.link_broken);
        assert_eq!(e.link_target.as_deref(), Some("releases/42"));
        assert_eq!(e.mode, 0o120777, "mode stays the link's own");
    }

    #[test]
    fn file_link_takes_the_target_size() {
        let mut e = link();
        apply_link_resolution(
            &mut e,
            LinkResolution::File { size: 4096 },
            Some("/etc/hosts".into()),
        );
        assert!(!e.is_dir && !e.link_broken);
        assert_eq!(e.size, 4096);
    }

    #[test]
    fn dangling_link_is_broken_not_a_dir() {
        let mut e = link();
        e.is_dir = true;
        apply_link_resolution(&mut e, LinkResolution::Broken, Some("/gone".into()));
        assert!(!e.is_dir && e.link_broken);
        assert_eq!(e.link_target.as_deref(), Some("/gone"));
    }
}

/// Runs the real listing code against OpenSSH's `sftp-server` over its
/// stdin/stdout (no sshd needed). Skipped where `sftp-server` isn't
/// installed; GitHub's Ubuntu runners ship it.
#[cfg(all(test, unix))]
mod sftp_server_tests {
    use super::list_sftp_dir;

    fn sftp_server() -> Option<String> {
        if let Ok(p) = std::env::var("EZTERM_SFTP_SERVER") {
            return Some(p);
        }
        [
            "/usr/lib/openssh/sftp-server",
            "/usr/libexec/openssh/sftp-server",
            "/usr/libexec/sftp-server",
            "/usr/lib/ssh/sftp-server",
        ]
        .into_iter()
        .find(|p| std::path::Path::new(p).exists())
        .map(str::to_string)
    }

    #[tokio::test]
    async fn lists_and_resolves_symlinks_over_real_sftp() {
        let Some(bin) = sftp_server() else {
            eprintln!("sftp-server not installed; skipping");
            return;
        };
        let dir = tempfile::tempdir().unwrap();
        let d = dir.path();
        std::fs::create_dir(d.join("releases")).unwrap();
        std::fs::write(d.join("notes.txt"), b"0123456789").unwrap();
        std::os::unix::fs::symlink("releases", d.join("current")).unwrap();
        std::os::unix::fs::symlink("notes.txt", d.join("readme")).unwrap();
        std::os::unix::fs::symlink("/nonexistent/x", d.join("dangling")).unwrap();

        let mut child = tokio::process::Command::new(bin)
            .stdin(std::process::Stdio::piped())
            .stdout(std::process::Stdio::piped())
            .kill_on_drop(true)
            .spawn()
            .unwrap();
        let io = tokio::io::join(child.stdout.take().unwrap(), child.stdin.take().unwrap());
        let s = russh_sftp::client::SftpSession::new(io).await.unwrap();

        let path = d.to_string_lossy().into_owned();
        let list = list_sftp_dir(&s, &path).await.unwrap();
        let by = |n: &str| list.iter().find(|e| e.name == n).unwrap().clone();

        let current = by("current");
        assert!(current.is_symlink && current.is_dir && !current.link_broken);
        assert_eq!(current.link_target.as_deref(), Some("releases"));

        let readme = by("readme");
        assert!(readme.is_symlink && !readme.is_dir && !readme.link_broken);
        assert_eq!(readme.size, 10);
        assert_eq!(readme.link_target.as_deref(), Some("notes.txt"));

        let dangling = by("dangling");
        assert!(dangling.is_symlink && !dangling.is_dir && dangling.link_broken);

        // Links to directories sort with the directories.
        let names: Vec<&str> = list.iter().map(|e| e.name.as_str()).collect();
        let first_file = names.iter().position(|n| *n == "dangling").unwrap();
        assert!(names.iter().position(|n| *n == "current").unwrap() < first_file);

        // And can be listed through.
        let inside = list_sftp_dir(&s, &format!("{path}/current")).await;
        assert!(inside.is_ok());
    }
}
