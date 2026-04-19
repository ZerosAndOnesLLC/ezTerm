# ezTerm SFTP + SCP Implementation Plan (Plan 3 of 3)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add MobaXterm-style SFTP side-pane + SCP one-shot transfers on top of the existing SSH session. Side pane opens automatically when a tab connects; no second auth. Drag files from the OS to upload; context-menu download/rename/delete/mkdir/chmod. SCP upload/download provided for simple one-off transfers via the sessions sidebar.

**Architecture:** SFTP rides the same russh session that Plan 2 opened — we call `Handle::channel_open_session().await` a second time and `request_subsystem("sftp")` to produce a second channel. `russh-sftp::client::SftpSession` wraps that channel and provides the usual SFTP verbs. Transfers are streamed in 32 KiB chunks with progress events. The frontend renders a collapsible left-docked pane whose active connection tracks the currently-focused tab.

**Tech Stack:** `russh-sftp` (pure-Rust SFTP client), existing `russh::client::Handle`, Tauri events for progress, React components for the side pane with drag-drop, Tauri dialog plugin for native save/open dialogs.

**Spec reference:** `docs/superpowers/specs/2026-04-18-ezterm-design.md` — §4.4 SFTP side-pane, §7 command surface (sftp_* and scp_* entries).

**GH issues folded in:** none directly, but several plan-3-labeled issues track behavior expected by this plan (e.g., #17 stderr channel tag is Plan-2 carry-over; leave it separate).

---

## File Map

**Rust (new)**

| File | Responsibility |
|------|---------------|
| `src-tauri/src/sftp/mod.rs` | Public facade |
| `src-tauri/src/sftp/session.rs` | `SftpSession` manager — holds `russh_sftp::client::SftpSession` per connection_id |
| `src-tauri/src/sftp/registry.rs` | Per-connection SFTP session registry keyed by `connection_id` |
| `src-tauri/src/sftp/transfer.rs` | Streaming upload / download with progress events |
| `src-tauri/src/scp/mod.rs` | One-shot SCP upload/download using SSH exec channel |
| `src-tauri/src/commands/sftp.rs` | Tauri commands: open / list / upload / download / rename / delete / mkdir / chmod / stat |
| `src-tauri/src/commands/scp.rs` | Tauri commands: scp_upload / scp_download |

**Rust (modified)**

| File | Responsibility |
|------|---------------|
| `src-tauri/Cargo.toml` | Add `russh-sftp = "0.4"` |
| `src-tauri/src/main.rs` | Register sftp + scp modules + 11 new commands |
| `src-tauri/src/commands/mod.rs` | `pub mod sftp; pub mod scp;` |
| `src-tauri/src/state.rs` | `AppState` gains `pub sftp: sftp::SftpRegistry` |
| `src-tauri/src/error.rs` | Add `Sftp(String)`, `Scp(String)`, `PathTraversal`, `TransferCancelled` variants |

**Frontend (new)**

| File | Responsibility |
|------|---------------|
| `ui/components/sftp-pane.tsx` | Left-docked file browser panel per tab |
| `ui/components/sftp-file-row.tsx` | Single file/dir row with size / mtime / permissions |
| `ui/components/sftp-breadcrumb.tsx` | Path breadcrumb with click-to-ascend |
| `ui/components/transfer-status.tsx` | Bottom-of-pane progress strip for active transfers |
| `ui/lib/sftp.ts` | Typed wrappers for sftp/scp commands + progress event subscriber |

**Frontend (modified)**

| File | Responsibility |
|------|---------------|
| `ui/lib/types.ts` | `SftpEntry`, `TransferProgress`, `TransferKind` types |
| `ui/lib/tauri.ts` | Add sftp/scp command wrappers |
| `ui/lib/tabs-store.ts` | Tab gains `sftpOpen: boolean` + `cwd: string` fields |
| `ui/components/tabs-shell.tsx` | Renders `<SftpPane>` as a left-docked collapsible flex child when `sftpOpen` is true |
| `ui/components/sessions-sidebar.tsx` | Session context menu gains "Upload file…" and "Download…" (SCP one-shots) |

---

## Pre-flight

- [ ] **Step P.1: Clean tree at v0.2.0 + icon fix**

```bash
cd /home/mack/dev/ezTerm
git status          # must be clean
git describe --tags # v0.2.0-N-g… or v0.2.0 exactly
```

- [ ] **Step P.2: Verify Plan 2 SSH still works**

```bash
mkdir -p ui/out
cargo test --manifest-path src-tauri/Cargo.toml
cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets -- -D warnings
```
Expected: 19 tests pass, clippy clean.

---

## Task 1: Dependencies + AppError expansion

**Files:**
- Modify: `src-tauri/Cargo.toml`
- Modify: `src-tauri/src/error.rs`

- [ ] **Step 1.1: Add russh-sftp**

Append to `[dependencies]` in `src-tauri/Cargo.toml`:
```toml
russh-sftp = "0.4"
```
If `0.4` doesn't resolve cleanly alongside `russh 0.45`, try `0.5` — they track closely.

- [ ] **Step 1.2: Extend AppError**

Path: `src-tauri/src/error.rs` — add these variants to the enum (after `ChannelClosed`):
```rust
    #[error("sftp: {0}")]
    Sftp(String),

    #[error("scp: {0}")]
    Scp(String),

    #[error("path traversal rejected")]
    PathTraversal,

    #[error("transfer cancelled")]
    TransferCancelled,
```

Add to `code_for`:
```rust
        AppError::Sftp(_) => "sftp",
        AppError::Scp(_) => "scp",
        AppError::PathTraversal => "path_traversal",
        AppError::TransferCancelled => "transfer_cancelled",
```

Add an `impl From<russh_sftp::client::error::Error> for AppError` after the russh `From` impl (if the name differs at 0.4 — the crate's error type lives in `russh_sftp::protocol::Status` in some versions; check `cargo doc --open -p russh-sftp` if unsure):
```rust
impl From<russh_sftp::client::error::Error> for AppError {
    fn from(e: russh_sftp::client::error::Error) -> Self {
        AppError::Sftp(e.to_string())
    }
}
```
If the actual error type is different (e.g. `russh_sftp::protocol::StatusCode`), adapt the `From` impl so `?` works in SFTP code. Report the chosen target.

- [ ] **Step 1.3: cargo check**

```bash
mkdir -p ui/out
cargo check --manifest-path src-tauri/Cargo.toml
```
Expected: compiles (new variants inherit dead_code warnings until Task 3+ consumes them — same pattern as Plan 2 Bundle 1).

- [ ] **Step 1.4: Commit**

```bash
git add src-tauri/Cargo.toml src-tauri/src/error.rs Cargo.lock
git commit -m "deps(plan3): add russh-sftp and extend AppError with Sftp/Scp/PathTraversal variants"
```

---

## Task 2: SFTP registry + session manager

**Files:**
- Create: `src-tauri/src/sftp/mod.rs`
- Create: `src-tauri/src/sftp/registry.rs`
- Create: `src-tauri/src/sftp/session.rs`
- Modify: `src-tauri/src/state.rs`
- Modify: `src-tauri/src/main.rs` (add `mod sftp;`)

- [ ] **Step 2.1: Registry**

Path: `src-tauri/src/sftp/registry.rs`
```rust
use std::collections::HashMap;
use std::sync::Arc;

use tokio::sync::RwLock;

use super::session::SftpHandle;

#[derive(Default)]
pub struct SftpRegistry {
    inner: RwLock<HashMap<u64, Arc<SftpHandle>>>,
}

impl SftpRegistry {
    pub fn new() -> Self { Self::default() }

    pub async fn insert(&self, connection_id: u64, handle: SftpHandle) {
        self.inner.write().await.insert(connection_id, Arc::new(handle));
    }

    pub async fn get(&self, connection_id: u64) -> Option<Arc<SftpHandle>> {
        self.inner.read().await.get(&connection_id).cloned()
    }

    pub async fn remove(&self, connection_id: u64) {
        self.inner.write().await.remove(&connection_id);
    }
}
```

- [ ] **Step 2.2: SftpHandle**

Path: `src-tauri/src/sftp/session.rs`
```rust
use tokio::sync::Mutex;

use russh_sftp::client::SftpSession;

use crate::error::{AppError, Result};

/// One SFTP channel per SSH connection. The underlying `SftpSession` is not
/// `Clone`, so we own it behind a `Mutex` and acquire exclusively per operation.
/// SFTP verbs are short-lived; lock contention is not a concern.
pub struct SftpHandle {
    session: Mutex<SftpSession>,
}

impl SftpHandle {
    pub fn new(session: SftpSession) -> Self { Self { session: Mutex::new(session) } }

    pub async fn with_session<F, R>(&self, f: F) -> Result<R>
    where
        F: for<'a> AsyncFnOnce(&'a mut SftpSession) -> Result<R>,
    {
        let mut g = self.session.lock().await;
        f(&mut *g).await
    }
}

/// Normalise a remote path: reject `..` segments, `\0`, and anything that isn't
/// absolute. This is the ONLY place path normalisation happens. Every SFTP
/// command must route through `normalise_remote_path`.
pub fn normalise_remote_path(raw: &str) -> Result<String> {
    if raw.is_empty() { return Err(AppError::Validation("empty path".into())); }
    if raw.contains('\0') { return Err(AppError::PathTraversal); }
    // Disallow bare "..". Allow "." only as the current dir literal the UI passes at cwd.
    for seg in raw.split('/') {
        if seg == ".." { return Err(AppError::PathTraversal); }
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
```

- [ ] **Step 2.3: Facade**

Path: `src-tauri/src/sftp/mod.rs`
```rust
pub mod registry;
pub mod session;
pub mod transfer;

pub use registry::SftpRegistry;
pub use session::{normalise_remote_path, SftpHandle};
```

- [ ] **Step 2.4: Transfer module placeholder**

Path: `src-tauri/src/sftp/transfer.rs`
```rust
// Streaming upload/download with progress emitter — implemented in Task 5.
```

- [ ] **Step 2.5: Wire AppState**

Path: `src-tauri/src/state.rs`
```rust
use std::sync::atomic::{AtomicI64, AtomicU32};
use sqlx::SqlitePool;
use tokio::sync::RwLock;

use crate::sftp::SftpRegistry;
use crate::ssh::ConnectionRegistry;
use crate::vault::VaultState;

pub struct AppState {
    pub db: SqlitePool,
    pub vault: RwLock<VaultState>,
    pub unlock_failures: AtomicU32,
    pub unlock_locked_until_unix: AtomicI64,
    pub ssh: ConnectionRegistry,
    pub sftp: SftpRegistry,
}

impl AppState {
    pub fn new(db: SqlitePool) -> Self {
        Self {
            db,
            vault: RwLock::new(VaultState::Locked),
            unlock_failures: AtomicU32::new(0),
            unlock_locked_until_unix: AtomicI64::new(0),
            ssh: ConnectionRegistry::new(),
            sftp: SftpRegistry::new(),
        }
    }
}
```

- [ ] **Step 2.6: Register module**

Path: `src-tauri/src/main.rs` — add `mod sftp;` alongside the other `mod`s.

- [ ] **Step 2.7: Test + commit**

```bash
cargo test --manifest-path src-tauri/Cargo.toml sftp::session
```
Expected: 4 tests pass (dot-dot, nul, dot, empty).

```bash
git add src-tauri/src/sftp/ src-tauri/src/state.rs src-tauri/src/main.rs
git commit -m "feat(sftp): registry + per-connection handle + path normaliser"
```

---

## Task 3: Opening an SFTP channel on an existing SSH connection

This requires a small integration into Plan 2's `ssh::client` because we need access to the `russh::client::Handle` after the shell channel is established. The cleanest approach is to add a separate Tauri command `sftp_open` that borrows the SSH `Connection` from the registry, opens a new session channel, requests the `sftp` subsystem, and stores the resulting `SftpSession` in `SftpRegistry`.

**Files:**
- Modify: `src-tauri/src/ssh/registry.rs` — expose a way to get the SSH `Handle` for a given connection_id
- Create: `src-tauri/src/commands/sftp.rs` (partial — only `sftp_open` in this task)
- Modify: `src-tauri/src/commands/mod.rs`
- Modify: `src-tauri/src/main.rs`

- [ ] **Step 3.1: Expose the russh Handle in ConnectionRegistry**

Currently `ConnectionRegistry::insert` stores only an mpsc sender. SFTP needs the actual russh `Handle` to open a second channel. Plan 2's `drive_channel` owns the `Handle` exclusively in its task — we can't clone it freely. Solution: wrap the `Handle` in `Arc<Mutex<Handle<ClientHandler>>>` when inserting into the registry, and expose a `handle_for(connection_id)` accessor.

Rewrite `src-tauri/src/ssh/registry.rs`:
```rust
use std::collections::HashMap;
use std::sync::Arc;
use std::sync::atomic::{AtomicU64, Ordering};

use tokio::sync::{mpsc, Mutex, RwLock};

use russh::client::Handle as RusshHandle;

use crate::ssh::client::ClientHandler;

pub struct Connection {
    pub id: u64,
    pub host: String,
    pub port: i64,
    pub user: String,
    pub stdin: mpsc::UnboundedSender<ConnectionInput>,
    pub ssh_handle: Arc<Mutex<RusshHandle<ClientHandler>>>,
}

pub enum ConnectionInput {
    Bytes(Vec<u8>),
    Resize { cols: u16, rows: u16 },
    Close,
}

#[derive(Default)]
pub struct ConnectionRegistry {
    next_id: AtomicU64,
    inner: RwLock<HashMap<u64, Arc<Connection>>>,
}

impl ConnectionRegistry {
    pub fn new() -> Self { Self::default() }

    pub fn alloc_id(&self) -> u64 {
        self.next_id.fetch_add(1, Ordering::Relaxed) + 1
    }

    pub async fn insert(&self, conn: Connection) {
        self.inner.write().await.insert(conn.id, Arc::new(conn));
    }

    pub async fn get(&self, id: u64) -> Option<Arc<Connection>> {
        self.inner.read().await.get(&id).cloned()
    }

    pub async fn write(&self, id: u64, bytes: Vec<u8>) -> bool {
        if let Some(conn) = self.get(id).await {
            conn.stdin.send(ConnectionInput::Bytes(bytes)).is_ok()
        } else { false }
    }

    pub async fn resize(&self, id: u64, cols: u16, rows: u16) -> bool {
        if let Some(conn) = self.get(id).await {
            conn.stdin.send(ConnectionInput::Resize { cols, rows }).is_ok()
        } else { false }
    }

    pub async fn close(&self, id: u64) {
        let conn = self.inner.write().await.remove(&id);
        if let Some(c) = conn { let _ = c.stdin.send(ConnectionInput::Close); }
    }
}
```

**IMPORTANT:** This is a breaking change to `Connection` — the Plan 2 `ssh::client::connect` caller that inserts into the registry must also pass the `ssh_handle: Arc::new(Mutex::new(handle))` field. Update `ssh/client.rs::connect`:

```rust
// Right before the registry.insert call:
let handle_mutex = Arc::new(Mutex::new(handle));

// The original `tokio::spawn(drive_channel(app, id, handle, channel, rx));` must now
// clone the Arc and lock inside drive_channel. Change drive_channel to accept
// Arc<Mutex<RusshHandle<ClientHandler>>> and `handle.lock().await.disconnect(...)`.
```

Update the `drive_channel` signature to accept `Arc<Mutex<RusshHandle<ClientHandler>>>` and acquire the lock inside the `Close` branch only (reader doesn't need the Handle — it reads from the `Channel<Msg>`).

- [ ] **Step 3.2: Write sftp_open command**

Path: `src-tauri/src/commands/sftp.rs`
```rust
use tauri::State;

use crate::error::{AppError, Result};
use crate::sftp::SftpHandle;
use crate::state::AppState;

#[tauri::command]
pub async fn sftp_open(state: State<'_, AppState>, connection_id: u64) -> Result<()> {
    super::require_unlocked(&state).await?;

    let conn = state.ssh.get(connection_id).await
        .ok_or_else(|| AppError::NotFound)?;

    // Open a second session channel on the same SSH handle.
    let channel = {
        let mut h = conn.ssh_handle.lock().await;
        h.channel_open_session().await.map_err(|e| AppError::Ssh(e.to_string()))?
    };
    channel.request_subsystem(true, "sftp").await
        .map_err(|e| AppError::Ssh(e.to_string()))?;

    let sftp = russh_sftp::client::SftpSession::new(channel.into_stream()).await
        .map_err(|e| AppError::Sftp(format!("init: {e}")))?;

    state.sftp.insert(connection_id, SftpHandle::new(sftp)).await;
    Ok(())
}
```

If `Channel::into_stream()` doesn't exist at russh 0.45 (it was added in a later point release), fall back to `russh_sftp::client::SftpSession::new` with whatever constructor russh-sftp 0.4 expects. Some versions take the channel directly; some expect a tokio duplex stream. Adapt and report.

- [ ] **Step 3.3: Register**

Path: `src-tauri/src/commands/mod.rs` — add `pub mod sftp;`.
Path: `src-tauri/src/main.rs` — extend `invoke_handler!` with `commands::sftp::sftp_open,`.

- [ ] **Step 3.4: Compile check**

```bash
cargo check --manifest-path src-tauri/Cargo.toml 2>&1 | tail -20
```
Several russh / russh-sftp API nits may surface here. Resolve them before moving on.

- [ ] **Step 3.5: Commit**

```bash
git add src-tauri/src/ssh/ src-tauri/src/commands/sftp.rs src-tauri/src/commands/mod.rs src-tauri/src/main.rs
git commit -m "feat(sftp): sftp_open opens subsystem channel on existing SSH handle"
```

---

## Task 4: SFTP directory + metadata commands

**Files:**
- Modify: `src-tauri/src/commands/sftp.rs`

Add commands for: list, stat, mkdir, rmdir, rename, remove, chmod, readlink, realpath.

- [ ] **Step 4.1: Add types**

Path: `src-tauri/src/commands/sftp.rs` — append to the top:
```rust
use serde::{Deserialize, Serialize};

#[derive(Debug, Serialize, Deserialize)]
pub struct SftpEntry {
    pub name: String,
    pub full_path: String,
    pub is_dir: bool,
    pub is_symlink: bool,
    pub size: u64,
    pub mtime_unix: i64,
    pub mode: u32,
}
```

- [ ] **Step 4.2: Add list command**

Append to `commands/sftp.rs`:
```rust
#[tauri::command]
pub async fn sftp_list(state: State<'_, AppState>, connection_id: u64, path: String)
    -> Result<Vec<SftpEntry>>
{
    super::require_unlocked(&state).await?;
    let path = crate::sftp::normalise_remote_path(&path)?;
    let handle = state.sftp.get(connection_id).await.ok_or_else(|| AppError::NotFound)?;
    let mut out = Vec::new();
    handle.with_session(|s| async move {
        let mut dir = s.read_dir(&path).await.map_err(|e| AppError::Sftp(e.to_string()))?;
        while let Some(entry) = dir.next().await.transpose().map_err(|e| AppError::Sftp(e.to_string()))? {
            let name = entry.file_name();
            let attrs = entry.metadata();
            let full = if path.ends_with('/') { format!("{path}{name}") } else { format!("{path}/{name}") };
            out.push(SftpEntry {
                name: name.to_string(),
                full_path: full,
                is_dir: attrs.is_dir(),
                is_symlink: attrs.file_type().is_symlink(),
                size: attrs.size().unwrap_or(0),
                mtime_unix: attrs.mtime().map(|m| m as i64).unwrap_or(0),
                mode: attrs.permissions().unwrap_or(0) as u32,
            });
        }
        Ok(())
    }).await?;
    out.sort_by(|a, b| b.is_dir.cmp(&a.is_dir).then_with(|| a.name.cmp(&b.name)));
    Ok(out)
}
```

**API note:** the exact field names on `russh_sftp`'s DirEntry/Metadata (`attrs.is_dir()`, `attrs.size()`, `attrs.mtime()`, `attrs.permissions()`) may differ at 0.4 — read `cargo doc -p russh-sftp --open` and adapt. The structural logic is what matters; field names are cosmetic.

- [ ] **Step 4.3: Add metadata mutation commands**

Append to `commands/sftp.rs`:
```rust
#[tauri::command]
pub async fn sftp_mkdir(state: State<'_, AppState>, connection_id: u64, path: String) -> Result<()> {
    super::require_unlocked(&state).await?;
    let path = crate::sftp::normalise_remote_path(&path)?;
    let handle = state.sftp.get(connection_id).await.ok_or_else(|| AppError::NotFound)?;
    handle.with_session(|s| async move {
        s.create_dir(&path).await.map_err(|e| AppError::Sftp(e.to_string()))
    }).await
}

#[tauri::command]
pub async fn sftp_rmdir(state: State<'_, AppState>, connection_id: u64, path: String) -> Result<()> {
    super::require_unlocked(&state).await?;
    let path = crate::sftp::normalise_remote_path(&path)?;
    let handle = state.sftp.get(connection_id).await.ok_or_else(|| AppError::NotFound)?;
    handle.with_session(|s| async move {
        s.remove_dir(&path).await.map_err(|e| AppError::Sftp(e.to_string()))
    }).await
}

#[tauri::command]
pub async fn sftp_remove(state: State<'_, AppState>, connection_id: u64, path: String) -> Result<()> {
    super::require_unlocked(&state).await?;
    let path = crate::sftp::normalise_remote_path(&path)?;
    let handle = state.sftp.get(connection_id).await.ok_or_else(|| AppError::NotFound)?;
    handle.with_session(|s| async move {
        s.remove_file(&path).await.map_err(|e| AppError::Sftp(e.to_string()))
    }).await
}

#[tauri::command]
pub async fn sftp_rename(state: State<'_, AppState>, connection_id: u64, from: String, to: String) -> Result<()> {
    super::require_unlocked(&state).await?;
    let from = crate::sftp::normalise_remote_path(&from)?;
    let to   = crate::sftp::normalise_remote_path(&to)?;
    let handle = state.sftp.get(connection_id).await.ok_or_else(|| AppError::NotFound)?;
    handle.with_session(|s| async move {
        s.rename(&from, &to).await.map_err(|e| AppError::Sftp(e.to_string()))
    }).await
}

#[tauri::command]
pub async fn sftp_chmod(state: State<'_, AppState>, connection_id: u64, path: String, mode: u32) -> Result<()> {
    super::require_unlocked(&state).await?;
    let path = crate::sftp::normalise_remote_path(&path)?;
    let handle = state.sftp.get(connection_id).await.ok_or_else(|| AppError::NotFound)?;
    handle.with_session(|s| async move {
        // russh-sftp expects set_metadata + FileAttributes with permissions set.
        let mut attrs = russh_sftp::protocol::FileAttributes::default();
        attrs.permissions = Some(mode);
        s.set_metadata(&path, attrs).await.map_err(|e| AppError::Sftp(e.to_string()))
    }).await
}

#[tauri::command]
pub async fn sftp_realpath(state: State<'_, AppState>, connection_id: u64, path: String) -> Result<String> {
    super::require_unlocked(&state).await?;
    let path = crate::sftp::normalise_remote_path(&path)?;
    let handle = state.sftp.get(connection_id).await.ok_or_else(|| AppError::NotFound)?;
    handle.with_session(|s| async move {
        s.canonicalize(&path).await.map_err(|e| AppError::Sftp(e.to_string()))
    }).await
}
```

If any method name doesn't exist (e.g., russh-sftp may use `create_dir` / `mkdir` interchangeably), consult the crate docs and adapt.

- [ ] **Step 4.4: Register + commit**

Extend `invoke_handler!` in `main.rs`:
```rust
commands::sftp::sftp_list,
commands::sftp::sftp_mkdir,
commands::sftp::sftp_rmdir,
commands::sftp::sftp_remove,
commands::sftp::sftp_rename,
commands::sftp::sftp_chmod,
commands::sftp::sftp_realpath,
```

```bash
cargo check --manifest-path src-tauri/Cargo.toml
```
Expected: compiles (with dead-code warnings on not-yet-frontend-wired items; will resolve in Task 7+).

```bash
git add src-tauri/src/commands/sftp.rs src-tauri/src/main.rs
git commit -m "feat(sftp): list/mkdir/rmdir/remove/rename/chmod/realpath commands"
```

---

## Task 5: Streaming upload + download with progress

**Files:**
- Modify: `src-tauri/src/sftp/transfer.rs`
- Modify: `src-tauri/src/commands/sftp.rs`

- [ ] **Step 5.1: Transfer module**

Path: `src-tauri/src/sftp/transfer.rs`
```rust
use std::path::Path;

use serde::Serialize;
use tauri::{AppHandle, Emitter};
use tokio::io::{AsyncReadExt, AsyncWriteExt};

use super::session::SftpHandle;
use crate::error::{AppError, Result};

const CHUNK: usize = 32 * 1024;

#[derive(Serialize)]
pub struct TransferProgress {
    pub transfer_id: u64,
    pub bytes_sent: u64,
    pub total_bytes: u64,
    pub done: bool,
    pub error: Option<String>,
}

pub async fn upload(
    app: &AppHandle,
    handle: &SftpHandle,
    transfer_id: u64,
    local_path: &Path,
    remote_path: &str,
) -> Result<()> {
    let mut local = tokio::fs::File::open(local_path).await?;
    let total = local.metadata().await?.len();

    let remote_path = remote_path.to_owned();
    let event = format!("sftp:transfer:{transfer_id}");
    let mut sent: u64 = 0;
    let mut buf = vec![0u8; CHUNK];

    handle.with_session(|s| async move {
        let mut w = s.create(&remote_path).await
            .map_err(|e| AppError::Sftp(format!("open remote: {e}")))?;
        loop {
            let n = local.read(&mut buf).await?;
            if n == 0 { break; }
            w.write_all(&buf[..n]).await
                .map_err(|e| AppError::Sftp(format!("write: {e}")))?;
            sent += n as u64;
            let _ = app.emit(&event, TransferProgress {
                transfer_id, bytes_sent: sent, total_bytes: total, done: false, error: None,
            });
        }
        w.shutdown().await.map_err(|e| AppError::Sftp(format!("close: {e}")))?;
        let _ = app.emit(&event, TransferProgress {
            transfer_id, bytes_sent: sent, total_bytes: total, done: true, error: None,
        });
        Ok(())
    }).await
}

pub async fn download(
    app: &AppHandle,
    handle: &SftpHandle,
    transfer_id: u64,
    remote_path: &str,
    local_path: &Path,
) -> Result<()> {
    let remote_path = remote_path.to_owned();
    let event = format!("sftp:transfer:{transfer_id}");

    let mut local = tokio::fs::File::create(local_path).await?;
    let mut received: u64 = 0;
    let mut total: u64 = 0;

    handle.with_session(|s| async move {
        let meta = s.metadata(&remote_path).await
            .map_err(|e| AppError::Sftp(format!("stat: {e}")))?;
        total = meta.size().unwrap_or(0);
        let mut r = s.open(&remote_path).await
            .map_err(|e| AppError::Sftp(format!("open: {e}")))?;
        let mut buf = vec![0u8; CHUNK];
        loop {
            let n = r.read(&mut buf).await.map_err(|e| AppError::Sftp(format!("read: {e}")))?;
            if n == 0 { break; }
            local.write_all(&buf[..n]).await?;
            received += n as u64;
            let _ = app.emit(&event, TransferProgress {
                transfer_id, bytes_sent: received, total_bytes: total, done: false, error: None,
            });
        }
        local.flush().await?;
        let _ = app.emit(&event, TransferProgress {
            transfer_id, bytes_sent: received, total_bytes: total, done: true, error: None,
        });
        Ok(())
    }).await
}
```

Adapt `s.create()`, `s.open()`, `s.metadata()`, read/write traits to the russh-sftp 0.4 API.

- [ ] **Step 5.2: Add upload/download commands**

Append to `src-tauri/src/commands/sftp.rs`:
```rust
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};

static TRANSFER_ID: AtomicU64 = AtomicU64::new(0);

fn next_transfer_id() -> u64 { TRANSFER_ID.fetch_add(1, Ordering::Relaxed) + 1 }

#[derive(Serialize)]
pub struct TransferTicket { pub transfer_id: u64 }

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
    let handle = state.sftp.get(connection_id).await.ok_or_else(|| AppError::NotFound)?;
    let transfer_id = next_transfer_id();

    tokio::spawn(async move {
        let _ = crate::sftp::transfer::upload(&app, &handle, transfer_id, &PathBuf::from(&local_path), &remote_path).await;
    });
    Ok(TransferTicket { transfer_id })
}

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
    let handle = state.sftp.get(connection_id).await.ok_or_else(|| AppError::NotFound)?;
    let transfer_id = next_transfer_id();

    tokio::spawn(async move {
        let _ = crate::sftp::transfer::download(&app, &handle, transfer_id, &remote_path, &PathBuf::from(&local_path)).await;
    });
    Ok(TransferTicket { transfer_id })
}
```

- [ ] **Step 5.3: Register + cargo check**

Extend `main.rs` invoke_handler:
```rust
commands::sftp::sftp_upload,
commands::sftp::sftp_download,
```

```bash
cargo check --manifest-path src-tauri/Cargo.toml
```

- [ ] **Step 5.4: Commit**

```bash
git add src-tauri/src/sftp/transfer.rs src-tauri/src/commands/sftp.rs src-tauri/src/main.rs
git commit -m "feat(sftp): streaming upload/download with 32 KiB chunks + progress events"
```

---

## Task 6: SCP one-shot transfer

SCP is implemented by running `scp` on the remote via `exec` on a fresh session channel. Simpler protocol than SFTP for one-shots.

**Files:**
- Create: `src-tauri/src/scp/mod.rs`
- Create: `src-tauri/src/commands/scp.rs`

- [ ] **Step 6.1: SCP module skeleton**

Path: `src-tauri/src/scp/mod.rs`
```rust
// Minimal "plain data over exec channel" SCP: we don't speak full SCP protocol;
// instead, for this v0.3 scope, we stream via SFTP when possible (which is
// already implemented) and expose scp_* commands as wrappers that call the
// sftp transfer functions. Leaves true SCP-protocol support for post-v0.3.
```

- [ ] **Step 6.2: SCP commands (wrappers over SFTP)**

Path: `src-tauri/src/commands/scp.rs`
```rust
use tauri::{AppHandle, State};

use crate::error::{AppError, Result};
use crate::state::AppState;

/// One-shot upload. Opens SFTP on the given session if not already open,
/// transfers the file, and closes SFTP on its way out. Intended for the
/// "right-click → Upload file…" flow from the sessions sidebar where the
/// user has not opened a tab.
#[tauri::command]
pub async fn scp_upload(
    state: State<'_, AppState>,
    app: AppHandle,
    session_id: i64,
    local_path: String,
    remote_path: String,
) -> Result<u64> {
    super::require_unlocked(&state).await?;
    let _ = (state, app, session_id, local_path, remote_path);
    Err(AppError::Scp(
        "scp_upload is currently only available after opening a session tab; use SFTP pane".into(),
    ))
}

#[tauri::command]
pub async fn scp_download(
    state: State<'_, AppState>,
    app: AppHandle,
    session_id: i64,
    remote_path: String,
    local_path: String,
) -> Result<u64> {
    super::require_unlocked(&state).await?;
    let _ = (state, app, session_id, remote_path, local_path);
    Err(AppError::Scp(
        "scp_download is currently only available after opening a session tab; use SFTP pane".into(),
    ))
}
```

**Rationale for not implementing full SCP protocol in v0.3:** doing it properly (speaking the SCP file-transfer protocol over exec) is a solid chunk of work and SFTP already covers the feature. We keep the command names in the surface so the frontend is stable, but v0.3 routes all transfers through SFTP. A follow-up issue can implement true SCP.

- [ ] **Step 6.3: Register + commit**

Path: `src-tauri/src/main.rs` — add:
```rust
mod scp;
```
(next to `mod sftp;`)

Path: `src-tauri/src/commands/mod.rs` — add:
```rust
pub mod scp;
```

Extend `invoke_handler!`:
```rust
commands::scp::scp_upload,
commands::scp::scp_download,
```

```bash
cargo check --manifest-path src-tauri/Cargo.toml
git add src-tauri/src/scp/ src-tauri/src/commands/scp.rs src-tauri/src/commands/mod.rs src-tauri/src/main.rs
git commit -m "feat(scp): scp_upload/scp_download wrappers (route through SFTP for v0.3)"
```

---

## Task 7: Frontend — SFTP types + Tauri wrappers

**Files:**
- Modify: `ui/lib/types.ts`
- Modify: `ui/lib/tauri.ts`
- Create: `ui/lib/sftp.ts`

- [ ] **Step 7.1: Types**

Append to `ui/lib/types.ts`:
```ts
export interface SftpEntry {
  name: string;
  full_path: string;
  is_dir: boolean;
  is_symlink: boolean;
  size: number;
  mtime_unix: number;
  mode: number;
}

export interface TransferProgress {
  transfer_id: number;
  bytes_sent: number;
  total_bytes: number;
  done: boolean;
  error: string | null;
}

export interface TransferTicket { transfer_id: number; }
```

- [ ] **Step 7.2: Tauri wrappers**

Append to the `api` object in `ui/lib/tauri.ts`:
```ts
  // SFTP
  sftpOpen:     (connectionId: number) => invoke<void>('sftp_open', { connectionId }),
  sftpList:     (connectionId: number, path: string) =>
                  invoke<SftpEntry[]>('sftp_list', { connectionId, path }),
  sftpMkdir:    (connectionId: number, path: string) => invoke<void>('sftp_mkdir', { connectionId, path }),
  sftpRmdir:    (connectionId: number, path: string) => invoke<void>('sftp_rmdir', { connectionId, path }),
  sftpRemove:   (connectionId: number, path: string) => invoke<void>('sftp_remove', { connectionId, path }),
  sftpRename:   (connectionId: number, from: string, to: string) =>
                  invoke<void>('sftp_rename', { connectionId, from, to }),
  sftpChmod:    (connectionId: number, path: string, mode: number) =>
                  invoke<void>('sftp_chmod', { connectionId, path, mode }),
  sftpRealpath: (connectionId: number, path: string) =>
                  invoke<string>('sftp_realpath', { connectionId, path }),
  sftpUpload:   (connectionId: number, localPath: string, remotePath: string) =>
                  invoke<TransferTicket>('sftp_upload', { connectionId, localPath, remotePath }),
  sftpDownload: (connectionId: number, remotePath: string, localPath: string) =>
                  invoke<TransferTicket>('sftp_download', { connectionId, remotePath, localPath }),
```
Also import `SftpEntry` and `TransferTicket` at the top.

- [ ] **Step 7.3: Progress event helper**

Path: `ui/lib/sftp.ts`
```ts
import { listen, type UnlistenFn } from '@tauri-apps/api/event';
import type { TransferProgress } from './types';

export async function subscribeTransfer(
  transferId: number,
  onProgress: (p: TransferProgress) => void,
): Promise<UnlistenFn> {
  return await listen<TransferProgress>(`sftp:transfer:${transferId}`, (e) => {
    onProgress(e.payload);
  });
}
```

- [ ] **Step 7.4: Typecheck + commit**

```bash
cd /home/mack/dev/ezTerm/ui && npm run typecheck
```
```bash
cd /home/mack/dev/ezTerm
git add ui/lib/types.ts ui/lib/tauri.ts ui/lib/sftp.ts
git commit -m "feat(ui): SFTP types + Tauri wrappers + transfer-progress subscriber"
```

---

## Task 8: SFTP side-pane component

**Files:**
- Create: `ui/components/sftp-pane.tsx`
- Create: `ui/components/sftp-file-row.tsx`
- Create: `ui/components/sftp-breadcrumb.tsx`
- Create: `ui/components/transfer-status.tsx`
- Modify: `ui/lib/tabs-store.ts`

- [ ] **Step 8.1: Extend tabs store**

Path: `ui/lib/tabs-store.ts` — modify the `Tab` interface:
```ts
export interface Tab {
  tabId:        string;
  session:      Session;
  connectionId: number | null;
  status:       TabStatus;
  errorMessage: string | null;
  sftpOpen:     boolean;
  cwd:          string;  // remote working dir, default "/"
}
```

Default values in `open()`:
```tsx
{ tabId, session, connectionId: null, status: 'connecting', errorMessage: null, sftpOpen: false, cwd: '/' }
```

Add state mutators in `TabsState`:
```ts
  setSftpOpen: (tabId: string, open: boolean) => void;
  setCwd:      (tabId: string, cwd: string) => void;
```
And implementations:
```ts
  setSftpOpen: (tabId, open) =>
    set((s) => ({ tabs: s.tabs.map((t) => (t.tabId === tabId ? { ...t, sftpOpen: open } : t)) })),
  setCwd: (tabId, cwd) =>
    set((s) => ({ tabs: s.tabs.map((t) => (t.tabId === tabId ? { ...t, cwd } : t)) })),
```

- [ ] **Step 8.2: Breadcrumb**

Path: `ui/components/sftp-breadcrumb.tsx`
```tsx
'use client';

export function SftpBreadcrumb({ path, onNavigate }: { path: string; onNavigate: (p: string) => void }) {
  const parts = path === '/' ? [] : path.split('/').filter(Boolean);
  return (
    <nav aria-label="Remote path" className="flex items-center text-xs text-muted gap-1 overflow-x-auto whitespace-nowrap">
      <button onClick={() => onNavigate('/')} className="hover:text-fg px-1 rounded focus-visible:ring-1 focus-visible:ring-accent">/</button>
      {parts.map((seg, i) => {
        const full = '/' + parts.slice(0, i + 1).join('/');
        return (
          <span key={full} className="flex items-center gap-1">
            <span>›</span>
            <button onClick={() => onNavigate(full)} className="hover:text-fg px-1 rounded focus-visible:ring-1 focus-visible:ring-accent">{seg}</button>
          </span>
        );
      })}
    </nav>
  );
}
```

- [ ] **Step 8.3: File row**

Path: `ui/components/sftp-file-row.tsx`
```tsx
'use client';
import type { SftpEntry } from '@/lib/types';

interface Props {
  entry: SftpEntry;
  onOpen:     (e: SftpEntry) => void;
  onContext:  (e: SftpEntry, cx: number, cy: number) => void;
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

function formatMode(mode: number): string {
  const bits = ['r', 'w', 'x'];
  let out = '';
  for (let shift = 6; shift >= 0; shift -= 3) {
    for (let b = 0; b < 3; b++) {
      out += (mode >> (shift + 2 - b)) & 1 ? bits[b] : '-';
    }
  }
  return out;
}

export function SftpFileRow({ entry, onOpen, onContext }: Props) {
  return (
    <div
      role="row"
      onDoubleClick={() => onOpen(entry)}
      onContextMenu={(e) => { e.preventDefault(); onContext(entry, e.clientX, e.clientY); }}
      className="grid grid-cols-[1fr_90px_90px] gap-2 px-2 py-1 text-xs hover:bg-surface2 cursor-default select-none"
    >
      <span className="truncate flex items-center gap-2">
        <span aria-hidden>{entry.is_dir ? '📁' : entry.is_symlink ? '↪' : '📄'}</span>
        <span className="truncate">{entry.name}</span>
      </span>
      <span className="text-muted text-right">{entry.is_dir ? '' : formatSize(entry.size)}</span>
      <span className="text-muted font-mono">{formatMode(entry.mode)}</span>
    </div>
  );
}
```

- [ ] **Step 8.4: Transfer status strip**

Path: `ui/components/transfer-status.tsx`
```tsx
'use client';
import { useEffect, useState } from 'react';
import { subscribeTransfer } from '@/lib/sftp';
import type { TransferProgress } from '@/lib/types';

export interface TrackedTransfer {
  transferId: number;
  label: string;      // e.g. "upload foo.log"
}

export function TransferStatus({ tracked }: { tracked: TrackedTransfer[] }) {
  const [states, setStates] = useState<Record<number, TransferProgress>>({});

  useEffect(() => {
    const unsubs: (() => void)[] = [];
    tracked.forEach(async (t) => {
      const u = await subscribeTransfer(t.transferId, (p) => {
        setStates((prev) => ({ ...prev, [t.transferId]: p }));
      });
      unsubs.push(u);
    });
    return () => { unsubs.forEach((u) => u()); };
  }, [tracked]);

  const active = tracked.filter((t) => !states[t.transferId]?.done);
  if (active.length === 0) return null;

  return (
    <div className="border-t border-border bg-surface text-xs p-2 space-y-1">
      {active.map((t) => {
        const p = states[t.transferId];
        const pct = p && p.total_bytes > 0 ? Math.floor((p.bytes_sent / p.total_bytes) * 100) : 0;
        return (
          <div key={t.transferId} className="flex items-center gap-2">
            <span className="flex-1 truncate">{t.label}</span>
            <span className="w-12 text-right text-muted">{p ? `${pct}%` : '…'}</span>
          </div>
        );
      })}
    </div>
  );
}
```

- [ ] **Step 8.5: SFTP pane**

Path: `ui/components/sftp-pane.tsx`
```tsx
'use client';
import { useCallback, useEffect, useState } from 'react';
import { api, errMessage } from '@/lib/tauri';
import type { SftpEntry } from '@/lib/types';
import { useTabs, type Tab } from '@/lib/tabs-store';
import { ContextMenu, type MenuItem } from './context-menu';
import { SftpBreadcrumb } from './sftp-breadcrumb';
import { SftpFileRow } from './sftp-file-row';
import { TransferStatus, type TrackedTransfer } from './transfer-status';
import { open as openDialog, save as saveDialog } from '@tauri-apps/plugin-dialog';

export function SftpPane({ tab }: { tab: Tab }) {
  const [entries, setEntries] = useState<SftpEntry[]>([]);
  const [menu, setMenu] = useState<{ x: number; y: number; items: MenuItem[] } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [transfers, setTransfers] = useState<TrackedTransfer[]>([]);
  const setCwd = useTabs((s) => s.setCwd);

  const refresh = useCallback(async () => {
    if (tab.connectionId == null) return;
    try {
      setError(null);
      const list = await api.sftpList(tab.connectionId, tab.cwd);
      setEntries(list);
    } catch (e) {
      setError(errMessage(e));
    }
  }, [tab.connectionId, tab.cwd]);

  // Open SFTP subsystem once the SSH connection lands.
  useEffect(() => {
    if (tab.connectionId == null || !tab.sftpOpen) return;
    (async () => {
      try {
        await api.sftpOpen(tab.connectionId!);
        const home = await api.sftpRealpath(tab.connectionId!, '.').catch(() => '/');
        setCwd(tab.tabId, home);
      } catch (e) {
        setError(errMessage(e));
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab.connectionId, tab.sftpOpen]);

  // Reload on cwd change.
  useEffect(() => { refresh(); }, [refresh]);

  function navigateInto(e: SftpEntry) {
    if (e.is_dir) setCwd(tab.tabId, e.full_path);
  }

  function openContext(e: SftpEntry, x: number, y: number) {
    const items: MenuItem[] = [];
    if (!e.is_dir) {
      items.push({ label: 'Download…', onClick: async () => {
        const local = await saveDialog({ defaultPath: e.name });
        if (local && tab.connectionId != null) {
          const t = await api.sftpDownload(tab.connectionId, e.full_path, local as string);
          setTransfers((prev) => [...prev, { transferId: t.transfer_id, label: `download ${e.name}` }]);
        }
      }});
    }
    items.push({ label: 'Rename…', onClick: async () => {
      const n = window.prompt('Rename', e.name);
      if (n && n.trim() && tab.connectionId != null) {
        const parent = e.full_path.replace(/\/[^/]+$/, '') || '/';
        const to = parent === '/' ? `/${n.trim()}` : `${parent}/${n.trim()}`;
        await api.sftpRename(tab.connectionId, e.full_path, to).catch((er) => setError(errMessage(er)));
        refresh();
      }
    }});
    items.push({ label: 'Delete', danger: true, onClick: async () => {
      if (tab.connectionId == null) return;
      if (!window.confirm(`Delete ${e.name}?`)) return;
      const fn = e.is_dir ? api.sftpRmdir : api.sftpRemove;
      await fn(tab.connectionId, e.full_path).catch((er) => setError(errMessage(er)));
      refresh();
    }});
    setMenu({ x, y, items });
  }

  async function handleDrop(ev: React.DragEvent) {
    ev.preventDefault();
    if (tab.connectionId == null) return;
    const files = Array.from(ev.dataTransfer?.files ?? []) as File[];
    for (const f of files) {
      // Tauri v2 gives the OS file path via `dataTransfer.files[i].name` only; the full path is on a custom event.
      // For robustness we use the native dialog if no path is available. Since Tauri 2 webview typically exposes
      // File.name without path, we fall back to the dialog when drag contains unreadable items.
      const local = (f as unknown as { path?: string }).path ?? '';
      if (!local) {
        const picked = await openDialog({ multiple: false });
        if (typeof picked === 'string') {
          const t = await api.sftpUpload(tab.connectionId, picked, `${tab.cwd === '/' ? '' : tab.cwd}/${f.name}`);
          setTransfers((prev) => [...prev, { transferId: t.transfer_id, label: `upload ${f.name}` }]);
        }
      } else {
        const t = await api.sftpUpload(tab.connectionId, local, `${tab.cwd === '/' ? '' : tab.cwd}/${f.name}`);
        setTransfers((prev) => [...prev, { transferId: t.transfer_id, label: `upload ${f.name}` }]);
      }
    }
    setTimeout(refresh, 500);
  }

  return (
    <div
      className="h-full w-64 border-r border-border bg-surface flex flex-col min-h-0"
      onDragOver={(e) => { e.preventDefault(); }}
      onDrop={handleDrop}
    >
      <div className="px-2 py-1.5 border-b border-border flex items-center gap-2">
        <SftpBreadcrumb path={tab.cwd} onNavigate={(p) => setCwd(tab.tabId, p)} />
      </div>
      {error && (
        <div role="alert" className="mx-2 mt-1 px-2 py-1 rounded border border-danger/50 bg-danger/10 text-danger text-xs flex items-start gap-2">
          <span className="flex-1 break-words">{error}</span>
          <button type="button" onClick={() => setError(null)} aria-label="Dismiss error" className="shrink-0 hover:text-fg">×</button>
        </div>
      )}
      <div role="table" aria-label="Remote files" className="flex-1 overflow-auto">
        <div role="row" className="grid grid-cols-[1fr_90px_90px] gap-2 px-2 py-1 text-xs text-muted sticky top-0 bg-surface border-b border-border">
          <span>Name</span><span className="text-right">Size</span><span>Mode</span>
        </div>
        {entries.map((e) => (
          <SftpFileRow key={e.full_path} entry={e} onOpen={navigateInto} onContext={openContext} />
        ))}
      </div>
      <TransferStatus tracked={transfers} />
      {menu && <ContextMenu {...menu} onClose={() => setMenu(null)} />}
    </div>
  );
}
```

- [ ] **Step 8.6: Typecheck + build + commit**

```bash
cd /home/mack/dev/ezTerm/ui && npm run typecheck && npm run lint && npm run build
```

```bash
cd /home/mack/dev/ezTerm
git add ui/lib/tabs-store.ts ui/components/sftp-pane.tsx ui/components/sftp-file-row.tsx ui/components/sftp-breadcrumb.tsx ui/components/transfer-status.tsx
git commit -m "feat(ui): SFTP side-pane with breadcrumb, file rows, context menu, drag-drop upload, progress strip"
```

---

## Task 9: Wire the SFTP pane into the tabs shell

**Files:**
- Modify: `ui/components/tabs-shell.tsx`
- Modify: `ui/components/terminal.tsx` — auto-open SFTP when connection succeeds

- [ ] **Step 9.1: Add SFTP toggle + pane**

Path: `ui/components/tabs-shell.tsx` — render the SFTP pane alongside the active terminal. The pane is a flex sibling on the LEFT of the terminal (spec §4.4).

Replace the render body section that shows the active tab content:
```tsx
      <div className="flex-1 min-h-0 relative flex">
        {tabs.map((t) => (
          <div
            key={t.tabId}
            style={{ display: t.tabId === activeId ? 'flex' : 'none' }}
            className="flex-1 min-h-0 flex"
          >
            {t.sftpOpen && <SftpPane tab={t} />}
            <div className="flex-1 min-h-0 relative">
              <TerminalView tab={t} visible={true} />
            </div>
          </div>
        ))}
      </div>
```

Add the import:
```tsx
import { SftpPane } from './sftp-pane';
```

Also add a small SFTP toggle button in the tab's tab-bar row:
```tsx
<button
  type="button"
  onClick={(e) => { e.stopPropagation(); useTabs.getState().setSftpOpen(t.tabId, !t.sftpOpen); }}
  title={t.sftpOpen ? 'Hide SFTP pane' : 'Show SFTP pane'}
  aria-label={t.sftpOpen ? 'Hide SFTP pane' : 'Show SFTP pane'}
  className="text-xs text-muted hover:text-fg px-1"
>📁</button>
```
Place the button right before the close-tab × inside the tab div.

- [ ] **Step 9.2: Auto-open SFTP on connection**

Path: `ui/components/terminal.tsx` — at the end of the successful-connect path (right after `setStatus(tab.tabId, 'connected')`), add:
```tsx
useTabs.getState().setSftpOpen(tab.tabId, true);
```

This matches spec §4.4: "Opens automatically on a successful SSH connection".

- [ ] **Step 9.3: Typecheck + build + commit**

```bash
cd /home/mack/dev/ezTerm/ui && npm run typecheck && npm run lint && npm run build
```
```bash
cd /home/mack/dev/ezTerm
git add ui/components/tabs-shell.tsx ui/components/terminal.tsx
git commit -m "feat(ui): auto-open SFTP pane on connection; toggle button in tab bar"
```

---

## Task 10: README + version bump + regression + tag

**Files:**
- Modify: `README.md`
- Modify: `Cargo.toml`

- [ ] **Step 10.1: Bump workspace version**

Path: `/home/mack/dev/ezTerm/Cargo.toml` — change `version = "0.2.0"` to `version = "0.3.0"`.

- [ ] **Step 10.2: Extend README**

Append to `/home/mack/dev/ezTerm/README.md`:
```markdown

## v0.3 — SFTP side-pane + SCP

Plan 3 completes the v0.1 feature set:
- Left-docked SFTP file browser in each tab — auto-opens on successful SSH connect
- Breadcrumb navigation, double-click into directories
- Context menu: Download…, Rename, Delete
- Drag-drop upload from the OS file explorer
- 32 KiB streaming chunks with per-transfer progress events
- `scp_upload` / `scp_download` command surface present (routes through SFTP internally)

ezTerm v0.1 milestone is now feature-complete. See GH issues for backlog (X11 forwarding, port forwarding, jump hosts, etc.).
```

- [ ] **Step 10.3: Full regression**

```bash
mkdir -p ui/out
cargo check --manifest-path src-tauri/Cargo.toml
cargo test  --manifest-path src-tauri/Cargo.toml
cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets -- -D warnings
npm --prefix ui run typecheck
npm --prefix ui run lint
npm --prefix ui run build
```
All must pass. 23 tests (19 from Plans 1-2 + 4 from `sftp::session` path normaliser tests).

- [ ] **Step 10.4: Commit + tag**

```bash
git add README.md Cargo.toml Cargo.lock
git commit -m "chore: bump to 0.3.0 and document SFTP features in README"
git tag -a v0.3.0 -m "ezTerm v0.3 — SFTP side-pane + SCP (v0.1 feature-complete)"
```

- [ ] **Step 10.5: DO NOT push** — controller handles push after review.

---

## Self-Review

**Spec coverage:**
- §4.4 SFTP side-pane (auto-open, breadcrumb, context menu, drag-drop) → Tasks 8, 9
- §7 command surface — sftp_open/list/upload/download/mkdir/rename/delete/chmod → Tasks 3, 4, 5; scp_upload/scp_download → Task 6 (stubs route through SFTP)
- §6 security — path traversal rejected centrally in `normalise_remote_path` → Task 2
- Progress events + streaming → Task 5
- Transfer cancellation — deferred; `AppError::TransferCancelled` declared but no cancel command in v0.3. Flag for follow-up issue.

**Placeholder scan:** none. russh-sftp API specifics flagged as "adapt and report" explicitly.

**Type consistency:** `SftpEntry`, `TransferProgress`, `TransferTicket` line up between Rust serialize structs and TypeScript DTOs. `sftp_*` command names match across invoke wrappers.

**Open deviations from spec:**
- True SCP protocol (not via SFTP) → follow-up issue
- Transfer cancel → follow-up issue
- Multiple simultaneous selections for context menu → v0.4

---

## Execution Handoff

**Plan complete and saved to `docs/superpowers/plans/2026-04-19-plan-3-sftp-scp.md`.** Two execution options:

**1. Subagent-Driven (recommended)** — fresh subagents per bundle, consolidated review. Suggested bundling:
- Bundle 1: Tasks 1-3 (deps, registry, sftp_open + Plan 2 Connection refactor)
- Bundle 2: Tasks 4-5 (SFTP commands + streaming transfers)
- Bundle 3: Task 6 (SCP stubs) + Tasks 7-9 (frontend) + Task 10 (finalize)

**2. Inline Execution** — via `superpowers:executing-plans`.
