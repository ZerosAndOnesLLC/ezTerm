//! Native OS drag source for SFTP drag-out. The webview can't supply
//! Explorer / Finder / file managers with a real path to a remote file,
//! so we implement the OS-native drag protocols ourselves and stream
//! bytes on demand:
//!
//! - **Windows**: OLE drag with [`IDataObject`] exposing
//!   `CFSTR_FILEDESCRIPTORW` + `CFSTR_FILECONTENTS`. The actual byte
//!   stream is wrapped in an [`IStream`]. See `win.rs`.
//! - **macOS**: `NSFilePromiseProvider` + delegate (phase B5 of #28 —
//!   not yet implemented).
//! - **Linux**: XDS (X11) and `wl_data_source` (Wayland) (phase B6 of
//!   #28 — not yet implemented).
//!
//! This module is the cross-platform entry point. On unsupported
//! platforms every entry point returns an `Unsupported` error so the
//! rest of the app builds and runs without a `#[cfg]` cascade at every
//! call site.

#[cfg_attr(windows, allow(unused_imports))]
use crate::error::{AppError, Result};

#[cfg(windows)]
pub mod win;

/// Start an OS-native drag of `name`'s content payload (in-memory
/// bytes). Blocks the current thread until the user drops (or
/// cancels). Spawning a dedicated thread is the caller's
/// responsibility — `DoDragDrop` pumps the message loop, which we
/// don't want to do from a tokio worker.
///
/// Used by the `drag_test_file` dev command. The real drag-from-SFTP
/// path goes through `start_sftp_drag`, which uses a streaming
/// `IStream` instead of buffering the whole file in memory.
#[allow(dead_code)] // dev-only test path
pub fn start_file_drag(name: String, bytes: Vec<u8>) -> Result<DragOutcome> {
    #[cfg(windows)]
    {
        win::start_file_drag(name, bytes)
    }
    #[cfg(not(windows))]
    {
        let _ = (name, bytes);
        Err(AppError::Validation(
            "drag-out is not yet implemented on this platform (see issue #28 phases B5/B6)".into(),
        ))
    }
}

/// Start an OS-native drag of one or more remote SFTP files. Each
/// file is streamed: the COM `IStream` we hand Explorer pulls bytes
/// from a per-file tokio reader task as the OS reads them, with no
/// in-memory buffering of file contents.
///
/// `remote_paths` lists the paths to drag (one or more). `runtime` is
/// a tokio handle captured before spawning the drag thread so we can
/// drive async SFTP reads from a non-tokio context. Blocks until the
/// user drops or cancels.
#[cfg_attr(not(windows), allow(unused_variables))]
pub fn start_sftp_drag(
    handle: std::sync::Arc<crate::sftp::SftpHandle>,
    remote_paths: Vec<String>,
    runtime: tokio::runtime::Handle,
) -> Result<DragOutcome> {
    #[cfg(windows)]
    {
        win::start_sftp_drag(handle, remote_paths, runtime)
    }
    #[cfg(not(windows))]
    {
        Err(AppError::Validation(
            "drag-out is not yet implemented on this platform (see issue #28 phases B5/B6)".into(),
        ))
    }
}

/// What the OS reported when the drag finished. The caller can use
/// this to decide whether to refresh the SFTP listing (drop happened)
/// or just unwind silently (user cancelled).
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "snake_case")]
#[allow(dead_code)] // exposed via drag_test_file return; consumer arrives with B2.
pub enum DragOutcome {
    /// User dropped the file onto a valid target.
    Dropped,
    /// User cancelled (Escape, or released over a non-target).
    Cancelled,
}

#[cfg(not(windows))]
impl From<()> for DragOutcome {
    fn from(_: ()) -> Self { DragOutcome::Cancelled }
}

/// Convenience for the test command: a wrapper that surfaces an error
/// uniformly on all platforms.
#[allow(dead_code)]
pub fn ensure_supported() -> Result<()> {
    #[cfg(windows)]
    {
        Ok(())
    }
    #[cfg(not(windows))]
    {
        Err(AppError::Validation(
            "drag-out is currently Windows-only; macOS and Linux land in phases B5/B6 of issue #28".into(),
        ))
    }
}
