//! Local PTY backend — WSL distros and local shells (cmd / pwsh / powershell).
//!
//! Uses `portable-pty`'s ConPTY-backed implementation on Windows. Event flow
//! mirrors the SSH path so the frontend can use a single subscribe helper:
//! the reader thread emits `ssh:data:<id>` for bytes and `ssh:close:<id>`
//! on EOF, and `local_write` / `local_resize` / `local_disconnect` commands
//! route through the per-connection mpsc to a writer thread that owns the
//! `MasterPty`.
//!
//! The child process is not explicitly waited on — dropping the stdin
//! sender closes the mpsc, the writer thread exits, the master drops,
//! ConPTY kills the child, and the reader thread observes EOF and emits
//! the close event.

use std::io::{Read, Write};
use std::thread;

use portable_pty::{native_pty_system, CommandBuilder, PtySize};
use tauri::{AppHandle, Emitter};
use tokio::sync::mpsc;

use crate::error::{AppError, Result};
use crate::state::AppState;

pub mod registry;

pub use registry::{Connection, LocalInput, LocalRegistry};

pub struct SpawnRequest {
    /// "wsl" or "local".
    pub kind:     String,
    /// For wsl: distro name (empty = default distro). For local: shell
    /// short-name ('cmd' / 'pwsh' / 'powershell') or absolute path.
    pub program:  String,
    /// For wsl: optional user (empty = distro default). For local: optional
    /// starting directory (empty = process cwd).
    pub extra:    String,
    pub cols:     u16,
    pub rows:     u16,
}

pub struct SpawnOutcome {
    pub connection_id: u64,
}

pub async fn spawn(
    state: &AppState,
    app: AppHandle,
    req: SpawnRequest,
) -> Result<SpawnOutcome> {
    let cmd = build_command(&req.kind, &req.program, &req.extra)?;
    let id = state.local.alloc_id();

    let pair = native_pty_system()
        .openpty(PtySize {
            rows: req.rows,
            cols: req.cols,
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(|e| AppError::Ssh(format!("pty open: {e}")))?;

    let _child = pair
        .slave
        .spawn_command(cmd)
        .map_err(|e| AppError::Ssh(format!("spawn: {e}")))?;
    // Releasing the slave lets ConPTY signal EOF on the reader when the
    // child exits. We don't retain the child handle: dropping the master
    // (via writer-thread exit) terminates the child on Windows anyway.
    drop(pair.slave);

    let mut reader = pair
        .master
        .try_clone_reader()
        .map_err(|e| AppError::Ssh(format!("reader: {e}")))?;
    let mut writer = pair
        .master
        .take_writer()
        .map_err(|e| AppError::Ssh(format!("writer: {e}")))?;
    let master = pair.master;

    // Reader: bytes → "ssh:data:<id>"; EOF → "ssh:close:<id>".
    let reader_app = app.clone();
    let reader_id = id;
    thread::spawn(move || {
        let mut buf = vec![0u8; 8192];
        loop {
            match reader.read(&mut buf) {
                Ok(0) => break,
                Ok(n) => {
                    let payload: Vec<u8> = buf[..n].to_vec();
                    let _ = reader_app.emit(&format!("ssh:data:{reader_id}"), payload);
                }
                Err(_) => break,
            }
        }
        let _ = reader_app.emit::<Option<i32>>(&format!("ssh:close:{reader_id}"), None);
    });

    // Writer / resize: blocking_recv on tokio mpsc from a std thread.
    let (tx, mut rx) = mpsc::unbounded_channel::<LocalInput>();
    thread::spawn(move || {
        let master = master;
        while let Some(input) = rx.blocking_recv() {
            match input {
                LocalInput::Bytes(bytes) => {
                    if writer.write_all(&bytes).is_err() {
                        break;
                    }
                    let _ = writer.flush();
                }
                LocalInput::Resize { cols, rows } => {
                    let _ = master.resize(PtySize {
                        rows,
                        cols,
                        pixel_width: 0,
                        pixel_height: 0,
                    });
                }
                LocalInput::Close => break,
            }
        }
        // Drop order: writer → master → ConPTY handles → child terminates.
        drop(writer);
        drop(master);
    });

    state.local.insert(Connection { id, stdin: tx }).await;
    Ok(SpawnOutcome { connection_id: id })
}

fn build_command(kind: &str, program: &str, extra: &str) -> Result<CommandBuilder> {
    match kind {
        "wsl" => {
            let mut c = CommandBuilder::new("wsl.exe");
            if !program.trim().is_empty() {
                c.arg("-d");
                c.arg(program.trim());
            }
            if !extra.trim().is_empty() {
                c.arg("-u");
                c.arg(extra.trim());
            }
            Ok(c)
        }
        "local" => {
            let exe = match program.trim() {
                "" | "cmd" => "cmd.exe",
                "pwsh" => "pwsh.exe",
                "powershell" => "powershell.exe",
                other => other,
            };
            let mut c = CommandBuilder::new(exe);
            if exe.ends_with("pwsh.exe") || exe.ends_with("powershell.exe") {
                c.arg("-NoLogo");
            }
            let cwd = extra.trim();
            if !cwd.is_empty() {
                c.cwd(cwd);
            }
            Ok(c)
        }
        _ => Err(AppError::Validation(format!("invalid session kind: {kind}"))),
    }
}

/// Convenience for the Tauri command layer. Takes a `i64` session id and
/// resolves the DB row to assemble a `SpawnRequest`.
pub async fn spawn_from_session(
    state: &AppState,
    app: AppHandle,
    session_id: i64,
    cols: u16,
    rows: u16,
) -> Result<SpawnOutcome> {
    let session = crate::db::sessions::get(&state.db, session_id).await?;
    spawn(
        state,
        app,
        SpawnRequest {
            kind: session.session_kind.clone(),
            program: session.host.clone(),
            extra: session.username.clone(),
            cols,
            rows,
        },
    )
    .await
}
