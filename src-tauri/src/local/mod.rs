//! Local PTY backend — WSL distros and local shells (cmd / pwsh / powershell).
//!
//! Uses `portable-pty`'s ConPTY-backed implementation on Windows. Data flow
//! mirrors the SSH path: the reader thread pushes PTY bytes into the
//! frontend's IPC output channel (created before `local_connect` runs, so
//! ConPTY's prompt — written microseconds after spawn — can never outrun a
//! listener; the frontend buffers until its keystroke handler is wired) and
//! emits `ssh:close:<id>` on EOF. `local_write` / `local_resize` /
//! `local_disconnect` commands route through the per-connection mpsc to a
//! writer thread that owns the `MasterPty`.
//!
//! The child process is not explicitly waited on — dropping the stdin
//! sender closes the mpsc, the writer thread exits, the master drops,
//! ConPTY kills the child, and the reader thread observes EOF and emits
//! the close event.

pub mod registry;
pub mod shells;
mod spawn;

pub use registry::{Connection, LocalInput, LocalRegistry, WslMeta};
pub use spawn::spawn_from_session;
