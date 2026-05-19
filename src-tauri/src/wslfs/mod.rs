//! WSL filesystem adapter — exposes the same surface as the SSH SFTP
//! path so the existing `sftp_*` Tauri commands can dispatch
//! transparently for both connection kinds. The frontend always works
//! in Linux-style paths; Windows UNC (`\\wsl.localhost\<distro>\…`)
//! translation is confined to `handle.rs`.
//!
//! Layout mirrors `sftp/` deliberately:
//!   - `handle`  : per-connection state (distro / user / cached $HOME)
//!   - `list`    : directory listings via `wsl.exe ls -la`
//!   - `ops`     : mkdir / rmdir / remove / rename / chmod / realpath
//!   - `transfer`: chunked upload / download with progress events
//!   - `upload_stream` lives in `sftp/upload_stream.rs` (single
//!     registry, dispatch by `FileBrowser` enum)

pub mod handle;
pub mod list;
pub mod ops;
pub mod transfer;

pub use handle::WslFsHandle;
