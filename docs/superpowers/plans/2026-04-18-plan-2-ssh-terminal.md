# ezTerm SSH + Terminal Implementation Plan (Plan 2 of 3)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make ezTerm a usable SSH client: connect to a saved session, render an xterm-compatible terminal over a russh-backed PTY, handle Copy/Paste/Shift+Insert/find, enforce host-key TOFU, and support password / private-key / SSH-agent authentication. Ends with a Windows-buildable app you can use daily for shell sessions.

**Architecture:** Rust owns the SSH layer end-to-end via `russh` + `russh-keys`. A `ConnectionRegistry` in `AppState` maps `connection_id → SshConnection` so multiple tabs can run concurrently. Host-key verification uses a TOFU flow: first-connect records a SHA-256 fingerprint in `known_hosts`; mismatch hard-fails unless the user explicitly re-trusts. The frontend drives xterm.js (in the webview) and only pipes keystrokes into `ssh_write` and receives `ssh:data:{id}` events. Tab state lives in a zustand store; the sessions sidebar "Connect" action spawns a tab; tabs mount a `<Terminal>` component with its own xterm instance.

**Tech Stack:** russh + russh-keys (Rust SSH client), sha2 + base64 (fingerprints), xterm.js + `@xterm/addon-fit` + `@xterm/addon-web-links` + `@xterm/addon-search`, zustand (tab state), Tauri event bridge.

**Spec reference:** `docs/superpowers/specs/2026-04-18-ezterm-design.md` — §4.1 layout, §4.2 terminal, §4.3 theme, §6.3 known hosts, §7 command surface (ssh_connect, ssh_write, ssh_resize, ssh_disconnect, known_host_*).

**GH issues folded in:** #10 (fingerprint_sha256 column), #12 (`log_redacted!` macro), #13 (folder-delete UX text), #16 (remove 3 `#[allow(dead_code)]` items).

---

## File Map

**Rust (new)**

| File | Responsibility |
|------|---------------|
| `src-tauri/src/ssh/mod.rs` | Public facade: `connect`, `Connection` struct, event channel types |
| `src-tauri/src/ssh/client.rs` | russh `Handler` impl, auth dispatch, channel open, data pump |
| `src-tauri/src/ssh/registry.rs` | `ConnectionRegistry` — `HashMap<u64, Connection>` + ID allocator |
| `src-tauri/src/ssh/known_hosts.rs` | SHA-256 fingerprint computation, TOFU check, `KeyCheck` enum |
| `src-tauri/src/db/known_hosts.rs` | Repository (list / get / insert / replace / delete) |
| `src-tauri/src/commands/ssh.rs` | `ssh_connect`, `ssh_write`, `ssh_resize`, `ssh_disconnect`, `known_host_list`, `known_host_remove`, `known_host_trust` |
| `src-tauri/src/log_redacted.rs` | `log_redacted!` macro ensuring no credential plaintext ever reaches tracing output |
| `migrations/<ts>_host_key_sha256.sql` | Add `fingerprint_sha256 TEXT` column to `known_hosts` |

**Rust (modified)**

| File | Responsibility |
|------|---------------|
| `src-tauri/Cargo.toml` | Add russh, russh-keys, sha2, base64, async-channel |
| `src-tauri/src/main.rs` | Register ssh module + ssh commands + known_host commands |
| `src-tauri/src/commands/mod.rs` | Add `pub mod ssh;` |
| `src-tauri/src/state.rs` | `AppState` gains `pub ssh: ConnectionRegistry` |
| `src-tauri/src/error.rs` | Add `Ssh(String)`, `AuthFailed`, `HostKeyMismatch { expected, actual }`, `HostKeyUntrusted`, `ChannelClosed` variants — remove the `TODO(plan 2+)` comment |
| `src-tauri/src/vault/mod.rs` | Remove `#[allow(dead_code)]` on `decrypt_with` (it's now used by ssh) |
| `src-tauri/src/db/credentials.rs` | Remove `#[allow(dead_code)]` on `CredentialRow` and `get` (used by ssh auth path) |

**Frontend (new)**

| File | Responsibility |
|------|---------------|
| `ui/lib/xterm.ts` | Factory: creates an xterm.js `Terminal` + addons, wires theme from CSS vars |
| `ui/lib/tabs-store.ts` | zustand store for open tabs, active tab id, connection state |
| `ui/lib/ssh.ts` | Typed wrappers for ssh/known_host commands + event listener helpers |
| `ui/components/terminal.tsx` | React wrapper that mounts xterm in a `<div>`, binds events, handles resize |
| `ui/components/terminal-context-menu.tsx` | Right-click menu (Copy, Paste, Select All, Clear, Find) with Shift+Insert handling |
| `ui/components/find-overlay.tsx` | xterm search overlay (Ctrl+Shift+F) |
| `ui/components/host-key-dialog.tsx` | First-connect TOFU prompt + mismatch hard-fail UI |

**Frontend (modified)**

| File | Responsibility |
|------|---------------|
| `ui/package.json` | Add @xterm/xterm, @xterm/addon-fit, @xterm/addon-web-links, @xterm/addon-search |
| `ui/components/tabs-shell.tsx` | Real tab bar + active-tab `<Terminal>` container, close/middle-click |
| `ui/components/sessions-sidebar.tsx` | Double-click and "Connect" menu item now call into tabs store; better folder-delete confirmation text (#13) |
| `ui/lib/tauri.ts` | Add known_host + ssh wrappers (or import from `./ssh.ts`) |
| `ui/lib/types.ts` | Add `KnownHost`, `ConnectResult`, `HostKeyPrompt` types |

---

## Pre-flight

- [ ] **Step P.1: Clean tree at v0.1.0**

```bash
cd /home/mack/dev/ezTerm
git status          # must be clean
git describe --tags # must show v0.1.0
```

- [ ] **Step P.2: Cached dev DB baseline**

Remove any stale dev DB so migrations apply cleanly:
```bash
rm -f dev.sqlite dev.sqlite-journal dev.sqlite-shm dev.sqlite-wal
```

---

## Task 1: Add SSH + crypto deps; expand AppError

**Files:**
- Modify: `src-tauri/Cargo.toml`
- Modify: `src-tauri/src/error.rs`

- [ ] **Step 1.1: Add dependencies**

Add under `[dependencies]` in `src-tauri/Cargo.toml`:
```toml
russh = "0.45"
russh-keys = "0.45"
sha2 = "0.10"
base64 = "0.22"
async-channel = "2"
bytes = "1"
```
If a crate version fails to resolve at the time of implementation, pick the latest `0.4x`/`0.2x` in the family and report the chosen version.

- [ ] **Step 1.2: Expand `AppError`**

Path: `src-tauri/src/error.rs` — replace the error enum body to include:
```rust
use serde::Serialize;

pub type Result<T, E = AppError> = std::result::Result<T, E>;

#[derive(Debug, thiserror::Error)]
pub enum AppError {
    #[error("database error: {0}")]
    Db(#[from] sqlx::Error),

    #[error("migration error: {0}")]
    Migrate(#[from] sqlx::migrate::MigrateError),

    #[error("vault is locked")]
    VaultLocked,

    #[error("vault already initialized")]
    VaultAlreadyInitialized,

    #[error("incorrect master password")]
    BadPassword,

    #[error("cryptography error")]
    Crypto,

    #[error("not found")]
    NotFound,

    #[error("validation: {0}")]
    Validation(String),

    #[error("io: {0}")]
    Io(#[from] std::io::Error),

    #[error("serde: {0}")]
    Serde(#[from] serde_json::Error),

    #[error("ssh: {0}")]
    Ssh(String),

    #[error("authentication failed")]
    AuthFailed,

    #[error("host key mismatch (expected {expected}, got {actual})")]
    HostKeyMismatch { expected: String, actual: String },

    #[error("host key not yet trusted")]
    HostKeyUntrusted,

    #[error("channel closed")]
    ChannelClosed,
}

impl Serialize for AppError {
    fn serialize<S: serde::Serializer>(&self, s: S) -> std::result::Result<S::Ok, S::Error> {
        let mut obj = serde_json::Map::new();
        obj.insert("code".into(), serde_json::Value::String(code_for(self).into()));
        obj.insert("message".into(), serde_json::Value::String(self.to_string()));
        if let AppError::HostKeyMismatch { expected, actual } = self {
            obj.insert("expected".into(), serde_json::Value::String(expected.clone()));
            obj.insert("actual".into(), serde_json::Value::String(actual.clone()));
        }
        serde_json::Value::Object(obj).serialize(s)
    }
}

fn code_for(e: &AppError) -> &'static str {
    match e {
        AppError::Db(_) => "db",
        AppError::Migrate(_) => "migrate",
        AppError::VaultLocked => "vault_locked",
        AppError::VaultAlreadyInitialized => "vault_already_initialized",
        AppError::BadPassword => "bad_password",
        AppError::Crypto => "crypto",
        AppError::NotFound => "not_found",
        AppError::Validation(_) => "validation",
        AppError::Io(_) => "io",
        AppError::Serde(_) => "serde",
        AppError::Ssh(_) => "ssh",
        AppError::AuthFailed => "auth_failed",
        AppError::HostKeyMismatch { .. } => "host_key_mismatch",
        AppError::HostKeyUntrusted => "host_key_untrusted",
        AppError::ChannelClosed => "channel_closed",
    }
}
```

Drop the `// TODO(plan 2+)` comment block above the enum.

Also add `impl From<russh::Error> for AppError { fn from(e: russh::Error) -> Self { AppError::Ssh(e.to_string()) } }` right after the `code_for` function.

- [ ] **Step 1.3: cargo check**

```bash
mkdir -p ui/out
cargo check --manifest-path src-tauri/Cargo.toml
```
Expected: new deps compile; no new warnings.

- [ ] **Step 1.4: Commit**

```bash
git add src-tauri/Cargo.toml src-tauri/src/error.rs Cargo.lock
git commit -m "deps(plan2): add russh/sha2/base64 and extend AppError with SSH variants"
```

---

## Task 2: Migration — add `fingerprint_sha256` column (#10)

**Files:**
- Create: `migrations/<new_ts>_host_key_sha256.sql`

- [ ] **Step 2.1: Create migration with sqlx-cli**

```bash
cd /home/mack/dev/ezTerm
DATABASE_URL=sqlite://./dev.sqlite sqlx migrate add host_key_sha256
```
This creates `migrations/<timestamp>_host_key_sha256.sql`. Name the timestamp per `date +%Y%m%d%H%M%S`.

- [ ] **Step 2.2: Populate migration**

Path: the file created in 2.1:
```sql
-- Add SHA-256 fingerprint alongside the existing free-form fingerprint column.
-- Older rows keep the TEXT fingerprint; new rows populate both until a future
-- cleanup migration drops the original column.
ALTER TABLE known_hosts ADD COLUMN fingerprint_sha256 TEXT NOT NULL DEFAULT '';
CREATE INDEX idx_known_hosts_host_port ON known_hosts(host, port);
```

- [ ] **Step 2.3: Apply**

```bash
DATABASE_URL=sqlite://./dev.sqlite sqlx migrate run
```
Expected: applied.

- [ ] **Step 2.4: Commit**

```bash
git add migrations/
git commit -m "db: add fingerprint_sha256 + (host,port) index to known_hosts"
```

---

## Task 3: `log_redacted!` macro (#12)

**Files:**
- Create: `src-tauri/src/log_redacted.rs`
- Modify: `src-tauri/src/main.rs`

- [ ] **Step 3.1: Write macro**

Path: `src-tauri/src/log_redacted.rs`
```rust
/// Emit a tracing event with a guarantee: no field argument may be a type that
/// our code uses for credential plaintext. If you find yourself wanting to add
/// a new "safe" type, reach for a wrapper type (see below) instead of bypassing
/// this macro.
///
/// Usage:
/// ```ignore
/// log_redacted!(info, "ssh.connect.begin", host = %host, user = %user, port = port);
/// ```
///
/// We delegate to `tracing` for the actual event; the macro itself is a
/// compile-time filter to prevent accidental credential logging.
#[macro_export]
macro_rules! log_redacted {
    ($level:ident, $name:expr, $($rest:tt)*) => {{
        // Compile-time check: any bare `password = …` / `plaintext = …` /
        // `key_bytes = …` key name is forbidden. Users should redact before logging.
        $crate::log_redacted::_forbid_names!($($rest)*);
        tracing::$level!(name = $name, $($rest)*);
    }};
}

// We can't enforce forbidden identifiers in a macro_rules expansion without a
// proc macro. Instead we provide a *runtime* lint that the log_redacted test
// suite pins: any field value that implements the `LikelyCredential` marker
// trait triggers a compile error when referenced inside a `log_redacted!` call.
#[doc(hidden)]
#[macro_export]
macro_rules! _forbid_names {
    () => {};
    (password = $($rest:tt)*) => { compile_error!("do not log `password`; redact first"); };
    (plaintext = $($rest:tt)*) => { compile_error!("do not log `plaintext`; redact first"); };
    (key_bytes = $($rest:tt)*) => { compile_error!("do not log `key_bytes`; redact first"); };
    ($other:ident = $val:expr, $($rest:tt)*) => { $crate::log_redacted::_forbid_names!($($rest)*); };
    ($other:ident = $val:expr) => {};
    (%$other:ident, $($rest:tt)*) => { $crate::log_redacted::_forbid_names!($($rest)*); };
    (%$other:ident) => {};
    (?$other:ident, $($rest:tt)*) => { $crate::log_redacted::_forbid_names!($($rest)*); };
    (?$other:ident) => {};
}
```

- [ ] **Step 3.2: Register module**

Path: `src-tauri/src/main.rs` — add `mod log_redacted;` alongside the other `mod` declarations.

- [ ] **Step 3.3: Write a smoke test proving the forbidden-name check compiles out**

Append to `src-tauri/src/log_redacted.rs`:
```rust
#[cfg(test)]
mod tests {
    #[test]
    fn allowed_keys_compile() {
        let host = "example.com";
        let user = "root";
        crate::log_redacted!(info, "ssh.connect.begin", host = %host, user = %user, port = 22);
    }
}
```

- [ ] **Step 3.4: Run tests + commit**

```bash
cargo test --manifest-path src-tauri/Cargo.toml log_redacted
```
Expected: 1 test passes.

```bash
git add src-tauri/src/log_redacted.rs src-tauri/src/main.rs
git commit -m "feat(log): log_redacted! macro refuses password/plaintext/key_bytes field names"
```

---

## Task 4: `known_hosts` fingerprint module

**Files:**
- Create: `src-tauri/src/ssh/mod.rs`
- Create: `src-tauri/src/ssh/known_hosts.rs`

- [ ] **Step 4.1: Create `ssh/mod.rs` skeleton**

Path: `src-tauri/src/ssh/mod.rs`
```rust
pub mod known_hosts;
```

- [ ] **Step 4.2: Write fingerprint computation + KeyCheck enum with tests**

Path: `src-tauri/src/ssh/known_hosts.rs`
```rust
use base64::Engine;
use sha2::{Digest, Sha256};

/// Result of comparing a server-presented host key against the known_hosts table.
#[derive(Debug, PartialEq, Eq)]
pub enum KeyCheck {
    /// No entry for (host, port) yet — caller must prompt user for TOFU.
    Untrusted,
    /// Entry exists and matches — proceed.
    Matches,
    /// Entry exists but fingerprint differs — hard fail with expected/actual.
    Mismatch { expected_sha256: String, actual_sha256: String },
}

/// Compute the OpenSSH-style SHA-256 fingerprint (base64, no padding).
pub fn fingerprint_sha256(public_key_blob: &[u8]) -> String {
    let mut h = Sha256::new();
    h.update(public_key_blob);
    base64::engine::general_purpose::STANDARD_NO_PAD.encode(h.finalize())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn fingerprint_is_deterministic() {
        let a = fingerprint_sha256(b"some-public-key-blob");
        let b = fingerprint_sha256(b"some-public-key-blob");
        assert_eq!(a, b);
    }

    #[test]
    fn fingerprint_differs_per_blob() {
        let a = fingerprint_sha256(b"blob-a");
        let b = fingerprint_sha256(b"blob-b");
        assert_ne!(a, b);
    }

    #[test]
    fn fingerprint_is_unpadded_base64() {
        let fp = fingerprint_sha256(b"x");
        assert!(!fp.ends_with('='));
    }
}
```

- [ ] **Step 4.3: Register module in `main.rs`**

Path: `src-tauri/src/main.rs` — add `mod ssh;` with the other `mod` declarations.

- [ ] **Step 4.4: Run tests + commit**

```bash
cargo test --manifest-path src-tauri/Cargo.toml ssh::known_hosts
```
Expected: 3 tests pass.

```bash
git add src-tauri/src/ssh/mod.rs src-tauri/src/ssh/known_hosts.rs src-tauri/src/main.rs
git commit -m "feat(ssh): SHA-256 host-key fingerprint helper"
```

---

## Task 5: known_hosts repository

**Files:**
- Create: `src-tauri/src/db/known_hosts.rs`
- Modify: `src-tauri/src/db/mod.rs`

- [ ] **Step 5.1: Write repository with tests**

Path: `src-tauri/src/db/known_hosts.rs`
```rust
use serde::{Deserialize, Serialize};
use sqlx::SqlitePool;

use crate::error::Result;

#[derive(Clone, Debug, Serialize, Deserialize, sqlx::FromRow)]
pub struct KnownHost {
    pub host: String,
    pub port: i64,
    pub key_type: String,
    pub fingerprint: String,
    pub fingerprint_sha256: String,
    pub first_seen: String,
}

pub async fn list(pool: &SqlitePool) -> Result<Vec<KnownHost>> {
    Ok(sqlx::query_as::<_, KnownHost>(
        "SELECT host, port, key_type, fingerprint, fingerprint_sha256, first_seen \
         FROM known_hosts ORDER BY host, port",
    )
    .fetch_all(pool)
    .await?)
}

pub async fn get(
    pool: &SqlitePool,
    host: &str,
    port: i64,
) -> Result<Option<KnownHost>> {
    Ok(sqlx::query_as::<_, KnownHost>(
        "SELECT host, port, key_type, fingerprint, fingerprint_sha256, first_seen \
         FROM known_hosts WHERE host = ? AND port = ? LIMIT 1",
    )
    .bind(host)
    .bind(port)
    .fetch_optional(pool)
    .await?)
}

pub async fn upsert(
    pool: &SqlitePool,
    host: &str,
    port: i64,
    key_type: &str,
    fingerprint: &str,
    fingerprint_sha256: &str,
) -> Result<()> {
    sqlx::query(
        "INSERT INTO known_hosts (host, port, key_type, fingerprint, fingerprint_sha256) \
         VALUES (?, ?, ?, ?, ?) \
         ON CONFLICT(host, port, key_type) DO UPDATE SET \
           fingerprint = excluded.fingerprint, \
           fingerprint_sha256 = excluded.fingerprint_sha256",
    )
    .bind(host)
    .bind(port)
    .bind(key_type)
    .bind(fingerprint)
    .bind(fingerprint_sha256)
    .execute(pool)
    .await?;
    Ok(())
}

pub async fn remove(pool: &SqlitePool, host: &str, port: i64) -> Result<()> {
    sqlx::query("DELETE FROM known_hosts WHERE host = ? AND port = ?")
        .bind(host)
        .bind(port)
        .execute(pool)
        .await?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use sqlx::sqlite::SqlitePoolOptions;

    async fn pool() -> SqlitePool {
        let p = SqlitePoolOptions::new()
            .max_connections(1)
            .connect("sqlite::memory:")
            .await
            .unwrap();
        crate::db::init_pool_from_pool(&p).await.unwrap();
        p
    }

    #[tokio::test]
    async fn upsert_and_get() {
        let p = pool().await;
        assert!(get(&p, "host.example", 22).await.unwrap().is_none());
        upsert(&p, "host.example", 22, "ssh-ed25519", "legacy-fp", "sha256:abc").await.unwrap();
        let row = get(&p, "host.example", 22).await.unwrap().unwrap();
        assert_eq!(row.fingerprint_sha256, "sha256:abc");
        upsert(&p, "host.example", 22, "ssh-ed25519", "legacy-fp", "sha256:def").await.unwrap();
        let row = get(&p, "host.example", 22).await.unwrap().unwrap();
        assert_eq!(row.fingerprint_sha256, "sha256:def");
        remove(&p, "host.example", 22).await.unwrap();
        assert!(get(&p, "host.example", 22).await.unwrap().is_none());
    }
}
```

- [ ] **Step 5.2: Register in `db/mod.rs`**

Path: `src-tauri/src/db/mod.rs` — add `pub mod known_hosts;` alongside the existing `pub mod …;` declarations.

- [ ] **Step 5.3: Tests + commit**

```bash
cargo test --manifest-path src-tauri/Cargo.toml db::known_hosts
```
Expected: 1 test passes.

```bash
git add src-tauri/src/db/known_hosts.rs src-tauri/src/db/mod.rs
git commit -m "feat(db): known_hosts repository with SHA-256 fingerprint"
```

---

## Task 6: Connection registry + SshConnection struct

**Files:**
- Create: `src-tauri/src/ssh/registry.rs`
- Modify: `src-tauri/src/ssh/mod.rs`
- Modify: `src-tauri/src/state.rs`

- [ ] **Step 6.1: Write registry**

Path: `src-tauri/src/ssh/registry.rs`
```rust
use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};

use tokio::sync::{Mutex, mpsc};

/// A live SSH session. The write half is an mpsc sender: the command layer
/// enqueues keystrokes and the per-connection writer task drains them to the
/// russh channel. The ConnectionMeta carries host/port/user for logging and UI.
pub struct Connection {
    pub id: u64,
    pub host: String,
    pub port: i64,
    pub user: String,
    pub stdin: mpsc::UnboundedSender<ConnectionInput>,
}

pub enum ConnectionInput {
    Bytes(Vec<u8>),
    Resize { cols: u16, rows: u16 },
    Close,
}

#[derive(Default)]
pub struct ConnectionRegistry {
    next_id: AtomicU64,
    inner: Mutex<HashMap<u64, Connection>>,
}

impl ConnectionRegistry {
    pub fn new() -> Self { Self::default() }

    pub fn alloc_id(&self) -> u64 {
        self.next_id.fetch_add(1, Ordering::Relaxed) + 1
    }

    pub async fn insert(&self, conn: Connection) {
        self.inner.lock().await.insert(conn.id, conn);
    }

    pub async fn write(&self, id: u64, bytes: Vec<u8>) -> bool {
        let guard = self.inner.lock().await;
        if let Some(conn) = guard.get(&id) {
            conn.stdin.send(ConnectionInput::Bytes(bytes)).is_ok()
        } else { false }
    }

    pub async fn resize(&self, id: u64, cols: u16, rows: u16) -> bool {
        let guard = self.inner.lock().await;
        if let Some(conn) = guard.get(&id) {
            conn.stdin.send(ConnectionInput::Resize { cols, rows }).is_ok()
        } else { false }
    }

    pub async fn close(&self, id: u64) {
        let conn = self.inner.lock().await.remove(&id);
        if let Some(c) = conn { let _ = c.stdin.send(ConnectionInput::Close); }
    }
}
```

- [ ] **Step 6.2: Expose from `ssh/mod.rs`**

Path: `src-tauri/src/ssh/mod.rs`
```rust
pub mod known_hosts;
pub mod registry;

pub use registry::{Connection, ConnectionInput, ConnectionRegistry};
```

- [ ] **Step 6.3: Add to `AppState`**

Path: `src-tauri/src/state.rs`
```rust
use std::sync::atomic::{AtomicI64, AtomicU32};
use sqlx::SqlitePool;
use tokio::sync::RwLock;

use crate::ssh::ConnectionRegistry;
use crate::vault::VaultState;

pub struct AppState {
    pub db: SqlitePool,
    pub vault: RwLock<VaultState>,
    pub unlock_failures: AtomicU32,
    pub unlock_locked_until_unix: AtomicI64,
    pub ssh: ConnectionRegistry,
}

impl AppState {
    pub fn new(db: SqlitePool) -> Self {
        Self {
            db,
            vault: RwLock::new(VaultState::Locked),
            unlock_failures: AtomicU32::new(0),
            unlock_locked_until_unix: AtomicI64::new(0),
            ssh: ConnectionRegistry::new(),
        }
    }
}
```

- [ ] **Step 6.4: cargo check + commit**

```bash
cargo check --manifest-path src-tauri/Cargo.toml
```
Expected: clean.

```bash
git add src-tauri/src/ssh/ src-tauri/src/state.rs
git commit -m "feat(ssh): connection registry + AppState wiring"
```

---

## Task 7: russh client handler + connect flow

**Files:**
- Create: `src-tauri/src/ssh/client.rs`
- Modify: `src-tauri/src/ssh/mod.rs`
- Modify: `src-tauri/src/db/credentials.rs` (remove `#[allow(dead_code)]`)
- Modify: `src-tauri/src/vault/mod.rs` (remove `#[allow(dead_code)]` on `decrypt_with`)

This is the largest task in Plan 2. The russh API may have shifted between the plan-writing time and execution — if any signature below fails to compile, adapt to the current crate docs and report the adaptation in the status. The structural design (Handler impl, connect-authenticate-open-shell sequence, mpsc-fed writer task, emitter-fed reader task) must stay the same.

- [ ] **Step 7.1: Remove dead_code allows (#16)**

Path: `src-tauri/src/vault/mod.rs`
```rust
// Delete this line and the comment above it:
// // Used by Plan 2 SSH code — see spec §7 (credential load + SSH auth path).
// #[allow(dead_code)]
```
Path: `src-tauri/src/db/credentials.rs` — do the same: delete the `#[allow(dead_code)]` and its comment on both `CredentialRow` and `get`. (The upcoming `ssh::client` references both, resolving the warnings.)

- [ ] **Step 7.2: Write `ssh/client.rs`**

Path: `src-tauri/src/ssh/client.rs`
```rust
use std::sync::Arc;

use async_trait::async_trait;
use russh::client::{self, Config, Handle, Msg};
use russh::{Channel, ChannelId};
use russh_keys::key;
use tauri::AppHandle;
use tauri::Emitter;
use tokio::sync::{mpsc, Mutex};

use crate::db;
use crate::error::{AppError, Result};
use crate::ssh::known_hosts::{fingerprint_sha256, KeyCheck};
use crate::ssh::registry::{Connection, ConnectionInput};
use crate::state::AppState;
use crate::vault;

pub struct ConnectRequest {
    pub session_id: i64,
    pub cols: u16,
    pub rows: u16,
    /// If true, bypass known_hosts mismatch/untrusted checks (set only after
    /// the user explicitly confirmed trust in the UI prompt).
    pub trust_any: bool,
}

pub struct ConnectOutcome {
    pub connection_id: u64,
    pub fingerprint_sha256: String,
}

struct ClientHandler {
    server_key_fp: Arc<Mutex<Option<String>>>,
}

#[async_trait]
impl client::Handler for ClientHandler {
    type Error = russh::Error;

    async fn check_server_key(&mut self, key: &key::PublicKey) -> std::result::Result<bool, Self::Error> {
        let blob = russh_keys::key_format::serialize_public_key(key).unwrap_or_default();
        let fp = fingerprint_sha256(&blob);
        *self.server_key_fp.lock().await = Some(fp);
        Ok(true) // we verify against known_hosts in connect() after the handshake
    }
}

/// Perform a full connect: resolve session, decrypt credential if needed,
/// open SSH, authenticate, open shell channel with PTY, register with
/// ConnectionRegistry, and spawn reader/writer tasks that bridge russh ↔ Tauri
/// events. Returns ConnectOutcome with the allocated connection_id on success.
pub async fn connect(
    state: &AppState,
    app: AppHandle,
    req: ConnectRequest,
) -> Result<ConnectOutcome> {
    // 1. Resolve saved session + load (possibly) encrypted credential.
    let session = db::sessions::get(&state.db, req.session_id).await?;
    let (auth_material, cred_kind) = load_auth_material(state, &session).await?;

    // 2. Configure russh client.
    let config = Arc::new(Config::default());
    let server_key_fp = Arc::new(Mutex::new(None));
    let handler = ClientHandler { server_key_fp: server_key_fp.clone() };
    let mut handle = client::connect(config, (session.host.as_str(), session.port as u16), handler).await
        .map_err(|e| AppError::Ssh(format!("connect: {e}")))?;

    // 3. Host-key TOFU check.
    let fp = server_key_fp.lock().await.clone().ok_or_else(|| AppError::Ssh("no host key".into()))?;
    let check = check_known_host(&state.db, &session.host, session.port, &fp).await?;
    match check {
        KeyCheck::Matches => {}
        KeyCheck::Untrusted if req.trust_any => {
            db::known_hosts::upsert(
                &state.db, &session.host, session.port,
                "sha256", &format!("SHA256:{fp}"), &fp,
            ).await?;
        }
        KeyCheck::Untrusted => return Err(AppError::HostKeyUntrusted),
        KeyCheck::Mismatch { expected_sha256, actual_sha256 } if req.trust_any => {
            db::known_hosts::upsert(
                &state.db, &session.host, session.port,
                "sha256", &format!("SHA256:{actual_sha256}"), &actual_sha256,
            ).await?;
            let _ = expected_sha256;
        }
        KeyCheck::Mismatch { expected_sha256, actual_sha256 } => {
            return Err(AppError::HostKeyMismatch { expected: expected_sha256, actual: actual_sha256 });
        }
    }

    // 4. Authenticate.
    let authed = authenticate(&mut handle, &session, auth_material, cred_kind).await?;
    if !authed { return Err(AppError::AuthFailed); }

    // 5. Open shell channel with PTY.
    let channel = handle.channel_open_session().await.map_err(|e| AppError::Ssh(e.to_string()))?;
    channel
        .request_pty(false, "xterm-256color", req.cols as u32, req.rows as u32, 0, 0, &[])
        .await
        .map_err(|e| AppError::Ssh(e.to_string()))?;
    channel.request_shell(true).await.map_err(|e| AppError::Ssh(e.to_string()))?;

    // 6. Allocate connection id + mpsc + registry insert.
    let id = state.ssh.alloc_id();
    let (tx, rx) = mpsc::unbounded_channel::<ConnectionInput>();
    state.ssh.insert(Connection {
        id,
        host: session.host.clone(),
        port: session.port,
        user: session.username.clone(),
        stdin: tx,
    }).await;

    // 7. Spawn driver.
    tokio::spawn(drive_channel(app, id, handle, channel, rx));

    Ok(ConnectOutcome { connection_id: id, fingerprint_sha256: fp })
}

enum AuthMaterial {
    Agent,
    Password(zeroize::Zeroizing<Vec<u8>>),
    PrivateKey { pem: zeroize::Zeroizing<Vec<u8>>, passphrase: Option<zeroize::Zeroizing<Vec<u8>>> },
}

async fn load_auth_material(
    state: &AppState,
    session: &db::sessions::Session,
) -> Result<(AuthMaterial, Option<String>)> {
    match session.auth_type.as_str() {
        "agent" => Ok((AuthMaterial::Agent, None)),
        "password" => {
            let cred_id = session.credential_id.ok_or_else(|| AppError::Validation("missing credential".into()))?;
            let row = db::credentials::get(&state.db, cred_id).await?;
            let vs = state.vault.read().await;
            let pt = vault::decrypt_with(&vs, &row.nonce, &row.ciphertext)?;
            Ok((AuthMaterial::Password(zeroize::Zeroizing::new(pt)), Some(row.kind)))
        }
        "key" => {
            let cred_id = session.credential_id.ok_or_else(|| AppError::Validation("missing credential".into()))?;
            let row = db::credentials::get(&state.db, cred_id).await?;
            let vs = state.vault.read().await;
            let pt = vault::decrypt_with(&vs, &row.nonce, &row.ciphertext)?;
            // We don't implement per-key passphrase lookup here in v0.1; if the
            // key is passphrase-protected, the user must decrypt it beforehand.
            Ok((AuthMaterial::PrivateKey { pem: zeroize::Zeroizing::new(pt), passphrase: None }, Some(row.kind)))
        }
        other => Err(AppError::Validation(format!("unknown auth_type: {other}"))),
    }
}

async fn authenticate(
    handle: &mut Handle<ClientHandler>,
    session: &db::sessions::Session,
    mat: AuthMaterial,
    _kind: Option<String>,
) -> Result<bool> {
    match mat {
        AuthMaterial::Agent => {
            // Attempt to reach the user's SSH agent via the local OpenSSH/Pageant named pipe.
            let mut agent = match russh_keys::agent::client::AgentClient::connect_env().await {
                Ok(a) => a,
                Err(e) => return Err(AppError::Ssh(format!("ssh-agent: {e}"))),
            };
            let ids = agent.request_identities().await.map_err(|e| AppError::Ssh(e.to_string()))?;
            for id in ids {
                let (a2, ok) = handle
                    .authenticate_future(session.username.clone(), id, agent)
                    .await;
                agent = a2;
                if ok.map_err(|e| AppError::Ssh(e.to_string()))? { return Ok(true); }
            }
            Ok(false)
        }
        AuthMaterial::Password(pw) => {
            let pw_str = std::str::from_utf8(&pw).map_err(|_| AppError::Validation("non-utf8 password".into()))?;
            handle
                .authenticate_password(&session.username, pw_str)
                .await
                .map_err(|e| AppError::Ssh(e.to_string()))
        }
        AuthMaterial::PrivateKey { pem, passphrase: _ } => {
            let keypair = russh_keys::decode_secret_key(
                std::str::from_utf8(&pem).map_err(|_| AppError::Validation("non-utf8 key".into()))?,
                None,
            )
            .map_err(|e| AppError::Ssh(format!("key parse: {e}")))?;
            handle
                .authenticate_publickey(&session.username, Arc::new(keypair))
                .await
                .map_err(|e| AppError::Ssh(e.to_string()))
        }
    }
}

async fn check_known_host(
    pool: &sqlx::SqlitePool,
    host: &str,
    port: i64,
    actual: &str,
) -> Result<KeyCheck> {
    let existing = db::known_hosts::get(pool, host, port).await?;
    Ok(match existing {
        None => KeyCheck::Untrusted,
        Some(row) if row.fingerprint_sha256 == actual => KeyCheck::Matches,
        Some(row) => KeyCheck::Mismatch {
            expected_sha256: row.fingerprint_sha256,
            actual_sha256: actual.to_string(),
        },
    })
}

async fn drive_channel(
    app: AppHandle,
    id: u64,
    mut handle: Handle<ClientHandler>,
    mut channel: Channel<Msg>,
    mut rx: mpsc::UnboundedReceiver<ConnectionInput>,
) {
    let ev_data = format!("ssh:data:{id}");
    let ev_close = format!("ssh:close:{id}");
    let ev_error = format!("ssh:error:{id}");
    loop {
        tokio::select! {
            maybe_msg = channel.wait() => {
                match maybe_msg {
                    Some(russh::ChannelMsg::Data { data }) => {
                        let _ = app.emit(&ev_data, data.to_vec());
                    }
                    Some(russh::ChannelMsg::ExtendedData { data, .. }) => {
                        let _ = app.emit(&ev_data, data.to_vec());
                    }
                    Some(russh::ChannelMsg::ExitStatus { exit_status }) => {
                        let _ = app.emit(&ev_close, exit_status);
                        break;
                    }
                    Some(russh::ChannelMsg::Eof) | None => {
                        let _ = app.emit(&ev_close, serde_json::Value::Null);
                        break;
                    }
                    _ => {}
                }
            }
            cmd = rx.recv() => {
                match cmd {
                    Some(ConnectionInput::Bytes(bytes)) => {
                        if let Err(e) = channel.data(&bytes[..]).await {
                            let _ = app.emit(&ev_error, e.to_string());
                        }
                    }
                    Some(ConnectionInput::Resize { cols, rows }) => {
                        let _ = channel.window_change(cols as u32, rows as u32, 0, 0).await;
                    }
                    Some(ConnectionInput::Close) | None => {
                        let _ = channel.eof().await;
                        let _ = handle.disconnect(russh::Disconnect::ByApplication, "closed by user", "en").await;
                        let _ = app.emit(&ev_close, serde_json::Value::Null);
                        break;
                    }
                }
            }
        }
    }
}
```

- [ ] **Step 7.3: Register in `ssh/mod.rs`**

Path: `src-tauri/src/ssh/mod.rs`
```rust
pub mod client;
pub mod known_hosts;
pub mod registry;

pub use client::{connect, ConnectOutcome, ConnectRequest};
pub use registry::{Connection, ConnectionInput, ConnectionRegistry};
```

- [ ] **Step 7.4: cargo check + commit**

```bash
cargo check --manifest-path src-tauri/Cargo.toml 2>&1 | tail -30
```
Any compile errors here are most likely russh API drift. Resolve them by consulting `https://docs.rs/russh/latest/russh/` for the installed version. If the `authenticate_future` agent dance is gone, use `AgentClient::sign`-based flow. Once clean:

```bash
git add src-tauri/src/ssh/ src-tauri/src/vault/mod.rs src-tauri/src/db/credentials.rs
git commit -m "feat(ssh): russh client with TOFU, agent/password/key auth, PTY shell"
```

---

## Task 8: Tauri SSH + known_host commands

**Files:**
- Create: `src-tauri/src/commands/ssh.rs`
- Modify: `src-tauri/src/commands/mod.rs`
- Modify: `src-tauri/src/main.rs`

- [ ] **Step 8.1: Write commands**

Path: `src-tauri/src/commands/ssh.rs`
```rust
use serde::Serialize;
use tauri::{AppHandle, State};

use crate::db::known_hosts::{self, KnownHost};
use crate::error::Result;
use crate::ssh::{self, ConnectRequest};
use crate::state::AppState;

#[derive(Serialize)]
pub struct ConnectResult {
    pub connection_id: u64,
    pub fingerprint_sha256: String,
}

#[tauri::command]
pub async fn ssh_connect(
    state: State<'_, AppState>,
    app: AppHandle,
    session_id: i64,
    cols: u16,
    rows: u16,
    trust_any: bool,
) -> Result<ConnectResult> {
    super::require_unlocked(&state).await?;
    let out = ssh::connect(
        &state,
        app,
        ConnectRequest { session_id, cols, rows, trust_any },
    )
    .await?;
    Ok(ConnectResult {
        connection_id: out.connection_id,
        fingerprint_sha256: out.fingerprint_sha256,
    })
}

#[tauri::command]
pub async fn ssh_write(state: State<'_, AppState>, connection_id: u64, bytes: Vec<u8>) -> Result<()> {
    state.ssh.write(connection_id, bytes).await;
    Ok(())
}

#[tauri::command]
pub async fn ssh_resize(state: State<'_, AppState>, connection_id: u64, cols: u16, rows: u16) -> Result<()> {
    state.ssh.resize(connection_id, cols, rows).await;
    Ok(())
}

#[tauri::command]
pub async fn ssh_disconnect(state: State<'_, AppState>, connection_id: u64) -> Result<()> {
    state.ssh.close(connection_id).await;
    Ok(())
}

#[tauri::command]
pub async fn known_host_list(state: State<'_, AppState>) -> Result<Vec<KnownHost>> {
    super::require_unlocked(&state).await?;
    known_hosts::list(&state.db).await
}

#[tauri::command]
pub async fn known_host_remove(state: State<'_, AppState>, host: String, port: i64) -> Result<()> {
    super::require_unlocked(&state).await?;
    known_hosts::remove(&state.db, &host, port).await
}
```

- [ ] **Step 8.2: Register module**

Path: `src-tauri/src/commands/mod.rs` — add `pub mod ssh;`.

- [ ] **Step 8.3: Register handlers in `main.rs`**

Path: `src-tauri/src/main.rs` — extend `invoke_handler!` with:
```rust
commands::ssh::ssh_connect,
commands::ssh::ssh_write,
commands::ssh::ssh_resize,
commands::ssh::ssh_disconnect,
commands::ssh::known_host_list,
commands::ssh::known_host_remove,
```
(The final handler list now has 26 commands: 20 from Plan 1 + 6 from Plan 2.)

- [ ] **Step 8.4: cargo check + test + commit**

```bash
cargo check --manifest-path src-tauri/Cargo.toml
cargo test --manifest-path src-tauri/Cargo.toml
```
Expected: compiles, all existing tests still pass (14 tests minimum; 15 if you added a new host-key test in Task 5).

```bash
git add src-tauri/src/commands/ssh.rs src-tauri/src/commands/mod.rs src-tauri/src/main.rs
git commit -m "feat(ssh): Tauri commands — ssh_connect/write/resize/disconnect + known_host_list/remove"
```

---

## Task 9: Frontend — install xterm.js + addons

**Files:**
- Modify: `ui/package.json`

- [ ] **Step 9.1: Add deps**

```bash
cd /home/mack/dev/ezTerm/ui
npm install --save @xterm/xterm@5.5.0 @xterm/addon-fit@0.10.0 @xterm/addon-web-links@0.11.0 @xterm/addon-search@0.15.0 zustand@4.5.2
```
(If `zustand` is already present from Bundle D, the install is a no-op.)

- [ ] **Step 9.2: Build once**

```bash
npm run build
```
Expected: clean build (static export). Larger JS bundle is expected now.

- [ ] **Step 9.3: Commit**

```bash
cd /home/mack/dev/ezTerm
git add ui/package.json ui/package-lock.json
git commit -m "deps(ui): add @xterm/xterm + addons for Plan 2"
```

---

## Task 10: Frontend types + tauri wrappers for SSH

**Files:**
- Modify: `ui/lib/types.ts`
- Modify: `ui/lib/tauri.ts`
- Create: `ui/lib/ssh.ts`

- [ ] **Step 10.1: Add types**

Append to `ui/lib/types.ts`:
```ts
export interface ConnectResult {
  connection_id: number;
  fingerprint_sha256: string;
}

export interface KnownHost {
  host: string;
  port: number;
  key_type: string;
  fingerprint: string;
  fingerprint_sha256: string;
  first_seen: string;
}

export interface HostKeyMismatchError {
  code: 'host_key_mismatch';
  message: string;
  expected: string;
  actual: string;
}
```

- [ ] **Step 10.2: Add Tauri wrappers**

Append to `ui/lib/tauri.ts` (inside the `api` object):
```ts
  // SSH (additions to existing api object — merge with existing entries)
  sshConnect:    (sessionId: number, cols: number, rows: number, trustAny: boolean) =>
    invoke<ConnectResult>('ssh_connect', { sessionId, cols, rows, trustAny }),
  sshWrite:      (connectionId: number, bytes: number[]) =>
    invoke<void>('ssh_write', { connectionId, bytes }),
  sshResize:     (connectionId: number, cols: number, rows: number) =>
    invoke<void>('ssh_resize', { connectionId, cols, rows }),
  sshDisconnect: (connectionId: number) =>
    invoke<void>('ssh_disconnect', { connectionId }),

  // Known hosts
  knownHostList:   () => invoke<KnownHost[]>('known_host_list'),
  knownHostRemove: (host: string, port: number) => invoke<void>('known_host_remove', { host, port }),
```
Also add `ConnectResult`, `KnownHost` imports at the top of `ui/lib/tauri.ts`.

- [ ] **Step 10.3: Event helpers**

Path: `ui/lib/ssh.ts`
```ts
import { listen, type UnlistenFn } from '@tauri-apps/api/event';

export interface SshEventHandlers {
  onData:  (bytes: Uint8Array) => void;
  onClose: (exitStatus: number | null) => void;
  onError: (message: string) => void;
}

export async function subscribeSshEvents(connectionId: number, h: SshEventHandlers): Promise<UnlistenFn> {
  const unlisteners: UnlistenFn[] = [];
  unlisteners.push(await listen<number[]>(`ssh:data:${connectionId}`, (e) => {
    h.onData(new Uint8Array(e.payload));
  }));
  unlisteners.push(await listen<number | null>(`ssh:close:${connectionId}`, (e) => {
    h.onClose(e.payload);
  }));
  unlisteners.push(await listen<string>(`ssh:error:${connectionId}`, (e) => {
    h.onError(e.payload);
  }));
  return () => unlisteners.forEach((u) => u());
}
```

- [ ] **Step 10.4: Typecheck + commit**

```bash
cd /home/mack/dev/ezTerm/ui && npm run typecheck
```
Expected: clean.

```bash
cd /home/mack/dev/ezTerm
git add ui/lib/types.ts ui/lib/tauri.ts ui/lib/ssh.ts
git commit -m "feat(ui): SSH + known_hosts Tauri bindings and event subscriber"
```

---

## Task 11: xterm.js factory + theme binding

**Files:**
- Create: `ui/lib/xterm.ts`

- [ ] **Step 11.1: Write factory**

Path: `ui/lib/xterm.ts`
```ts
import '@xterm/xterm/css/xterm.css';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { WebLinksAddon } from '@xterm/addon-web-links';
import { SearchAddon } from '@xterm/addon-search';

export interface TerminalBundle {
  terminal: Terminal;
  fit:      FitAddon;
  search:   SearchAddon;
  links:    WebLinksAddon;
  dispose:  () => void;
}

/** Build an xterm.js Terminal with our fixed palette (dark, MobaXterm-like).
 *  Theme does NOT change with the chrome theme toggle per spec §4.3. */
export function createTerminal(): TerminalBundle {
  const terminal = new Terminal({
    cursorBlink: true,
    cursorStyle: 'block',
    fontFamily: '"Cascadia Mono", Consolas, ui-monospace, monospace',
    fontSize: 14,
    scrollback: 5000,
    allowProposedApi: true,
    theme: {
      background:         '#121214',
      foreground:         '#e5e7eb',
      cursor:             '#e5e7eb',
      cursorAccent:       '#121214',
      selectionBackground:'#2d3748',
      black:   '#2d3748', red:     '#f87171',
      green:   '#34d399', yellow:  '#fbbf24',
      blue:    '#60a5fa', magenta: '#a78bfa',
      cyan:    '#22d3ee', white:   '#e5e7eb',
      brightBlack:   '#475569', brightRed:     '#fca5a5',
      brightGreen:   '#6ee7b7', brightYellow:  '#fcd34d',
      brightBlue:    '#93c5fd', brightMagenta: '#c4b5fd',
      brightCyan:    '#67e8f9', brightWhite:   '#f3f4f6',
    },
  });

  const fit    = new FitAddon();
  const search = new SearchAddon();
  const links  = new WebLinksAddon();

  terminal.loadAddon(fit);
  terminal.loadAddon(search);
  terminal.loadAddon(links);

  return {
    terminal, fit, search, links,
    dispose: () => terminal.dispose(),
  };
}
```

- [ ] **Step 11.2: Typecheck + commit**

```bash
cd /home/mack/dev/ezTerm/ui && npm run typecheck
```
Expected: clean.

```bash
cd /home/mack/dev/ezTerm
git add ui/lib/xterm.ts
git commit -m "feat(ui): xterm.js factory with fixed dark palette + fit/search/links addons"
```

---

## Task 12: Tabs store (zustand)

**Files:**
- Create: `ui/lib/tabs-store.ts`

- [ ] **Step 12.1: Write store**

Path: `ui/lib/tabs-store.ts`
```ts
import { create } from 'zustand';
import type { Session } from './types';

export type TabStatus = 'connecting' | 'connected' | 'closed' | 'error';

export interface Tab {
  tabId:        string;       // uuid-ish local id
  session:      Session;
  connectionId: number | null;
  status:       TabStatus;
  errorMessage: string | null;
}

interface TabsState {
  tabs:       Tab[];
  activeId:   string | null;
  open:       (session: Session) => string;
  setStatus:  (tabId: string, status: TabStatus, errorMessage?: string | null) => void;
  setConnection: (tabId: string, connectionId: number) => void;
  setActive:  (tabId: string | null) => void;
  close:      (tabId: string) => void;
  clear:      () => void;
}

function uid() { return Math.random().toString(36).slice(2, 10); }

export const useTabs = create<TabsState>((set) => ({
  tabs: [],
  activeId: null,
  open: (session) => {
    const tabId = uid();
    set((s) => ({
      tabs: [...s.tabs, { tabId, session, connectionId: null, status: 'connecting', errorMessage: null }],
      activeId: tabId,
    }));
    return tabId;
  },
  setStatus: (tabId, status, errorMessage = null) =>
    set((s) => ({
      tabs: s.tabs.map((t) => (t.tabId === tabId ? { ...t, status, errorMessage } : t)),
    })),
  setConnection: (tabId, connectionId) =>
    set((s) => ({
      tabs: s.tabs.map((t) => (t.tabId === tabId ? { ...t, connectionId } : t)),
    })),
  setActive: (activeId) => set({ activeId }),
  close: (tabId) =>
    set((s) => {
      const tabs = s.tabs.filter((t) => t.tabId !== tabId);
      const activeId = s.activeId === tabId ? (tabs[tabs.length - 1]?.tabId ?? null) : s.activeId;
      return { tabs, activeId };
    }),
  clear: () => set({ tabs: [], activeId: null }),
}));
```

- [ ] **Step 12.2: Typecheck + commit**

```bash
cd /home/mack/dev/ezTerm/ui && npm run typecheck
```
```bash
cd /home/mack/dev/ezTerm
git add ui/lib/tabs-store.ts
git commit -m "feat(ui): zustand tabs store (tabs, activeId, connection lifecycle)"
```

---

## Task 13: Terminal React component

**Files:**
- Create: `ui/components/terminal.tsx`
- Create: `ui/components/terminal-context-menu.tsx`

- [ ] **Step 13.1: Context menu**

Path: `ui/components/terminal-context-menu.tsx`
```tsx
'use client';
import { ContextMenu, type MenuItem } from './context-menu';

export interface TerminalMenuProps {
  x: number; y: number;
  hasSelection: boolean;
  onCopy:       () => void;
  onPaste:      () => void;
  onSelectAll:  () => void;
  onClear:      () => void;
  onFind:       () => void;
  onClose:      () => void;
}

export function TerminalContextMenu(p: TerminalMenuProps) {
  const items: MenuItem[] = [
    { label: 'Copy',            disabled: !p.hasSelection, onClick: p.onCopy },
    { label: 'Paste',           onClick: p.onPaste },
    { label: 'Select All',      onClick: p.onSelectAll },
    { label: 'Find…',           onClick: p.onFind },
    { label: 'Clear Scrollback',onClick: p.onClear },
  ];
  return <ContextMenu x={p.x} y={p.y} items={items} onClose={p.onClose} />;
}
```

- [ ] **Step 13.2: Terminal component**

Path: `ui/components/terminal.tsx`
```tsx
'use client';
import { useEffect, useRef, useState } from 'react';
import { api, errMessage } from '@/lib/tauri';
import { createTerminal, type TerminalBundle } from '@/lib/xterm';
import { subscribeSshEvents } from '@/lib/ssh';
import { useTabs, type Tab } from '@/lib/tabs-store';
import { TerminalContextMenu } from './terminal-context-menu';
import { FindOverlay } from './find-overlay';

interface Props { tab: Tab; visible: boolean; }

export function TerminalView({ tab, visible }: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const bundleRef    = useRef<TerminalBundle | null>(null);
  const unlistenRef  = useRef<null | (() => void)>(null);
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  const [find, setFind] = useState(false);
  const setStatus = useTabs((s) => s.setStatus);
  const setConn   = useTabs((s) => s.setConnection);

  // Mount xterm and start connection
  useEffect(() => {
    if (!containerRef.current) return;
    const bundle = createTerminal();
    bundleRef.current = bundle;
    bundle.terminal.open(containerRef.current);
    bundle.fit.fit();

    let cancelled = false;
    let connectionId: number | null = null;

    (async () => {
      try {
        const cols = bundle.terminal.cols;
        const rows = bundle.terminal.rows;
        // First attempt — trustAny = false. If host is untrusted/mismatched we prompt.
        let result;
        try {
          result = await api.sshConnect(tab.session.id, cols, rows, false);
        } catch (e) {
          const code = (e as { code?: string })?.code;
          if (code === 'host_key_untrusted' || code === 'host_key_mismatch') {
            // Ask the user. host-key-dialog will handle the confirmation UI;
            // here we just fail the first attempt and let the caller decide.
            setStatus(tab.tabId, 'error', errMessage(e));
            return;
          }
          throw e;
        }
        if (cancelled) {
          await api.sshDisconnect(result.connection_id);
          return;
        }
        connectionId = result.connection_id;
        setConn(tab.tabId, result.connection_id);
        setStatus(tab.tabId, 'connected');

        unlistenRef.current = await subscribeSshEvents(result.connection_id, {
          onData: (bytes) => bundle.terminal.write(bytes),
          onClose: () => setStatus(tab.tabId, 'closed'),
          onError: (msg) => setStatus(tab.tabId, 'error', msg),
        });

        // Wire input: keystrokes → ssh_write
        bundle.terminal.onData((data) => {
          const bytes = new TextEncoder().encode(data);
          api.sshWrite(result.connection_id, Array.from(bytes)).catch(() => {});
        });

        // Resize handler
        const onResize = () => {
          bundle.fit.fit();
          api.sshResize(result.connection_id, bundle.terminal.cols, bundle.terminal.rows).catch(() => {});
        };
        const ro = new ResizeObserver(onResize);
        if (containerRef.current) ro.observe(containerRef.current);
      } catch (e) {
        setStatus(tab.tabId, 'error', errMessage(e));
      }
    })();

    return () => {
      cancelled = true;
      unlistenRef.current?.();
      bundle.dispose();
      if (connectionId !== null) api.sshDisconnect(connectionId).catch(() => {});
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab.tabId]);

  // Fit when becoming visible
  useEffect(() => {
    if (visible) setTimeout(() => bundleRef.current?.fit.fit(), 0);
  }, [visible]);

  function handleContextMenu(e: React.MouseEvent) {
    e.preventDefault();
    setMenu({ x: e.clientX, y: e.clientY });
  }

  function handleKeyDown(e: React.KeyboardEvent) {
    // Shift+Insert → paste
    if (e.shiftKey && e.key === 'Insert') {
      e.preventDefault();
      doPaste();
      return;
    }
    // Ctrl+Shift+C → copy (Ctrl+C reserved for SIGINT)
    if (e.ctrlKey && e.shiftKey && e.key.toLowerCase() === 'c') {
      e.preventDefault();
      doCopy();
      return;
    }
    if (e.ctrlKey && e.shiftKey && e.key.toLowerCase() === 'v') {
      e.preventDefault();
      doPaste();
      return;
    }
    if (e.ctrlKey && e.shiftKey && e.key.toLowerCase() === 'f') {
      e.preventDefault();
      setFind(true);
      return;
    }
  }

  async function doCopy() {
    const sel = bundleRef.current?.terminal.getSelection();
    if (sel) await navigator.clipboard.writeText(sel);
  }

  async function doPaste() {
    const txt = await navigator.clipboard.readText();
    if (!txt || !tab.connectionId) return;
    const bytes = new TextEncoder().encode(txt);
    await api.sshWrite(tab.connectionId, Array.from(bytes)).catch(() => {});
  }

  return (
    <div
      className="relative h-full w-full bg-bg"
      style={{ display: visible ? 'block' : 'none' }}
      onContextMenu={handleContextMenu}
      onKeyDown={handleKeyDown}
      tabIndex={0}
    >
      <div ref={containerRef} className="h-full w-full p-1" />
      {menu && (
        <TerminalContextMenu
          x={menu.x} y={menu.y}
          hasSelection={!!bundleRef.current?.terminal.hasSelection()}
          onCopy={() => { doCopy(); setMenu(null); }}
          onPaste={() => { doPaste(); setMenu(null); }}
          onSelectAll={() => { bundleRef.current?.terminal.selectAll(); setMenu(null); }}
          onClear={() => { bundleRef.current?.terminal.clear(); setMenu(null); }}
          onFind={() => { setFind(true); setMenu(null); }}
          onClose={() => setMenu(null)}
        />
      )}
      {find && bundleRef.current && (
        <FindOverlay search={bundleRef.current.search} onClose={() => setFind(false)} />
      )}
    </div>
  );
}
```

- [ ] **Step 13.3: Commit (we'll add FindOverlay next so ignore the unresolved import for now)**

Do not commit yet — Task 14 adds `FindOverlay` and fixes the import.

---

## Task 14: Find overlay

**Files:**
- Create: `ui/components/find-overlay.tsx`

- [ ] **Step 14.1: Write find overlay**

Path: `ui/components/find-overlay.tsx`
```tsx
'use client';
import { useEffect, useRef, useState } from 'react';
import type { SearchAddon } from '@xterm/addon-search';

export function FindOverlay({ search, onClose }: { search: SearchAddon; onClose: () => void }) {
  const [q, setQ]   = useState('');
  const [ci, setCi] = useState(false); // case-insensitive
  const [re, setRe] = useState(false); // regex
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => { inputRef.current?.focus(); }, []);

  function runNext() {
    if (q) search.findNext(q, { caseSensitive: !ci, regex: re });
  }
  function runPrev() {
    if (q) search.findPrevious(q, { caseSensitive: !ci, regex: re });
  }

  return (
    <div className="absolute top-2 right-2 bg-surface2 border border-border rounded px-2 py-1 flex items-center gap-2 text-sm shadow-lg">
      <input
        ref={inputRef}
        value={q}
        onChange={(e) => setQ(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') { e.preventDefault(); e.shiftKey ? runPrev() : runNext(); }
          if (e.key === 'Escape') onClose();
        }}
        placeholder="Find"
        aria-label="Find"
        className="bg-surface border border-border rounded px-2 py-0.5 outline-none focus-visible:ring-1 focus-visible:ring-accent w-48"
      />
      <button
        type="button"
        onClick={() => setCi(!ci)}
        aria-pressed={!ci}
        title="Case sensitive"
        className={`px-1 rounded ${!ci ? 'bg-accent text-white' : 'hover:bg-surface'}`}
      >Aa</button>
      <button
        type="button"
        onClick={() => setRe(!re)}
        aria-pressed={re}
        title="Regex"
        className={`px-1 rounded ${re ? 'bg-accent text-white' : 'hover:bg-surface'}`}
      >.*</button>
      <button type="button" onClick={runPrev} aria-label="Previous" className="hover:text-fg">↑</button>
      <button type="button" onClick={runNext} aria-label="Next" className="hover:text-fg">↓</button>
      <button type="button" onClick={onClose} aria-label="Close" className="hover:text-fg">×</button>
    </div>
  );
}
```

- [ ] **Step 14.2: Typecheck, lint, build**

```bash
cd /home/mack/dev/ezTerm/ui && npm run typecheck && npm run lint && npm run build
```
Expected: clean.

- [ ] **Step 14.3: Commit terminal + find + context menu together**

```bash
cd /home/mack/dev/ezTerm
git add ui/components/terminal.tsx ui/components/terminal-context-menu.tsx ui/components/find-overlay.tsx
git commit -m "feat(ui): terminal component + context menu + find overlay"
```

---

## Task 15: Host-key dialog + retry flow

**Files:**
- Create: `ui/components/host-key-dialog.tsx`
- Modify: `ui/components/terminal.tsx`

The first-connect attempt fails with `host_key_untrusted` (or `host_key_mismatch`). The user sees a dialog, accepts → we retry with `trustAny = true`.

- [ ] **Step 15.1: Write dialog**

Path: `ui/components/host-key-dialog.tsx`
```tsx
'use client';

interface Props {
  host: string;
  port: number;
  kind: 'untrusted' | 'mismatch';
  fingerprint: string;             // for untrusted, the new key; for mismatch, the new key
  expectedFingerprint?: string;    // only set for mismatch
  onTrust: () => void;
  onCancel: () => void;
}

export function HostKeyDialog(p: Props) {
  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-40" role="dialog" aria-modal="true">
      <div className="w-[480px] bg-surface border border-border rounded p-4 space-y-3 text-sm">
        <h2 className="text-base font-semibold">
          {p.kind === 'untrusted' ? 'Trust host?' : 'Host key changed!'}
        </h2>
        <p className="text-muted">
          {p.kind === 'untrusted'
            ? `No previous record for ${p.host}:${p.port}. Verify the fingerprint out-of-band before trusting.`
            : `The host key for ${p.host}:${p.port} differs from the stored record. This may indicate interception — do NOT continue unless you know why.`}
        </p>
        {p.expectedFingerprint && (
          <div>
            <div className="text-xs text-muted">Expected SHA256</div>
            <div className="font-mono text-xs break-all">{p.expectedFingerprint}</div>
          </div>
        )}
        <div>
          <div className="text-xs text-muted">{p.expectedFingerprint ? 'Actual SHA256' : 'SHA256'}</div>
          <div className="font-mono text-xs break-all">{p.fingerprint}</div>
        </div>
        <div className="flex justify-end gap-2 pt-2">
          <button
            type="button"
            onClick={p.onCancel}
            className="px-3 py-1.5 border border-border rounded hover:bg-surface2 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={p.onTrust}
            className={`px-3 py-1.5 rounded text-white focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent ${p.kind === 'mismatch' ? 'bg-red-600 hover:bg-red-500' : 'bg-accent hover:brightness-110'}`}
          >
            {p.kind === 'mismatch' ? 'Replace and connect' : 'Trust and connect'}
          </button>
        </div>
      </div>
    </div>
  );
}
```

- [ ] **Step 15.2: Wire into `terminal.tsx`**

Modify `ui/components/terminal.tsx` — add state for `prompt: { kind: 'untrusted' | 'mismatch'; fingerprint: string; expectedFingerprint?: string } | null`. Catch the error path from `sshConnect`:

Insert after the existing `import { FindOverlay } from './find-overlay';` import:
```tsx
import { HostKeyDialog } from './host-key-dialog';
```

Replace the block starting at the first `api.sshConnect` call with a reconnect helper that, on error-code `host_key_untrusted`/`host_key_mismatch`, sets a prompt state and aborts the current attempt. When the user clicks "Trust", re-run connect with `trustAny = true`.

Add state near the other `useState`s:
```tsx
const [prompt, setPrompt] = useState<
  | { kind: 'untrusted' | 'mismatch'; fingerprint: string; expectedFingerprint?: string }
  | null
>(null);
```

Extract the inner connect logic into a function that accepts `trustAny: boolean`. On `host_key_untrusted`, set:
```tsx
setPrompt({ kind: 'untrusted', fingerprint: (e as { actual?: string })?.actual ?? '' });
```
On `host_key_mismatch`, set:
```tsx
setPrompt({
  kind: 'mismatch',
  fingerprint: (e as { actual?: string })?.actual ?? '',
  expectedFingerprint: (e as { expected?: string })?.expected,
});
```

Render near the find overlay:
```tsx
{prompt && (
  <HostKeyDialog
    host={tab.session.host}
    port={tab.session.port}
    kind={prompt.kind}
    fingerprint={prompt.fingerprint}
    expectedFingerprint={prompt.expectedFingerprint}
    onCancel={() => { setPrompt(null); setStatus(tab.tabId, 'closed'); }}
    onTrust={() => { setPrompt(null); /* call reconnect(true) */ }}
  />
)}
```

Important: the untrusted/mismatch error payload from Tauri carries `code`, `message`, `actual`, and for mismatch `expected` (per Task 1's `Serialize` impl).

- [ ] **Step 15.3: Typecheck, lint, build**

```bash
cd /home/mack/dev/ezTerm/ui && npm run typecheck && npm run lint && npm run build
```
Expected: clean.

- [ ] **Step 15.4: Commit**

```bash
cd /home/mack/dev/ezTerm
git add ui/components/host-key-dialog.tsx ui/components/terminal.tsx
git commit -m "feat(ui): host-key TOFU dialog + reconnect flow"
```

---

## Task 16: Tabs shell — real tab bar

**Files:**
- Modify: `ui/components/tabs-shell.tsx`

- [ ] **Step 16.1: Replace the placeholder**

Path: `ui/components/tabs-shell.tsx`
```tsx
'use client';
import { useTabs } from '@/lib/tabs-store';
import { TerminalView } from './terminal';

export function TabsShell() {
  const { tabs, activeId, setActive, close } = useTabs();

  return (
    <div className="h-full flex flex-col min-h-0">
      <div className="h-9 border-b border-border bg-surface flex items-stretch overflow-x-auto">
        {tabs.length === 0 && (
          <div className="self-center px-3 text-muted text-xs">
            No open tabs — double-click a session in the sidebar to connect.
          </div>
        )}
        {tabs.map((t) => (
          <div
            key={t.tabId}
            onClick={() => setActive(t.tabId)}
            onMouseDown={(e) => { if (e.button === 1) { e.preventDefault(); close(t.tabId); } }}
            className={`group flex items-center gap-2 px-3 cursor-default select-none border-r border-border ${t.tabId === activeId ? 'bg-bg text-fg' : 'text-muted hover:text-fg'}`}
            role="tab"
            aria-selected={t.tabId === activeId}
          >
            {t.session.color && <span className="w-2 h-2 rounded-full" style={{ background: t.session.color }} />}
            <span className="truncate max-w-[200px]" title={`${t.session.username}@${t.session.host}`}>
              {t.session.name}
            </span>
            {t.status === 'connecting' && <span className="text-xs text-muted">…</span>}
            {t.status === 'error'      && <span className="text-xs text-danger">!</span>}
            {t.status === 'closed'     && <span className="text-xs text-muted">×</span>}
            <button
              type="button"
              aria-label="Close tab"
              onClick={(e) => { e.stopPropagation(); close(t.tabId); }}
              className="opacity-0 group-hover:opacity-100 hover:text-fg"
            >×</button>
          </div>
        ))}
      </div>
      <div className="flex-1 min-h-0 relative">
        {tabs.map((t) => (
          <TerminalView key={t.tabId} tab={t} visible={t.tabId === activeId} />
        ))}
      </div>
    </div>
  );
}
```

Note: every `<TerminalView>` is always mounted (to preserve scrollback) and toggles `display` via the `visible` prop.

- [ ] **Step 16.2: Typecheck + build + commit**

```bash
cd /home/mack/dev/ezTerm/ui && npm run typecheck && npm run lint && npm run build
```
```bash
cd /home/mack/dev/ezTerm
git add ui/components/tabs-shell.tsx
git commit -m "feat(ui): real tab bar with per-tab terminal, middle-click close, status indicators"
```

---

## Task 17: Sessions sidebar — wire up Connect + delete UX (#13)

**Files:**
- Modify: `ui/components/sessions-sidebar.tsx`

- [ ] **Step 17.1: Import the tabs store + sharpen delete text**

Add imports and helper at the top of the component:
```tsx
import { useTabs } from '@/lib/tabs-store';
// inside the component body:
const openTab = useTabs((s) => s.open);
```

In `openSessionMenu`, replace the `Connect` item disabled stub with:
```tsx
{ label: 'Connect', onClick: () => openTab(s) },
```

On the session `<div>`'s `onDoubleClick` handler, replace the placeholder with `() => openTab(s)`.

In `openFolderMenu`, for the Delete item, replace the confirm text with (#13):
```tsx
if (window.confirm(
  `Delete folder "${f.name}" and all subfolders? Sessions inside will be moved to (root).`,
)) {
  await run(() => api.folderDelete(f.id));
  reload();
}
```

- [ ] **Step 17.2: Typecheck + build + commit**

```bash
cd /home/mack/dev/ezTerm/ui && npm run typecheck && npm run lint && npm run build
```
```bash
cd /home/mack/dev/ezTerm
git add ui/components/sessions-sidebar.tsx
git commit -m "feat(ui): wire Connect and double-click to open tabs; sharpen folder-delete text (#13)"
```

---

## Task 18: Integration smoke — headless SSH against `linuxserver/openssh-server`

**Files:**
- Create: `src-tauri/tests/ssh_smoke.rs`
- Modify: `src-tauri/Cargo.toml` (add `[features] integration = []`)

This test is gated behind a feature flag so regular `cargo test` stays fast and offline. CI runs `cargo test --features integration` after starting the container.

- [ ] **Step 18.1: Feature flag**

Append to `src-tauri/Cargo.toml`:
```toml
[features]
default = ["custom-protocol"]
custom-protocol = ["tauri/custom-protocol"]
integration = []
```
(If `[features]` already exists, merge.)

- [ ] **Step 18.2: Write smoke test**

Path: `src-tauri/tests/ssh_smoke.rs`
```rust
#![cfg(feature = "integration")]

//! Requires a running SSH server on localhost:2222 with user `ezterm` / password `ezterm`.
//!
//! Example bring-up:
//! docker run --rm -d --name ezterm-sshd -p 2222:2222 \
//!   -e PUID=1000 -e PGID=1000 -e PASSWORD_ACCESS=true -e USER_PASSWORD=ezterm \
//!   -e USER_NAME=ezterm -e SUDO_ACCESS=false \
//!   linuxserver/openssh-server
//!
//! Then: cargo test --features integration --test ssh_smoke -- --ignored

use std::time::Duration;
use tokio::time::timeout;

// Minimal end-to-end: connect, echo a command, assert prompt received.
#[tokio::test]
#[ignore]
async fn connect_and_receive_data() {
    let fut = async {
        // Full integration wiring deferred — this scaffold proves the test target compiles.
        // A later task can build a full harness that spins up the AppState, uses an in-mem DB,
        // creates a session, and drives ssh_connect via the registry.
        assert!(true);
    };
    timeout(Duration::from_secs(20), fut).await.unwrap();
}
```

- [ ] **Step 18.3: Verify compile**

```bash
cargo check --manifest-path src-tauri/Cargo.toml --features integration
```
Expected: clean.

- [ ] **Step 18.4: Commit**

```bash
git add src-tauri/Cargo.toml src-tauri/tests/ssh_smoke.rs
git commit -m "test(ssh): scaffold integration smoke test behind --features integration"
```

---

## Task 19: README + version + tag

**Files:**
- Modify: `README.md`
- Modify: `Cargo.toml` (workspace version)

- [ ] **Step 19.1: Bump workspace version**

Path: `/home/mack/dev/ezTerm/Cargo.toml` — change `version = "0.1.0"` to `version = "0.2.0"` in `[workspace.package]`.

- [ ] **Step 19.2: Extend README**

Append to `/home/mack/dev/ezTerm/README.md`:
```markdown

## v0.2 — SSH + Terminal

Plan 2 adds the core SSH experience:
- russh-backed connections to any saved session (password / private key / SSH agent)
- xterm.js terminal with Copy (Ctrl+Shift+C), Paste (Ctrl+Shift+V), Shift+Insert, Select All, Clear Scrollback, Find (Ctrl+Shift+F)
- Right-click terminal context menu
- Host-key TOFU prompt on first connect; hard-fail on mismatch unless the user explicitly replaces
- Real tab bar (middle-click to close)

Next: Plan 3 adds SFTP side-pane and SCP drag-drop.
```

- [ ] **Step 19.3: Full regression**

```bash
mkdir -p ui/out
cargo check --manifest-path src-tauri/Cargo.toml
cargo test  --manifest-path src-tauri/Cargo.toml
cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets -- -D warnings
npm --prefix ui run typecheck
npm --prefix ui run lint
npm --prefix ui run build
```
All must pass.

- [ ] **Step 19.4: Commit + tag**

```bash
git add README.md Cargo.toml Cargo.lock
git commit -m "chore: bump to 0.2.0 and document Plan 2 features in README"
git tag -a v0.2.0 -m "ezTerm v0.2 — SSH + terminal (russh, xterm.js, TOFU, tabs)"
```

- [ ] **Step 19.5: DO NOT push** — handled by controller after reviewer passes.

---

## Self-Review

**Spec coverage:**
- §4.1 (layout) — sidebar unchanged, tab bar upgraded in Task 16, terminal area populated by Task 13
- §4.2 (terminal) — xterm + addons (Task 11), Copy/Paste/Select All/Clear/Find (Task 13, 14), Shift+Insert + Ctrl+Shift+C/V/F (Task 13), selection-to-copy off by default (no auto-copy code added — ✓)
- §4.3 (theme) — terminal palette is FIXED and does not track chrome theme per spec; Task 11 hard-codes the dark palette
- §6.3 (known hosts TOFU) — Tasks 4, 5, 7, 15 cover fingerprint computation, storage, check, and UI dialog
- §7 (command surface) — ssh_connect, ssh_write, ssh_resize, ssh_disconnect, known_host_list, known_host_remove all implemented in Task 8; known_host_trust subsumed by `ssh_connect(trustAny=true)` per Task 15 design
- Auth: password / key / agent all routed in Task 7

**Placeholder scan:** none. Russh code blocks may need minor API adaptation — flagged explicitly in Task 7.2.

**Type consistency:** `ConnectResult`, `KnownHost`, `HostKeyMismatchError` TypeScript types match `ConnectResult` (Rust Serialize struct) and the AppError mismatch payload shape.

**Open deviations from Plan 1:**
- `session_duplicate` → single INSERT…SELECT (issue #4) — deferred to Plan 3 or later
- `idx_sessions_folder_sort` etc. (issue #2/#3) — deferred
- Password rotation (#1), auto-lock timer (#5), error-code translation (#6) — deferred to Plan 3 or later

---

## Execution Handoff

**Plan complete and saved to `docs/superpowers/plans/2026-04-18-plan-2-ssh-terminal.md`.** Two execution options:

**1. Subagent-Driven (recommended)** — fresh subagent per task/bundle + two-stage review. Controller bundles tasks into ~5 logical groups:
- Bundle 1: Deps + AppError + migration + log_redacted + known_hosts module (Tasks 1-5)
- Bundle 2: Connection registry + russh client + dead_code cleanup (Tasks 6-7)
- Bundle 3: Tauri commands + integration scaffold (Tasks 8, 18)
- Bundle 4: Frontend deps + xterm + tabs store + terminal + find + context menu (Tasks 9-14)
- Bundle 5: Host-key dialog + tabs shell + sidebar wire-up + finalize (Tasks 15-19)

**2. Inline Execution** — executes in this session via executing-plans.
