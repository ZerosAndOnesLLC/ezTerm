# SSH Port Forwarding Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship SSH port forwarding (`-L`, `-R`, `-D`) inside ezTerm sessions. Forwards can be persisted per-session and auto-start with the connection, or added ad-hoc to a live tab. UI is a side pane modeled on the SFTP pane, plus a "Forwards" tab in the session edit dialog.

**Architecture:** A new `ssh/forwards/` submodule owns the runtime — one file per forward kind plus shared types. Each live forward has its own listener task that opens new russh channels (`channel_open_direct_tcpip` for L/D, accepts inbound `forwarded-tcpip` for R) and pumps bytes with `tokio::io::copy_bidirectional`. A new `forwarded_tcpip_dispatch` table on `Connection` routes inbound R channels by `(bind_addr, bind_port)` to the right forward task. Persistent forwards live in a new `session_forwards` table; auto-start runs at the end of `ssh::connect_impl`. The frontend talks to the runtime via Tauri commands and a `forwards:status:{connection_id}` event for live updates.

**Tech Stack:** russh 0.60 (already a dep — exposes `channel_open_direct_tcpip`, `tcpip_forward`, `cancel_tcpip_forward`, `server_channel_open_forwarded_tcpip`), tokio (`copy_bidirectional`, `TcpListener`, oneshot/mpsc), sqlx (new migration + repo), hand-rolled SOCKS5 server (RFC 1928 §3 greeting + §4 CONNECT only). No new crate dependencies.

**Spec reference:** `docs/superpowers/specs/2026-05-11-ssh-port-forwarding-design.md`

**GH issue:** Closes [#33](https://github.com/ZerosAndOnesLLC/ezTerm/issues/33).

---

## File Map

**Rust (new)**

| File | Responsibility |
|------|---------------|
| `migrations/<ts>_session_forwards.sql` | `session_forwards` table + index |
| `src-tauri/src/db/forwards.rs` | `Forward`, `ForwardInput`, list/list_auto_start/create/update/delete/reorder; kind-shape validation |
| `src-tauri/src/ssh/forwards/mod.rs` | Shared types: `ForwardKind`, `ForwardSpec`, `ForwardStatus`, `RuntimeForward`, `RuntimeForwardSummary`; per-Connection `Forwards` registry struct |
| `src-tauri/src/ssh/forwards/local.rs` | `-L` runtime: bind, accept, `channel_open_direct_tcpip`, `copy_bidirectional` |
| `src-tauri/src/ssh/forwards/remote.rs` | `-R` runtime: `tcpip_forward`, dispatch-table registration, per-channel TCP connect + pump, `cancel_tcpip_forward` |
| `src-tauri/src/ssh/forwards/socks5.rs` | Pure SOCKS5 parsers/encoders (no I/O), unit-tested |
| `src-tauri/src/ssh/forwards/dynamic.rs` | `-D` runtime: accept loop, drives `socks5.rs`, opens `channel_open_direct_tcpip` per client |
| `src-tauri/src/commands/forwards.rs` | Tauri commands (persistent + runtime) |

**Rust (modified)**

| File | Responsibility |
|------|---------------|
| `src-tauri/src/db/mod.rs` | `pub mod forwards;` |
| `src-tauri/src/db/sessions.rs` | No change (CASCADE handles delete) |
| `src-tauri/src/ssh/mod.rs` | `pub mod forwards;` |
| `src-tauri/src/ssh/client.rs` | `ClientHandler` gains `forwarded_tcpip_dispatch` field + `server_channel_open_forwarded_tcpip` callback; `connect_impl` wires dispatch into `Connection` + runs auto-start scan |
| `src-tauri/src/ssh/registry.rs` | `Connection` gains `forwards: Forwards` + `forwarded_tcpip_dispatch`; `close()` calls `forwards.stop_all()` before remove |
| `src-tauri/src/commands/mod.rs` | `pub mod forwards;` |
| `src-tauri/src/main.rs` | Register the 9 new commands |
| `Cargo.toml` (workspace) | Bump `version = "1.3.0"` at the end |

**Frontend (new)**

| File | Responsibility |
|------|---------------|
| `ui/components/forward-dialog.tsx` | Modal: add/edit one forward (ephemeral or persistent) |
| `ui/components/forwards-pane.tsx` | Side pane on the active tab — list + add + start/stop/edit/delete |

**Frontend (modified)**

| File | Responsibility |
|------|---------------|
| `ui/lib/types.ts` | `ForwardKind`, `ForwardSpec`, `Forward`, `ForwardStatus`, `RuntimeForward`, `ForwardStartTarget` |
| `ui/lib/tauri.ts` | New `forwards*` api methods + `subscribeForwardEvents` helper |
| `ui/components/session-dialog.tsx` | New `TabKey = 'forwards'`; `ForwardsPane` for persistent config; unsaved-session staging |
| `ui/components/tabs-shell.tsx` | Forwards toolbar toggle + side-pane mount alongside SFTP |
| `ui/components/terminal.tsx` | Subscribe to `forwards:status` events; route to pane state |

---

## Pre-flight

- [ ] **Step P.1: Branch + clean tree**

```bash
cd /home/mack/dev/ezTerm
git checkout feat/ssh-port-forwarding   # spec already committed here
git status                              # must be clean
```

- [ ] **Step P.2: cargo check baseline**

```bash
cargo check --manifest-path src-tauri/Cargo.toml
```

Expected: clean build (only the pre-existing `VCXSRV_INSTALLER_URL` dead-code warning).

---

## Task 1: DB migration + `db/forwards.rs`

**Files:**
- Create: `migrations/<ts>_session_forwards.sql`
- Create: `src-tauri/src/db/forwards.rs`
- Modify: `src-tauri/src/db/mod.rs`

- [ ] **Step 1.1: Create migration via sqlx (timestamped name)**

```bash
cd /home/mack/dev/ezTerm
# CLAUDE.md rule: use sqlx so the timestamp is correct.
DATABASE_URL=sqlite:dev.sqlite sqlx migrate add session_forwards
```

This creates `migrations/<ts>_session_forwards.sql` with empty body.

- [ ] **Step 1.2: Fill in the migration**

Replace the empty migration body with:

```sql
-- Persistent SSH port forwards. One row per configured forward; auto-start
-- runs at the end of ssh::connect_impl for any row with auto_start = 1.
-- ON DELETE CASCADE removes forwards when their session row is deleted.
--
-- For kind='dynamic' the dest_addr/dest_port columns are stored as ''/0
-- (the destination is chosen per-connection by the SOCKS5 client).
-- Rust-side validation in db::forwards enforces the per-kind shape.

CREATE TABLE session_forwards (
  id           INTEGER PRIMARY KEY,
  session_id   INTEGER NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  name         TEXT NOT NULL DEFAULT '',
  kind         TEXT NOT NULL CHECK (kind IN ('local','remote','dynamic')),
  bind_addr    TEXT NOT NULL DEFAULT '127.0.0.1',
  bind_port    INTEGER NOT NULL CHECK (bind_port BETWEEN 1 AND 65535),
  dest_addr    TEXT NOT NULL DEFAULT '',
  dest_port    INTEGER NOT NULL DEFAULT 0,
  auto_start   INTEGER NOT NULL DEFAULT 1,
  sort         INTEGER NOT NULL DEFAULT 0,
  created_at   TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX idx_session_forwards_session
  ON session_forwards(session_id, sort);
```

- [ ] **Step 1.3: Run the migration against dev DB**

```bash
DATABASE_URL=sqlite:dev.sqlite sqlx migrate run
sqlite3 dev.sqlite ".schema session_forwards"
```

Expected: the `CREATE TABLE` echoes back.

- [ ] **Step 1.4: Write the failing tests for `db/forwards.rs`**

Create `src-tauri/src/db/forwards.rs`:

```rust
use serde::{Deserialize, Serialize};
use sqlx::{FromRow, SqlitePool};

use crate::error::{AppError, Result};

#[derive(Clone, Debug, Serialize, Deserialize, FromRow)]
pub struct Forward {
    pub id:         i64,
    pub session_id: i64,
    pub name:       String,
    pub kind:       String,        // 'local' | 'remote' | 'dynamic'
    pub bind_addr:  String,
    pub bind_port:  i64,
    pub dest_addr:  String,
    pub dest_port:  i64,
    pub auto_start: i64,
    pub sort:       i64,
    pub created_at: String,
}

#[derive(Clone, Debug, Deserialize)]
pub struct ForwardInput {
    pub name:       String,
    pub kind:       String,
    pub bind_addr:  String,
    pub bind_port:  i64,
    pub dest_addr:  String,
    pub dest_port:  i64,
    pub auto_start: i64,
}

/// Validates the kind-specific shape of a `ForwardInput`. Local/Remote
/// require non-empty `dest_addr` and a 1..=65535 `dest_port`. Dynamic
/// requires `dest_addr` empty and `dest_port` zero (the destination is
/// chosen per-connection by the SOCKS5 client).
pub fn validate_input(input: &ForwardInput) -> Result<()> {
    match input.kind.as_str() {
        "local" | "remote" => {
            if input.dest_addr.trim().is_empty() {
                return Err(AppError::Validation(
                    "dest_addr is required for local/remote forwards".into(),
                ));
            }
            if !(1..=65535).contains(&input.dest_port) {
                return Err(AppError::Validation(
                    "dest_port must be 1..=65535".into(),
                ));
            }
        }
        "dynamic" => {
            if !input.dest_addr.is_empty() || input.dest_port != 0 {
                return Err(AppError::Validation(
                    "dynamic forwards must have empty dest_addr and dest_port=0".into(),
                ));
            }
        }
        other => {
            return Err(AppError::Validation(format!("invalid forward kind: {other}")));
        }
    }
    if !(1..=65535).contains(&input.bind_port) {
        return Err(AppError::Validation("bind_port must be 1..=65535".into()));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn base() -> ForwardInput {
        ForwardInput {
            name: String::new(),
            kind: "local".into(),
            bind_addr: "127.0.0.1".into(),
            bind_port: 5432,
            dest_addr: "db.internal".into(),
            dest_port: 5432,
            auto_start: 1,
        }
    }

    #[test]
    fn local_requires_dest() {
        let mut i = base(); i.dest_addr = "".into();
        assert!(validate_input(&i).is_err());
    }

    #[test]
    fn local_dest_port_range() {
        let mut i = base(); i.dest_port = 0;
        assert!(validate_input(&i).is_err());
        i.dest_port = 70_000;
        assert!(validate_input(&i).is_err());
    }

    #[test]
    fn dynamic_must_have_no_dest() {
        let mut i = base();
        i.kind = "dynamic".into();
        i.dest_addr = "".into();
        i.dest_port = 0;
        assert!(validate_input(&i).is_ok());

        i.dest_addr = "evil".into();
        assert!(validate_input(&i).is_err());
    }

    #[test]
    fn bind_port_range() {
        let mut i = base(); i.bind_port = 0;
        assert!(validate_input(&i).is_err());
    }

    #[test]
    fn unknown_kind_rejected() {
        let mut i = base(); i.kind = "udp".into();
        assert!(validate_input(&i).is_err());
    }
}
```

- [ ] **Step 1.5: Register the module + run tests**

In `src-tauri/src/db/mod.rs`, add:
```rust
pub mod forwards;
```

Run:
```bash
cargo test --manifest-path src-tauri/Cargo.toml --bin ezterm db::forwards::tests
```

Expected: all 5 tests pass.

- [ ] **Step 1.6: Implement the CRUD functions**

Append to `src-tauri/src/db/forwards.rs`:

```rust
const SELECT_COLS: &str = "id, session_id, name, kind, bind_addr, bind_port, \
                           dest_addr, dest_port, auto_start, sort, created_at";

pub async fn list_for_session(pool: &SqlitePool, session_id: i64) -> Result<Vec<Forward>> {
    let sql = format!(
        "SELECT {SELECT_COLS} FROM session_forwards \
         WHERE session_id = ? ORDER BY sort, id"
    );
    Ok(sqlx::query_as::<_, Forward>(&sql).bind(session_id).fetch_all(pool).await?)
}

pub async fn list_auto_start(pool: &SqlitePool, session_id: i64) -> Result<Vec<Forward>> {
    let sql = format!(
        "SELECT {SELECT_COLS} FROM session_forwards \
         WHERE session_id = ? AND auto_start = 1 ORDER BY sort, id"
    );
    Ok(sqlx::query_as::<_, Forward>(&sql).bind(session_id).fetch_all(pool).await?)
}

pub async fn get(pool: &SqlitePool, id: i64) -> Result<Forward> {
    let sql = format!("SELECT {SELECT_COLS} FROM session_forwards WHERE id = ?");
    sqlx::query_as::<_, Forward>(&sql).bind(id)
        .fetch_optional(pool).await?
        .ok_or(AppError::NotFound)
}

pub async fn create(
    pool: &SqlitePool,
    session_id: i64,
    input: &ForwardInput,
) -> Result<Forward> {
    validate_input(input)?;
    // Append to end of the session's forward list.
    let next_sort: i64 = sqlx::query_scalar(
        "SELECT COALESCE(MAX(sort), -1) + 1 FROM session_forwards WHERE session_id = ?",
    )
    .bind(session_id)
    .fetch_one(pool)
    .await?;

    let id: i64 = sqlx::query_scalar(
        "INSERT INTO session_forwards \
         (session_id, name, kind, bind_addr, bind_port, dest_addr, dest_port, auto_start, sort) \
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id",
    )
    .bind(session_id)
    .bind(&input.name)
    .bind(&input.kind)
    .bind(&input.bind_addr)
    .bind(input.bind_port)
    .bind(&input.dest_addr)
    .bind(input.dest_port)
    .bind(input.auto_start)
    .bind(next_sort)
    .fetch_one(pool)
    .await?;
    get(pool, id).await
}

pub async fn update(pool: &SqlitePool, id: i64, input: &ForwardInput) -> Result<Forward> {
    validate_input(input)?;
    sqlx::query(
        "UPDATE session_forwards \
         SET name = ?, kind = ?, bind_addr = ?, bind_port = ?, \
             dest_addr = ?, dest_port = ?, auto_start = ? \
         WHERE id = ?",
    )
    .bind(&input.name)
    .bind(&input.kind)
    .bind(&input.bind_addr)
    .bind(input.bind_port)
    .bind(&input.dest_addr)
    .bind(input.dest_port)
    .bind(input.auto_start)
    .bind(id)
    .execute(pool)
    .await?;
    get(pool, id).await
}

pub async fn delete(pool: &SqlitePool, id: i64) -> Result<()> {
    sqlx::query("DELETE FROM session_forwards WHERE id = ?")
        .bind(id).execute(pool).await?;
    Ok(())
}

pub async fn reorder(pool: &SqlitePool, session_id: i64, ids: &[i64]) -> Result<()> {
    let mut tx = pool.begin().await?;
    for (i, fid) in ids.iter().enumerate() {
        sqlx::query("UPDATE session_forwards SET sort = ? WHERE id = ? AND session_id = ?")
            .bind(i as i64).bind(fid).bind(session_id)
            .execute(&mut *tx).await?;
    }
    tx.commit().await?;
    Ok(())
}
```

- [ ] **Step 1.7: Cargo check + commit**

```bash
cargo check --manifest-path src-tauri/Cargo.toml
```
Expected: clean (pre-existing warning only).

Bump Cargo.toml `version = "1.2.3"` and commit:

```bash
git add migrations/ src-tauri/src/db/forwards.rs src-tauri/src/db/mod.rs Cargo.toml Cargo.lock
git commit -m "feat(db): session_forwards table + repo with validation (#33)"
```

---

## Task 2: Shared forward types + `Forwards` registry

**Files:**
- Create: `src-tauri/src/ssh/forwards/mod.rs`
- Modify: `src-tauri/src/ssh/mod.rs`
- Modify: `src-tauri/src/ssh/registry.rs`

- [ ] **Step 2.1: Create the forwards module with shared types**

Create `src-tauri/src/ssh/forwards/mod.rs`:

```rust
//! Per-Connection port-forwarding runtime. Each live forward (one of
//! Local/Remote/Dynamic) owns one listener task and zero-or-more
//! per-connection pump tasks. The `Forwards` struct on `Connection`
//! tracks them by a u64 runtime id; the dispatch table routes inbound
//! Remote channels back to the right forward.
//!
//! Per-forward task layout:
//!
//!   Local:    [TcpListener]   accept → channel_open_direct_tcpip → copy_bidirectional
//!   Remote:   [russh tcpip_forward]   incoming channel via dispatch → TcpStream::connect → copy_bidirectional
//!   Dynamic:  [TcpListener]   accept → SOCKS5 handshake → channel_open_direct_tcpip → copy_bidirectional
//!
//! Teardown is driven by a `oneshot::Sender<()>` per forward (`stop_tx`).
//! Dropping it triggers the listener task to exit; per-connection pumps
//! die naturally when either side EOFs.

use std::collections::HashMap;
use std::sync::{Arc, Mutex as StdMutex};

use serde::{Deserialize, Serialize};
use tokio::sync::{mpsc, oneshot, Mutex, RwLock};

use russh::{client::Msg, Channel};

pub mod local;
pub mod remote;
pub mod socks5;
pub mod dynamic;

#[derive(Clone, Copy, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum ForwardKind { Local, Remote, Dynamic }

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct ForwardSpec {
    pub name:      String,
    pub kind:      ForwardKind,
    pub bind_addr: String,
    pub bind_port: u16,
    pub dest_addr: String,   // "" for Dynamic
    pub dest_port: u16,      //  0 for Dynamic
}

#[derive(Clone, Debug, Serialize)]
#[serde(tag = "status", rename_all = "lowercase")]
pub enum ForwardStatus {
    Starting,
    Running,
    Restarting,
    Stopped,
    Error { message: String },
}

pub struct RuntimeForward {
    pub id:            u64,
    pub persistent_id: Option<i64>,
    pub spec:          ForwardSpec,
    pub status:        StdMutex<ForwardStatus>,
    pub stop_tx:       Mutex<Option<oneshot::Sender<()>>>,
}

#[derive(Clone, Serialize)]
pub struct RuntimeForwardSummary {
    pub runtime_id:    u64,
    pub persistent_id: Option<i64>,
    pub spec:          ForwardSpec,
    pub status:        ForwardStatus,
}

impl RuntimeForward {
    pub fn summary(&self) -> RuntimeForwardSummary {
        RuntimeForwardSummary {
            runtime_id:    self.id,
            persistent_id: self.persistent_id,
            spec:          self.spec.clone(),
            status:        self.status.lock().expect("forward status poisoned").clone(),
        }
    }

    pub fn set_status(&self, s: ForwardStatus) {
        *self.status.lock().expect("forward status poisoned") = s;
    }
}

/// Per-Connection registry of live forwards plus the dispatch table that
/// routes inbound `forwarded-tcpip` channels (Remote forwards) back to
/// the owning forward's task.
#[derive(Default)]
pub struct Forwards {
    pub by_id: RwLock<HashMap<u64, Arc<RuntimeForward>>>,
    pub next_id: std::sync::atomic::AtomicU64,
    pub dispatch: Arc<RwLock<HashMap<(String, u32), mpsc::Sender<Channel<Msg>>>>>,
}

impl Forwards {
    pub fn new() -> Self { Self::default() }

    pub fn alloc_id(&self) -> u64 {
        use std::sync::atomic::Ordering;
        self.next_id.fetch_add(1, Ordering::Relaxed) + 1
    }

    pub async fn insert(&self, rf: Arc<RuntimeForward>) {
        self.by_id.write().await.insert(rf.id, rf);
    }

    pub async fn remove(&self, id: u64) -> Option<Arc<RuntimeForward>> {
        self.by_id.write().await.remove(&id)
    }

    pub async fn get(&self, id: u64) -> Option<Arc<RuntimeForward>> {
        self.by_id.read().await.get(&id).cloned()
    }

    pub async fn list(&self) -> Vec<RuntimeForwardSummary> {
        self.by_id.read().await.values().map(|rf| rf.summary()).collect()
    }

    /// Tear down every live forward. Called from `Connection::close()`
    /// before the russh handle is dropped, so listener tasks have a chance
    /// to exit cleanly. Per-connection pump tasks die when channels close.
    pub async fn stop_all(&self) {
        let ids: Vec<u64> = self.by_id.read().await.keys().copied().collect();
        for id in ids {
            if let Some(rf) = self.by_id.write().await.remove(&id) {
                if let Some(tx) = rf.stop_tx.lock().await.take() {
                    let _ = tx.send(());
                }
            }
        }
    }
}
```

- [ ] **Step 2.2: Add empty submodule files (stubs so the mod tree compiles)**

```bash
touch src-tauri/src/ssh/forwards/local.rs \
      src-tauri/src/ssh/forwards/remote.rs \
      src-tauri/src/ssh/forwards/socks5.rs \
      src-tauri/src/ssh/forwards/dynamic.rs
```

These are filled in by Tasks 4-7.

- [ ] **Step 2.3: Register `forwards` in `ssh/mod.rs`**

`src-tauri/src/ssh/mod.rs` — add:
```rust
pub mod forwards;
```

- [ ] **Step 2.4: Extend `Connection` in `ssh/registry.rs`**

Add to the `Connection` struct (after the `x11_display` field):

```rust
    /// Per-connection port-forwarding runtime. Created empty at insert
    /// time; populated by `commands::forwards::forward_start` and by
    /// the auto-start scan in `connect_impl`.
    pub forwards: Arc<crate::ssh::forwards::Forwards>,
```

In `ConnectionRegistry::close`, replace the body with:

```rust
    pub async fn close(&self, id: u64) {
        let conn = self.inner.write().await.remove(&id);
        if let Some(c) = conn {
            // Stop forwards before signalling the driver to drop the
            // russh handle — listener tasks need the handle to send
            // cancel_tcpip_forward for Remote forwards.
            c.forwards.stop_all().await;
            let _ = c.stdin.send(ConnectionInput::Close);
        }
    }
```

- [ ] **Step 2.5: Wire `forwards: Forwards::new().into()` into `Connection` construction**

In `src-tauri/src/ssh/client.rs`, find where `Connection { ... }` is constructed inside `connect_impl` (around line 400-430) and add:

```rust
forwards: Arc::new(crate::ssh::forwards::Forwards::new()),
```

- [ ] **Step 2.6: Cargo check + commit**

```bash
cargo check --manifest-path src-tauri/Cargo.toml
```
Expected: clean. The empty `local.rs`/`remote.rs`/etc. compile as empty modules.

Bump Cargo.toml `version = "1.2.4"`. Commit:

```bash
git add src-tauri/src/ssh/ Cargo.toml Cargo.lock
git commit -m "feat(ssh): forwards module skeleton + Connection registry (#33)"
```

---

## Task 3: `ClientHandler` accepts inbound forwarded-tcpip channels

**Files:**
- Modify: `src-tauri/src/ssh/client.rs`

- [ ] **Step 3.1: Add the dispatch field to `ClientHandler`**

In `src-tauri/src/ssh/client.rs`, change the `ClientHandler` struct (around line 42):

```rust
pub struct ClientHandler {
    server_key: Arc<StdMutex<Option<(String, String)>>>,
    x11_display: Option<u8>,
    /// Shared dispatch table for inbound `forwarded-tcpip` channels.
    /// Populated by `ssh::forwards::remote::start` when a `-R` forward
    /// is created; the callback below looks up `(bind_addr, bind_port)`
    /// and shoves the inbound russh channel onto the matching sender.
    /// Keyed on (addr, port) because that's what the server echoes back.
    forwarded_tcpip_dispatch: Arc<tokio::sync::RwLock<
        std::collections::HashMap<(String, u32), tokio::sync::mpsc::Sender<russh::Channel<russh::client::Msg>>>
    >>,
}
```

- [ ] **Step 3.2: Add the callback**

Inside `impl client::Handler for ClientHandler`, alongside `server_channel_open_x11`, add:

```rust
    /// Server is forwarding a TCP connection back to us on a port we
    /// previously requested via `tcpip_forward`. Route the channel to
    /// the right forward task; drop it (russh closes server-side) if
    /// the forward has since been cancelled.
    async fn server_channel_open_forwarded_tcpip(
        &mut self,
        channel: russh::Channel<russh::client::Msg>,
        connected_address: &str,
        connected_port: u32,
        _originator_address: &str,
        _originator_port: u32,
        _session: &mut russh::client::Session,
    ) -> std::result::Result<(), Self::Error> {
        let key = (connected_address.to_string(), connected_port);
        let tx = {
            let map = self.forwarded_tcpip_dispatch.read().await;
            map.get(&key).cloned()
        };
        if let Some(tx) = tx {
            // try_send so we never block russh's event loop. If the
            // forward task is wedged, drop the channel — pragmatic
            // backpressure for what should be an unbounded inflow.
            let _ = tx.try_send(channel);
        }
        Ok(())
    }
```

- [ ] **Step 3.3: Initialize the field and share it with the Connection**

In `connect_impl` find where `ClientHandler { ... }` is constructed (around line 210). Replace with:

```rust
    let forwarded_tcpip_dispatch: Arc<tokio::sync::RwLock<_>> =
        Arc::new(tokio::sync::RwLock::new(std::collections::HashMap::new()));
    let handler = ClientHandler {
        server_key: Arc::new(StdMutex::new(None)),
        x11_display,
        forwarded_tcpip_dispatch: forwarded_tcpip_dispatch.clone(),
    };
```

Then where the `Forwards` is constructed in Step 2.5, replace with:

```rust
    let forwards = Arc::new(crate::ssh::forwards::Forwards {
        by_id: Default::default(),
        next_id: Default::default(),
        dispatch: forwarded_tcpip_dispatch.clone(),
    });
```

And use `forwards.clone()` in the `Connection` struct literal.

- [ ] **Step 3.4: Cargo check + commit**

```bash
cargo check --manifest-path src-tauri/Cargo.toml
```

Bump to `1.2.5`. Commit:

```bash
git add src-tauri/src/ Cargo.toml Cargo.lock
git commit -m "feat(ssh): wire forwarded-tcpip callback + shared dispatch table (#33)"
```

---

## Task 4: Local (`-L`) forward runtime

**Files:**
- Modify: `src-tauri/src/ssh/forwards/local.rs`

- [ ] **Step 4.1: Implement `start_local`**

Replace the empty `local.rs` with:

```rust
//! Local (`-L`) forward. Bind a TCP listener locally; for each accept,
//! open a `direct-tcpip` channel through the SSH handle to the
//! destination on the server side and pump bytes in both directions.

use std::sync::Arc;

use russh::client::{Handle, Msg};
use russh::Channel;
use tokio::io::copy_bidirectional;
use tokio::net::TcpListener;
use tokio::sync::{oneshot, Mutex};

use super::{ForwardSpec, ForwardStatus, RuntimeForward};
use crate::error::{AppError, Result};
use crate::ssh::client::ClientHandler;

/// Start a local-forward listener. Returns the populated `RuntimeForward`
/// (status = Running on success, Error on bind failure).
pub async fn start(
    handle: Arc<Mutex<Handle<ClientHandler>>>,
    spec: ForwardSpec,
    runtime_id: u64,
    persistent_id: Option<i64>,
    on_status: Arc<dyn Fn(super::RuntimeForwardSummary) + Send + Sync>,
) -> Result<Arc<RuntimeForward>> {
    let bind = format!("{}:{}", spec.bind_addr, spec.bind_port);
    let listener = TcpListener::bind(&bind).await.map_err(|e| {
        AppError::Ssh(format!("local forward bind {bind}: {e}"))
    })?;

    let (stop_tx, mut stop_rx) = oneshot::channel::<()>();
    let rf = Arc::new(RuntimeForward {
        id:            runtime_id,
        persistent_id,
        spec:          spec.clone(),
        status:        std::sync::Mutex::new(ForwardStatus::Running),
        stop_tx:       Mutex::new(Some(stop_tx)),
    });

    let rf_task = rf.clone();
    let on_status_task = on_status.clone();
    tokio::spawn(async move {
        loop {
            tokio::select! {
                _ = &mut stop_rx => break,
                accept = listener.accept() => {
                    let (mut tcp, peer) = match accept {
                        Ok(p) => p,
                        Err(e) => {
                            tracing::warn!("local forward accept error: {e}");
                            rf_task.set_status(ForwardStatus::Error { message: format!("accept: {e}") });
                            on_status_task(rf_task.summary());
                            break;
                        }
                    };
                    let handle = handle.clone();
                    let spec = spec.clone();
                    tokio::spawn(async move {
                        let chan = {
                            let mut h = handle.lock().await;
                            h.channel_open_direct_tcpip(
                                spec.dest_addr.clone(),
                                spec.dest_port as u32,
                                peer.ip().to_string(),
                                peer.port() as u32,
                            ).await
                        };
                        let channel = match chan {
                            Ok(c) => c,
                            Err(e) => {
                                tracing::warn!(
                                    "local forward direct-tcpip {}:{} failed: {e}",
                                    spec.dest_addr, spec.dest_port,
                                );
                                return;
                            }
                        };
                        pump(channel, &mut tcp).await;
                    });
                }
            }
        }
        rf_task.set_status(ForwardStatus::Stopped);
        on_status_task(rf_task.summary());
    });

    on_status(rf.summary());
    Ok(rf)
}

async fn pump(channel: Channel<Msg>, tcp: &mut tokio::net::TcpStream) {
    let mut stream = channel.into_stream();
    let _ = copy_bidirectional(&mut stream, tcp).await;
}
```

- [ ] **Step 4.2: Cargo check + commit**

```bash
cargo check --manifest-path src-tauri/Cargo.toml
```

Bump to `1.2.6`. Commit:

```bash
git add src-tauri/src/ssh/forwards/local.rs Cargo.toml Cargo.lock
git commit -m "feat(ssh): local (-L) forward runtime (#33)"
```

(Integration test arrives in Task 8 after the command surface lands.)

---

## Task 5: Remote (`-R`) forward runtime

**Files:**
- Modify: `src-tauri/src/ssh/forwards/remote.rs`

- [ ] **Step 5.1: Implement `start_remote`**

Replace the empty `remote.rs` with:

```rust
//! Remote (`-R`) forward. Sends `tcpip_forward` to the server so it
//! starts listening on the remote side; channels for each inbound
//! connection arrive at our `ClientHandler::server_channel_open_forwarded_tcpip`
//! callback and are dispatched here by `(bind_addr, bind_port)`.

use std::sync::Arc;

use russh::client::{Handle, Msg};
use russh::Channel;
use tokio::io::copy_bidirectional;
use tokio::net::TcpStream;
use tokio::sync::{mpsc, oneshot, Mutex, RwLock};

use super::{ForwardSpec, ForwardStatus, RuntimeForward};
use crate::error::{AppError, Result};
use crate::ssh::client::ClientHandler;

const INBOUND_QUEUE_DEPTH: usize = 32;

pub async fn start(
    handle: Arc<Mutex<Handle<ClientHandler>>>,
    dispatch: Arc<RwLock<std::collections::HashMap<(String, u32), mpsc::Sender<Channel<Msg>>>>>,
    spec: ForwardSpec,
    runtime_id: u64,
    persistent_id: Option<i64>,
    on_status: Arc<dyn Fn(super::RuntimeForwardSummary) + Send + Sync>,
) -> Result<Arc<RuntimeForward>> {
    let key = (spec.bind_addr.clone(), spec.bind_port as u32);
    let (tx, mut rx) = mpsc::channel::<Channel<Msg>>(INBOUND_QUEUE_DEPTH);
    dispatch.write().await.insert(key.clone(), tx);

    // Request the forward on the server side. If the server rejects
    // (e.g. AllowTcpForwarding no, or port in use), back out the
    // dispatch entry and surface the error.
    let req = {
        let mut h = handle.lock().await;
        h.tcpip_forward(spec.bind_addr.clone(), spec.bind_port as u32).await
    };
    if let Err(e) = req {
        dispatch.write().await.remove(&key);
        return Err(AppError::Ssh(format!("tcpip_forward {}:{}: {e}",
            spec.bind_addr, spec.bind_port)));
    }

    let (stop_tx, mut stop_rx) = oneshot::channel::<()>();
    let rf = Arc::new(RuntimeForward {
        id:            runtime_id,
        persistent_id,
        spec:          spec.clone(),
        status:        std::sync::Mutex::new(ForwardStatus::Running),
        stop_tx:       Mutex::new(Some(stop_tx)),
    });

    let rf_task = rf.clone();
    let on_status_task = on_status.clone();
    let dispatch_task = dispatch.clone();
    let handle_task = handle.clone();
    tokio::spawn(async move {
        loop {
            tokio::select! {
                _ = &mut stop_rx => break,
                ch = rx.recv() => {
                    let Some(channel) = ch else { break; };
                    let spec = spec.clone();
                    tokio::spawn(async move {
                        let mut tcp = match TcpStream::connect(
                            (spec.dest_addr.as_str(), spec.dest_port),
                        ).await {
                            Ok(t) => t,
                            Err(e) => {
                                tracing::warn!(
                                    "remote forward dest connect {}:{} failed: {e}",
                                    spec.dest_addr, spec.dest_port,
                                );
                                return;
                            }
                        };
                        let mut stream = channel.into_stream();
                        let _ = copy_bidirectional(&mut stream, &mut tcp).await;
                    });
                }
            }
        }
        // Cancel on the server, drop the dispatch entry, then mark stopped.
        let _ = {
            let mut h = handle_task.lock().await;
            h.cancel_tcpip_forward(spec.bind_addr.clone(), spec.bind_port as u32).await
        };
        dispatch_task.write().await.remove(&key);
        rf_task.set_status(ForwardStatus::Stopped);
        on_status_task(rf_task.summary());
    });

    on_status(rf.summary());
    Ok(rf)
}
```

- [ ] **Step 5.2: Cargo check + commit**

```bash
cargo check --manifest-path src-tauri/Cargo.toml
```

Bump to `1.2.7`. Commit:

```bash
git add src-tauri/src/ssh/forwards/remote.rs Cargo.toml Cargo.lock
git commit -m "feat(ssh): remote (-R) forward runtime (#33)"
```

---

## Task 6: SOCKS5 protocol module (unit-tested)

**Files:**
- Modify: `src-tauri/src/ssh/forwards/socks5.rs`

- [ ] **Step 6.1: Write the failing tests first**

Replace `socks5.rs` with:

```rust
//! Minimal SOCKS5 server-side helpers for the Dynamic (`-D`) forward.
//! No I/O lives here — parsers take `&[u8]`, encoders return `Vec<u8>`.
//! Only the bits the spec calls out: greeting + CONNECT request.
//! See spec §"Dynamic forwards" for the wire format we accept/reject.

use thiserror::Error;

#[derive(Debug, Error, PartialEq, Eq)]
pub enum Socks5Error {
    #[error("short read")]
    Short,
    #[error("unsupported SOCKS version: {0}")]
    BadVersion(u8),
    #[error("unsupported address type: {0}")]
    BadAtyp(u8),
    #[error("unsupported command: {0}")]
    BadCommand(u8),
    #[error("no acceptable auth method")]
    NoAuth,
    #[error("invalid domain length")]
    BadDomain,
}

/// Parsed CONNECT request. We only support CMD = 01 (CONNECT).
#[derive(Debug, PartialEq, Eq)]
pub struct ConnectRequest {
    pub host: String,   // IPv4/IPv6 stringified, or domain
    pub port: u16,
}

/// Parse the SOCKS5 greeting (`VER NMETHODS METHODS...`). Returns Ok(())
/// if `0x00` (no-auth) is offered; otherwise `Err(NoAuth)`.
pub fn parse_greeting(buf: &[u8]) -> Result<(), Socks5Error> {
    if buf.len() < 2 { return Err(Socks5Error::Short); }
    if buf[0] != 0x05 { return Err(Socks5Error::BadVersion(buf[0])); }
    let nmethods = buf[1] as usize;
    if buf.len() < 2 + nmethods { return Err(Socks5Error::Short); }
    if buf[2..2 + nmethods].contains(&0x00) {
        Ok(())
    } else {
        Err(Socks5Error::NoAuth)
    }
}

/// Greeting reply: `[VER, METHOD]`. `accept = true` ⇒ 0x00 (no auth);
/// false ⇒ 0xFF (no acceptable methods).
pub fn encode_greeting_reply(accept: bool) -> [u8; 2] {
    [0x05, if accept { 0x00 } else { 0xFF }]
}

/// Parse the SOCKS5 request (`VER CMD RSV ATYP DST.ADDR DST.PORT`).
pub fn parse_request(buf: &[u8]) -> Result<ConnectRequest, Socks5Error> {
    if buf.len() < 4 { return Err(Socks5Error::Short); }
    if buf[0] != 0x05 { return Err(Socks5Error::BadVersion(buf[0])); }
    if buf[1] != 0x01 { return Err(Socks5Error::BadCommand(buf[1])); }
    // buf[2] reserved, ignore.
    let (host, port_off) = match buf[3] {
        0x01 => {
            // IPv4
            if buf.len() < 4 + 4 + 2 { return Err(Socks5Error::Short); }
            let ip = std::net::Ipv4Addr::new(buf[4], buf[5], buf[6], buf[7]);
            (ip.to_string(), 4 + 4)
        }
        0x03 => {
            // Domain — first byte is length.
            if buf.len() < 5 { return Err(Socks5Error::Short); }
            let len = buf[4] as usize;
            if len == 0 { return Err(Socks5Error::BadDomain); }
            if buf.len() < 5 + len + 2 { return Err(Socks5Error::Short); }
            let domain = std::str::from_utf8(&buf[5..5 + len])
                .map_err(|_| Socks5Error::BadDomain)?
                .to_string();
            (domain, 5 + len)
        }
        0x04 => {
            // IPv6
            if buf.len() < 4 + 16 + 2 { return Err(Socks5Error::Short); }
            let mut octets = [0u8; 16];
            octets.copy_from_slice(&buf[4..20]);
            let ip = std::net::Ipv6Addr::from(octets);
            (ip.to_string(), 4 + 16)
        }
        atyp => return Err(Socks5Error::BadAtyp(atyp)),
    };
    let port = u16::from_be_bytes([buf[port_off], buf[port_off + 1]]);
    Ok(ConnectRequest { host, port })
}

/// Reply byte codes (RFC 1928 §6). We only use Success, GeneralFailure,
/// HostUnreachable, ConnectionRefused, and CommandNotSupported.
pub mod rep {
    pub const SUCCESS:                u8 = 0x00;
    pub const GENERAL_FAILURE:        u8 = 0x01;
    pub const HOST_UNREACHABLE:       u8 = 0x04;
    pub const CONNECTION_REFUSED:     u8 = 0x05;
    pub const COMMAND_NOT_SUPPORTED:  u8 = 0x07;
    pub const ADDRESS_TYPE_NOT_SUPPORTED: u8 = 0x08;
}

/// Encode a CONNECT reply: `[VER, REP, RSV, ATYP=0x01, BND.ADDR(4)=0,
/// BND.PORT(2)=0]`. We always report `0.0.0.0:0` because russh doesn't
/// expose the locally-bound socket; clients are required to handle this
/// case per RFC.
pub fn encode_reply(rep: u8) -> [u8; 10] {
    [0x05, rep, 0x00, 0x01, 0, 0, 0, 0, 0, 0]
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn greeting_accepts_no_auth() {
        assert_eq!(parse_greeting(&[0x05, 0x01, 0x00]), Ok(()));
        assert_eq!(parse_greeting(&[0x05, 0x02, 0x02, 0x00]), Ok(()));
    }

    #[test]
    fn greeting_rejects_auth_only() {
        assert_eq!(parse_greeting(&[0x05, 0x01, 0x02]), Err(Socks5Error::NoAuth));
    }

    #[test]
    fn greeting_short() {
        assert_eq!(parse_greeting(&[0x05]), Err(Socks5Error::Short));
        assert_eq!(parse_greeting(&[0x05, 0x02, 0x00]), Err(Socks5Error::Short));
    }

    #[test]
    fn greeting_bad_version() {
        assert_eq!(parse_greeting(&[0x04, 0x01, 0x00]), Err(Socks5Error::BadVersion(4)));
    }

    #[test]
    fn request_ipv4() {
        // VER=05 CMD=01 RSV=00 ATYP=01 1.2.3.4:80
        let buf = [0x05, 0x01, 0x00, 0x01, 1, 2, 3, 4, 0x00, 0x50];
        assert_eq!(parse_request(&buf), Ok(ConnectRequest { host: "1.2.3.4".into(), port: 80 }));
    }

    #[test]
    fn request_domain() {
        // ATYP=03 len=10 "example.com" :443
        let mut buf = vec![0x05, 0x01, 0x00, 0x03, 11];
        buf.extend_from_slice(b"example.com");
        buf.extend_from_slice(&[0x01, 0xBB]);
        assert_eq!(parse_request(&buf), Ok(ConnectRequest { host: "example.com".into(), port: 443 }));
    }

    #[test]
    fn request_ipv6() {
        let mut buf = vec![0x05, 0x01, 0x00, 0x04];
        buf.extend_from_slice(&[0xfe,0x80,0,0,0,0,0,0,0,0,0,0,0,0,0,1]);
        buf.extend_from_slice(&[0x00, 0x50]);
        assert_eq!(parse_request(&buf), Ok(ConnectRequest { host: "fe80::1".into(), port: 80 }));
    }

    #[test]
    fn request_unsupported_command() {
        let buf = [0x05, 0x02, 0x00, 0x01, 1, 1, 1, 1, 0, 0]; // BIND
        assert_eq!(parse_request(&buf), Err(Socks5Error::BadCommand(2)));
    }

    #[test]
    fn request_unsupported_atyp() {
        let buf = [0x05, 0x01, 0x00, 0x05, 0, 0, 0, 0];
        assert_eq!(parse_request(&buf), Err(Socks5Error::BadAtyp(5)));
    }

    #[test]
    fn request_empty_domain_rejected() {
        let buf = [0x05, 0x01, 0x00, 0x03, 0x00];
        assert_eq!(parse_request(&buf), Err(Socks5Error::BadDomain));
    }

    #[test]
    fn request_short() {
        assert_eq!(parse_request(&[0x05, 0x01, 0x00]), Err(Socks5Error::Short));
        // Domain header but truncated body
        assert_eq!(parse_request(&[0x05, 0x01, 0x00, 0x03, 5, b'a']), Err(Socks5Error::Short));
    }

    #[test]
    fn reply_encoding() {
        assert_eq!(encode_reply(rep::SUCCESS), [0x05, 0, 0, 0x01, 0, 0, 0, 0, 0, 0]);
        assert_eq!(encode_greeting_reply(true),  [0x05, 0x00]);
        assert_eq!(encode_greeting_reply(false), [0x05, 0xFF]);
    }
}
```

- [ ] **Step 6.2: Run tests**

```bash
cargo test --manifest-path src-tauri/Cargo.toml --bin ezterm ssh::forwards::socks5::
```

Expected: 12 tests pass.

- [ ] **Step 6.3: Bump + commit**

Bump Cargo.toml to `1.2.8`.

```bash
git add src-tauri/src/ssh/forwards/socks5.rs Cargo.toml Cargo.lock
git commit -m "feat(ssh): SOCKS5 protocol helpers (parse + encode) (#33)"
```

---

## Task 7: Dynamic (`-D`) forward runtime

**Files:**
- Modify: `src-tauri/src/ssh/forwards/dynamic.rs`

- [ ] **Step 7.1: Implement the SOCKS5 server loop**

Replace `dynamic.rs` with:

```rust
//! Dynamic (`-D`) forward. Local TCP listener that speaks the
//! server-side of SOCKS5; for each accepted client, parses the
//! greeting + CONNECT request and opens a direct-tcpip channel to
//! the requested host through the SSH handle.

use std::sync::Arc;

use russh::client::{Handle, Msg};
use tokio::io::{AsyncReadExt, AsyncWriteExt, copy_bidirectional};
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::{oneshot, Mutex};

use super::socks5::{self, ConnectRequest, Socks5Error};
use super::{ForwardSpec, ForwardStatus, RuntimeForward};
use crate::error::{AppError, Result};
use crate::ssh::client::ClientHandler;

pub async fn start(
    handle: Arc<Mutex<Handle<ClientHandler>>>,
    spec: ForwardSpec,
    runtime_id: u64,
    persistent_id: Option<i64>,
    on_status: Arc<dyn Fn(super::RuntimeForwardSummary) + Send + Sync>,
) -> Result<Arc<RuntimeForward>> {
    let bind = format!("{}:{}", spec.bind_addr, spec.bind_port);
    let listener = TcpListener::bind(&bind).await.map_err(|e| {
        AppError::Ssh(format!("dynamic forward bind {bind}: {e}"))
    })?;

    let (stop_tx, mut stop_rx) = oneshot::channel::<()>();
    let rf = Arc::new(RuntimeForward {
        id:            runtime_id,
        persistent_id,
        spec:          spec.clone(),
        status:        std::sync::Mutex::new(ForwardStatus::Running),
        stop_tx:       Mutex::new(Some(stop_tx)),
    });

    let rf_task = rf.clone();
    let on_status_task = on_status.clone();
    tokio::spawn(async move {
        loop {
            tokio::select! {
                _ = &mut stop_rx => break,
                accept = listener.accept() => {
                    let (tcp, peer) = match accept {
                        Ok(p) => p,
                        Err(e) => {
                            tracing::warn!("dynamic forward accept error: {e}");
                            rf_task.set_status(ForwardStatus::Error { message: format!("accept: {e}") });
                            on_status_task(rf_task.summary());
                            break;
                        }
                    };
                    let handle = handle.clone();
                    tokio::spawn(async move {
                        handle_client(tcp, peer, handle).await;
                    });
                }
            }
        }
        rf_task.set_status(ForwardStatus::Stopped);
        on_status_task(rf_task.summary());
    });

    on_status(rf.summary());
    Ok(rf)
}

async fn handle_client(
    mut tcp: TcpStream,
    peer: std::net::SocketAddr,
    handle: Arc<Mutex<Handle<ClientHandler>>>,
) {
    // Greeting: read at least VER+NMETHODS, then up to 255 methods.
    let mut hdr = [0u8; 2];
    if tcp.read_exact(&mut hdr).await.is_err() { return; }
    let nmethods = hdr[1] as usize;
    let mut methods = vec![0u8; nmethods];
    if tcp.read_exact(&mut methods).await.is_err() { return; }
    let mut greeting = Vec::with_capacity(2 + nmethods);
    greeting.extend_from_slice(&hdr);
    greeting.extend_from_slice(&methods);
    if socks5::parse_greeting(&greeting).is_err() {
        let _ = tcp.write_all(&socks5::encode_greeting_reply(false)).await;
        return;
    }
    if tcp.write_all(&socks5::encode_greeting_reply(true)).await.is_err() { return; }

    // Request: read fixed prefix VER CMD RSV ATYP (4 bytes), then a
    // variable tail (ATYP-dependent), then 2-byte port.
    let mut prefix = [0u8; 4];
    if tcp.read_exact(&mut prefix).await.is_err() { return; }
    let body_len = match prefix[3] {
        0x01 => 4 + 2,
        0x04 => 16 + 2,
        0x03 => {
            let mut lenbuf = [0u8; 1];
            if tcp.read_exact(&mut lenbuf).await.is_err() { return; }
            // Re-include the length byte in the parser input.
            let mut tail = vec![lenbuf[0]; 1];
            let domain_total = lenbuf[0] as usize + 2;
            tail.resize(1 + lenbuf[0] as usize + 2, 0);
            if tcp.read_exact(&mut tail[1..]).await.is_err() { return; }
            let mut full = Vec::with_capacity(prefix.len() + tail.len());
            full.extend_from_slice(&prefix);
            full.extend_from_slice(&tail);
            dispatch_request(&full, prefix[3], &mut tcp, peer, handle, domain_total).await;
            return;
        }
        _ => {
            let _ = tcp.write_all(&socks5::encode_reply(socks5::rep::ADDRESS_TYPE_NOT_SUPPORTED)).await;
            return;
        }
    };
    let mut tail = vec![0u8; body_len];
    if tcp.read_exact(&mut tail).await.is_err() { return; }
    let mut full = Vec::with_capacity(prefix.len() + tail.len());
    full.extend_from_slice(&prefix);
    full.extend_from_slice(&tail);
    dispatch_request(&full, prefix[3], &mut tcp, peer, handle, body_len).await;
}

async fn dispatch_request(
    full: &[u8],
    _atyp: u8,
    tcp: &mut TcpStream,
    peer: std::net::SocketAddr,
    handle: Arc<Mutex<Handle<ClientHandler>>>,
    _body_len: usize,
) {
    let req: ConnectRequest = match socks5::parse_request(full) {
        Ok(r) => r,
        Err(Socks5Error::BadCommand(_)) => {
            let _ = tcp.write_all(&socks5::encode_reply(socks5::rep::COMMAND_NOT_SUPPORTED)).await;
            return;
        }
        Err(Socks5Error::BadAtyp(_)) => {
            let _ = tcp.write_all(&socks5::encode_reply(socks5::rep::ADDRESS_TYPE_NOT_SUPPORTED)).await;
            return;
        }
        Err(_) => {
            let _ = tcp.write_all(&socks5::encode_reply(socks5::rep::GENERAL_FAILURE)).await;
            return;
        }
    };

    let chan = {
        let mut h = handle.lock().await;
        h.channel_open_direct_tcpip(
            req.host.clone(),
            req.port as u32,
            peer.ip().to_string(),
            peer.port() as u32,
        ).await
    };
    let channel = match chan {
        Ok(c) => c,
        Err(e) => {
            tracing::warn!("dynamic forward direct-tcpip {}:{} failed: {e}",
                req.host, req.port);
            let _ = tcp.write_all(&socks5::encode_reply(socks5::rep::CONNECTION_REFUSED)).await;
            return;
        }
    };

    if tcp.write_all(&socks5::encode_reply(socks5::rep::SUCCESS)).await.is_err() {
        return;
    }
    let mut stream = channel.into_stream();
    let _ = copy_bidirectional(&mut stream, tcp).await;
}
```

- [ ] **Step 7.2: Cargo check + commit**

```bash
cargo check --manifest-path src-tauri/Cargo.toml
```

Bump to `1.2.9`.

```bash
git add src-tauri/src/ssh/forwards/dynamic.rs Cargo.toml Cargo.lock
git commit -m "feat(ssh): dynamic (-D) forward via embedded SOCKS5 server (#33)"
```

---

## Task 8: Tauri commands (`commands/forwards.rs`)

**Files:**
- Create: `src-tauri/src/commands/forwards.rs`
- Modify: `src-tauri/src/commands/mod.rs`
- Modify: `src-tauri/src/main.rs`

- [ ] **Step 8.1: Create the command module**

Create `src-tauri/src/commands/forwards.rs`:

```rust
//! Tauri commands for SSH port forwarding. Persistent commands hit
//! the DB layer; runtime commands operate on the live `Connection`'s
//! `Forwards` registry. Both surfaces emit `forwards:status:{conn_id}`
//! events on every state transition so the side pane stays live.

use std::sync::Arc;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, State};

use crate::commands::require_unlocked;
use crate::db;
use crate::error::{AppError, Result};
use crate::ssh::forwards::{ForwardKind, ForwardSpec, RuntimeForwardSummary};
use crate::state::AppState;

// ---------- Persistent ----------

#[tauri::command]
pub async fn forward_list(
    state: State<'_, AppState>,
    session_id: i64,
) -> Result<Vec<db::forwards::Forward>> {
    require_unlocked(&state).await?;
    db::forwards::list_for_session(&state.db, session_id).await
}

#[tauri::command]
pub async fn forward_create(
    state: State<'_, AppState>,
    session_id: i64,
    input: db::forwards::ForwardInput,
) -> Result<db::forwards::Forward> {
    require_unlocked(&state).await?;
    db::forwards::create(&state.db, session_id, &input).await
}

#[tauri::command]
pub async fn forward_update(
    state: State<'_, AppState>,
    id: i64,
    input: db::forwards::ForwardInput,
) -> Result<db::forwards::Forward> {
    require_unlocked(&state).await?;
    db::forwards::update(&state.db, id, &input).await
}

#[tauri::command]
pub async fn forward_delete(state: State<'_, AppState>, id: i64) -> Result<()> {
    require_unlocked(&state).await?;
    db::forwards::delete(&state.db, id).await
}

#[tauri::command]
pub async fn forward_reorder(
    state: State<'_, AppState>,
    session_id: i64,
    ids: Vec<i64>,
) -> Result<()> {
    require_unlocked(&state).await?;
    db::forwards::reorder(&state.db, session_id, &ids).await
}

// ---------- Runtime ----------

#[derive(Debug, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum ForwardStartTarget {
    Persistent { id: i64 },
    Ephemeral  { spec: ForwardSpec },
}

#[tauri::command]
pub async fn forward_runtime_list(
    state: State<'_, AppState>,
    connection_id: u64,
) -> Result<Vec<RuntimeForwardSummary>> {
    require_unlocked(&state).await?;
    let conn = state.ssh.get(connection_id).await
        .ok_or(AppError::NotFound)?;
    Ok(conn.forwards.list().await)
}

#[tauri::command]
pub async fn forward_start(
    state: State<'_, AppState>,
    app: AppHandle,
    connection_id: u64,
    target: ForwardStartTarget,
) -> Result<RuntimeForwardSummary> {
    require_unlocked(&state).await?;
    let conn = state.ssh.get(connection_id).await
        .ok_or(AppError::NotFound)?;

    let (spec, persistent_id): (ForwardSpec, Option<i64>) = match target {
        ForwardStartTarget::Persistent { id } => {
            let f = db::forwards::get(&state.db, id).await?;
            (spec_from_db(&f)?, Some(id))
        }
        ForwardStartTarget::Ephemeral { spec } => (spec, None),
    };

    start_inner(connection_id, app, conn.forwards.clone(),
                conn.ssh_handle.clone(), spec, persistent_id).await
}

#[tauri::command]
pub async fn forward_stop(
    state: State<'_, AppState>,
    connection_id: u64,
    runtime_id: u64,
) -> Result<()> {
    require_unlocked(&state).await?;
    let conn = state.ssh.get(connection_id).await
        .ok_or(AppError::NotFound)?;
    if let Some(rf) = conn.forwards.remove(runtime_id).await {
        if let Some(tx) = rf.stop_tx.lock().await.take() {
            let _ = tx.send(());
        }
    }
    Ok(())
}

#[tauri::command]
pub async fn forward_stop_all(
    state: State<'_, AppState>,
    connection_id: u64,
) -> Result<()> {
    require_unlocked(&state).await?;
    let conn = state.ssh.get(connection_id).await
        .ok_or(AppError::NotFound)?;
    conn.forwards.stop_all().await;
    Ok(())
}

// ---------- Internal helpers ----------

pub(crate) fn spec_from_db(f: &db::forwards::Forward) -> Result<ForwardSpec> {
    let kind = match f.kind.as_str() {
        "local"   => ForwardKind::Local,
        "remote"  => ForwardKind::Remote,
        "dynamic" => ForwardKind::Dynamic,
        other     => return Err(AppError::Validation(format!("bad kind {other}"))),
    };
    Ok(ForwardSpec {
        name:      f.name.clone(),
        kind,
        bind_addr: f.bind_addr.clone(),
        bind_port: f.bind_port as u16,
        dest_addr: f.dest_addr.clone(),
        dest_port: f.dest_port as u16,
    })
}

/// Pure runtime entry point — used by both `forward_start` and the
/// auto-start scan in `ssh::connect_impl`. Returns the started
/// forward's summary on success.
pub(crate) async fn start_inner(
    connection_id: u64,
    app: AppHandle,
    forwards: Arc<crate::ssh::forwards::Forwards>,
    handle: Arc<tokio::sync::Mutex<russh::client::Handle<crate::ssh::client::ClientHandler>>>,
    spec: ForwardSpec,
    persistent_id: Option<i64>,
) -> Result<RuntimeForwardSummary> {
    let id = forwards.alloc_id();
    let event = format!("forwards:status:{connection_id}");
    let app_emit = app.clone();
    let on_status: Arc<dyn Fn(RuntimeForwardSummary) + Send + Sync> =
        Arc::new(move |s| {
            let _ = app_emit.emit(&event, &s);
        });

    let rf = match spec.kind {
        ForwardKind::Local => {
            crate::ssh::forwards::local::start(
                handle.clone(), spec.clone(), id, persistent_id, on_status.clone(),
            ).await?
        }
        ForwardKind::Remote => {
            crate::ssh::forwards::remote::start(
                handle.clone(), forwards.dispatch.clone(),
                spec.clone(), id, persistent_id, on_status.clone(),
            ).await?
        }
        ForwardKind::Dynamic => {
            crate::ssh::forwards::dynamic::start(
                handle.clone(), spec.clone(), id, persistent_id, on_status.clone(),
            ).await?
        }
    };
    forwards.insert(rf.clone()).await;
    Ok(rf.summary())
}
```

- [ ] **Step 8.2: Wire it into the command tree**

`src-tauri/src/commands/mod.rs` — add `pub mod forwards;`.

`src-tauri/src/main.rs` — extend the `invoke_handler` macro (after the local block) with:

```rust
            commands::forwards::forward_list,
            commands::forwards::forward_create,
            commands::forwards::forward_update,
            commands::forwards::forward_delete,
            commands::forwards::forward_reorder,
            commands::forwards::forward_runtime_list,
            commands::forwards::forward_start,
            commands::forwards::forward_stop,
            commands::forwards::forward_stop_all,
```

- [ ] **Step 8.3: Cargo check + commit**

```bash
cargo check --manifest-path src-tauri/Cargo.toml
```

Bump to `1.2.10`.

```bash
git add src-tauri/ Cargo.toml Cargo.lock
git commit -m "feat(commands): forwards CRUD + runtime + status events (#33)"
```

---

## Task 9: Auto-start scan in `ssh::connect_impl`

**Files:**
- Modify: `src-tauri/src/ssh/client.rs`

- [ ] **Step 9.1: Add the scan at the end of `connect_impl`**

Locate the end of `connect_impl` — the point after `registry.insert(connection).await` and before the `Ok(ConnectOutcome { connection_id })` return. Add:

```rust
    // Auto-start scan. Failures are surfaced via toast (the event fired
    // by start_inner carries an Error status) but never abort the
    // connect — the terminal is still useful even if a forward is
    // misconfigured.
    let auto = crate::db::forwards::list_auto_start(&deps.db, session.id).await
        .unwrap_or_default();
    for f in auto {
        if let Ok(spec) = crate::commands::forwards::spec_from_db(&f) {
            let app2 = app.clone();
            let forwards = forwards.clone();
            let handle_clone = ssh_handle.clone();
            let conn_id = connection_id;
            tokio::spawn(async move {
                if let Err(e) = crate::commands::forwards::start_inner(
                    conn_id, app2.clone(), forwards, handle_clone,
                    spec.clone(), Some(f.id),
                ).await {
                    tracing::warn!("auto-start forward {}:{} failed: {e}",
                        spec.bind_addr, spec.bind_port);
                    let _ = app2.emit(
                        &format!("forwards:status:{conn_id}"),
                        &serde_json::json!({
                            "runtime_id":   0,
                            "persistent_id": f.id,
                            "spec":         spec,
                            "status":       { "status": "error", "message": e.to_string() },
                        }),
                    );
                }
            });
        }
    }
```

You'll need to bind `forwards`, `ssh_handle`, and `connection_id` to local variables before the `registry.insert(connection).await` call so they're still in scope. Adjust as needed.

- [ ] **Step 9.2: Cargo check + commit**

```bash
cargo check --manifest-path src-tauri/Cargo.toml
```

Bump to `1.2.11`.

```bash
git add src-tauri/src/ssh/client.rs Cargo.toml Cargo.lock
git commit -m "feat(ssh): auto-start persistent forwards on connect (#33)"
```

---

## Task 10: Frontend types + API bindings

**Files:**
- Modify: `ui/lib/types.ts`
- Modify: `ui/lib/tauri.ts`

- [ ] **Step 10.1: Add the types**

Append to `ui/lib/types.ts` (after `XServerStatus`):

```ts
// --- Port forwards ----------------------------------------------------------

export type ForwardKind = 'local' | 'remote' | 'dynamic';

export interface ForwardSpec {
  name:      string;
  kind:      ForwardKind;
  bind_addr: string;
  bind_port: number;
  dest_addr: string;
  dest_port: number;
}

export interface Forward extends ForwardSpec {
  id:         number;
  session_id: number;
  auto_start: number;     // 0 | 1
  sort:       number;
  created_at: string;
}

export interface ForwardInput {
  name:       string;
  kind:       ForwardKind;
  bind_addr:  string;
  bind_port:  number;
  dest_addr:  string;
  dest_port:  number;
  auto_start: number;
}

export type ForwardStatus =
  | { status: 'starting'   }
  | { status: 'running'    }
  | { status: 'restarting' }
  | { status: 'stopped'    }
  | { status: 'error'; message: string };

export interface RuntimeForward {
  runtime_id:    number;
  persistent_id: number | null;
  spec:          ForwardSpec;
  status:        ForwardStatus;
}

export type ForwardStartTarget =
  | { kind: 'persistent'; id: number }
  | { kind: 'ephemeral';  spec: ForwardSpec };
```

- [ ] **Step 10.2: Add the api methods**

In `ui/lib/tauri.ts`, import the new types and add (after the local PTY block):

```ts
  // Port forwards (persistent)
  forwardList:    (sessionId: number) => invoke<Forward[]>('forward_list', { sessionId }),
  forwardCreate:  (sessionId: number, input: ForwardInput) =>
    invoke<Forward>('forward_create', { sessionId, input }),
  forwardUpdate:  (id: number, input: ForwardInput) =>
    invoke<Forward>('forward_update', { id, input }),
  forwardDelete:  (id: number) => invoke<void>('forward_delete', { id }),
  forwardReorder: (sessionId: number, ids: number[]) =>
    invoke<void>('forward_reorder', { sessionId, ids }),

  // Port forwards (runtime)
  forwardRuntimeList: (connectionId: number) =>
    invoke<RuntimeForward[]>('forward_runtime_list', { connectionId }),
  forwardStart: (connectionId: number, target: ForwardStartTarget) =>
    invoke<RuntimeForward>('forward_start', { connectionId, target }),
  forwardStop: (connectionId: number, runtimeId: number) =>
    invoke<void>('forward_stop', { connectionId, runtimeId }),
  forwardStopAll: (connectionId: number) =>
    invoke<void>('forward_stop_all', { connectionId }),
```

Also add a subscription helper at the bottom of the file:

```ts
import { listen } from '@tauri-apps/api/event';

export async function subscribeForwardEvents(
  connectionId: number,
  onUpdate: (rf: RuntimeForward) => void,
): Promise<() => void> {
  const un = await listen<RuntimeForward>(
    `forwards:status:${connectionId}`,
    (e) => onUpdate(e.payload),
  );
  return () => { un(); };
}
```

- [ ] **Step 10.3: Type-check + commit**

```bash
cd ui && npx tsc --noEmit && cd ..
```

```bash
git add ui/lib/types.ts ui/lib/tauri.ts
git commit -m "feat(ui): forwards types + tauri bindings + event helper (#33)"
```

---

## Task 11: `forward-dialog.tsx`

**Files:**
- Create: `ui/components/forward-dialog.tsx`

- [ ] **Step 11.1: Build the modal**

Create `ui/components/forward-dialog.tsx`:

```tsx
'use client';
import { useState } from 'react';
import { Network, Server, ArrowLeftRight, Globe2 } from 'lucide-react';
import { api } from '@/lib/tauri';
import type {
  Forward, ForwardInput, ForwardKind, ForwardSpec, RuntimeForward,
} from '@/lib/types';
import { toast } from '@/lib/toast';

type Mode =
  | { mode: 'persistent-create'; sessionId: number }
  | { mode: 'persistent-edit';   forward: Forward }
  | { mode: 'ephemeral-create';  connectionId: number }
  | { mode: 'ephemeral-edit';    connectionId: number; existing: RuntimeForward };

type Props = Mode & {
  onClose: () => void;
  onSaved: (result: Forward | RuntimeForward) => void;
};

const KIND_TILES: { value: ForwardKind; label: string; hint: string; Icon: typeof Network }[] = [
  { value: 'local',   label: 'Local (-L)',   hint: 'localhost → remote target',  Icon: ArrowLeftRight },
  { value: 'remote',  label: 'Remote (-R)',  hint: 'remote bind → local target', Icon: Server },
  { value: 'dynamic', label: 'Dynamic (-D)', hint: 'local SOCKS5 proxy',         Icon: Globe2 },
];

function blankSpec(): ForwardSpec {
  return { name: '', kind: 'local', bind_addr: '127.0.0.1', bind_port: 0, dest_addr: '', dest_port: 0 };
}

export function ForwardDialog(props: Props) {
  const initial: ForwardSpec & { auto_start: number } = (() => {
    if (props.mode === 'persistent-edit') {
      const f = props.forward;
      return { name: f.name, kind: f.kind, bind_addr: f.bind_addr, bind_port: f.bind_port,
               dest_addr: f.dest_addr, dest_port: f.dest_port, auto_start: f.auto_start };
    }
    if (props.mode === 'ephemeral-edit') {
      const s = props.existing.spec;
      return { ...s, auto_start: 0 };
    }
    return { ...blankSpec(), auto_start: 1 };
  })();

  const [v, setV] = useState(initial);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const isPersistent = props.mode === 'persistent-create' || props.mode === 'persistent-edit';
  const isDynamic    = v.kind === 'dynamic';
  const nonLoopback  = v.bind_addr.trim() && !['127.0.0.1', 'localhost', '::1'].includes(v.bind_addr.trim());
  const privileged   = v.bind_port > 0 && v.bind_port < 1024;

  async function submit() {
    setErr(null);
    if (!v.bind_addr.trim()) return setErr('Bind address is required');
    if (v.bind_port < 1 || v.bind_port > 65535) return setErr('Bind port must be 1–65535');
    if (!isDynamic) {
      if (!v.dest_addr.trim()) return setErr('Destination address is required');
      if (v.dest_port < 1 || v.dest_port > 65535) return setErr('Destination port must be 1–65535');
    }
    setBusy(true);
    try {
      if (isPersistent) {
        const input: ForwardInput = {
          name: v.name, kind: v.kind, bind_addr: v.bind_addr, bind_port: v.bind_port,
          dest_addr: isDynamic ? '' : v.dest_addr,
          dest_port: isDynamic ?  0 : v.dest_port,
          auto_start: v.auto_start,
        };
        const out = props.mode === 'persistent-create'
          ? await api.forwardCreate(props.sessionId, input)
          : await api.forwardUpdate(props.forward.id, input);
        props.onSaved(out);
        props.onClose();
      } else {
        const spec: ForwardSpec = {
          name: v.name, kind: v.kind, bind_addr: v.bind_addr, bind_port: v.bind_port,
          dest_addr: isDynamic ? '' : v.dest_addr,
          dest_port: isDynamic ?  0 : v.dest_port,
        };
        if (props.mode === 'ephemeral-edit') {
          await api.forwardStop(props.connectionId, props.existing.runtime_id).catch(() => {});
        }
        const rf = await api.forwardStart(props.connectionId, { kind: 'ephemeral', spec });
        props.onSaved(rf);
        props.onClose();
      }
    } catch (e) {
      const msg = String((e as { message?: string })?.message ?? e);
      setErr(msg);
      toast.danger('Forward save failed', msg);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-black/40">
      <div className="bg-surface text-fg w-[560px] rounded shadow-lg border border-border">
        <div className="px-4 py-3 border-b border-border font-medium">
          {props.mode.startsWith('persistent') ? 'Forward (session config)' : 'Forward (this tab)'}
        </div>
        <div className="p-4 space-y-3">
          <div className="grid grid-cols-3 gap-2">
            {KIND_TILES.map(({ value, label, hint, Icon }) => (
              <button key={value} type="button"
                onClick={() => setV({ ...v, kind: value })}
                className={`flex flex-col items-start gap-1 p-2 rounded border text-left ${
                  v.kind === value
                    ? 'border-accent bg-accent/10'
                    : 'border-border hover:border-muted text-muted hover:text-fg'
                }`}>
                <Icon size={14} />
                <div className="text-sm font-medium">{label}</div>
                <div className="text-xs text-muted">{hint}</div>
              </button>
            ))}
          </div>

          <label className="block">
            <span className="text-xs text-muted">Name (optional)</span>
            <input value={v.name} onChange={(e) => setV({ ...v, name: e.target.value })}
                   className="input mt-1" placeholder="e.g. Postgres dev" />
          </label>

          <div className="grid grid-cols-[1fr_120px] gap-2">
            <label className="block">
              <span className="text-xs text-muted">Bind address</span>
              <input value={v.bind_addr}
                     onChange={(e) => setV({ ...v, bind_addr: e.target.value })}
                     className="input font-mono mt-1" placeholder="127.0.0.1" />
            </label>
            <label className="block">
              <span className="text-xs text-muted">Bind port</span>
              <input type="number" min={1} max={65535} value={v.bind_port || ''}
                     onChange={(e) => setV({ ...v, bind_port: Number(e.target.value) })}
                     className="input mt-1" />
            </label>
          </div>
          {nonLoopback && (
            <div className="text-xs text-warning bg-warning/10 border border-warning/30 rounded px-2 py-1">
              This forward will be reachable from other machines on your network.
            </div>
          )}
          {privileged && (
            <div className="text-xs text-muted">
              Ports below 1024 require admin/root on most systems.
            </div>
          )}

          {!isDynamic && (
            <div className="grid grid-cols-[1fr_120px] gap-2">
              <label className="block">
                <span className="text-xs text-muted">Destination host</span>
                <input value={v.dest_addr}
                       onChange={(e) => setV({ ...v, dest_addr: e.target.value })}
                       className="input font-mono mt-1"
                       placeholder={v.kind === 'remote' ? 'localhost' : 'db.internal'} />
              </label>
              <label className="block">
                <span className="text-xs text-muted">Destination port</span>
                <input type="number" min={1} max={65535} value={v.dest_port || ''}
                       onChange={(e) => setV({ ...v, dest_port: Number(e.target.value) })}
                       className="input mt-1" />
              </label>
            </div>
          )}

          {isPersistent && (
            <label className="flex items-center gap-2">
              <input type="checkbox" checked={v.auto_start === 1}
                     onChange={(e) => setV({ ...v, auto_start: e.target.checked ? 1 : 0 })} />
              <span className="text-sm">Auto-start when the session connects</span>
            </label>
          )}

          {err && <div className="text-sm text-danger">{err}</div>}
        </div>
        <div className="px-4 py-3 border-t border-border flex justify-end gap-2">
          <button type="button" onClick={props.onClose} className="btn-secondary">Cancel</button>
          <button type="button" onClick={submit} disabled={busy} className="btn-primary">
            {busy ? 'Saving…' : 'Save'}
          </button>
        </div>
      </div>
    </div>
  );
}
```

- [ ] **Step 11.2: Type-check + commit**

```bash
cd ui && npx tsc --noEmit && cd ..
```

```bash
git add ui/components/forward-dialog.tsx
git commit -m "feat(ui): forward-dialog modal (create/edit, persistent & ephemeral) (#33)"
```

---

## Task 12: `forwards-pane.tsx`

**Files:**
- Create: `ui/components/forwards-pane.tsx`

- [ ] **Step 12.1: Build the side pane**

Create `ui/components/forwards-pane.tsx`:

```tsx
'use client';
import { useEffect, useState } from 'react';
import {
  ArrowLeftRight, Globe2, MoreHorizontal, Pencil, Play, Plus, Server, Square, Trash2,
} from 'lucide-react';
import { api, subscribeForwardEvents } from '@/lib/tauri';
import type { Forward, RuntimeForward, ForwardKind } from '@/lib/types';
import { ForwardDialog } from './forward-dialog';
import { StatusDot } from './status-dot';
import { toast } from '@/lib/toast';

type Props = {
  sessionId:    number;
  connectionId: number;
};

const KIND_BADGE: Record<ForwardKind, { letter: string; tone: string; Icon: typeof Server }> = {
  local:   { letter: 'L', tone: 'text-blue-400',   Icon: ArrowLeftRight },
  remote:  { letter: 'R', tone: 'text-amber-400',  Icon: Server },
  dynamic: { letter: 'D', tone: 'text-emerald-400', Icon: Globe2 },
};

function autoLabel(rf: RuntimeForward): string {
  const s = rf.spec;
  if (s.name) return s.name;
  if (s.kind === 'dynamic') return `SOCKS5 @ ${s.bind_addr}:${s.bind_port}`;
  return `${s.bind_addr}:${s.bind_port} → ${s.dest_addr}:${s.dest_port}`;
}

function statusTone(rf: RuntimeForward): 'ok' | 'warn' | 'bad' | 'muted' {
  switch (rf.status.status) {
    case 'running':    return 'ok';
    case 'starting':
    case 'restarting': return 'warn';
    case 'error':      return 'bad';
    default:           return 'muted';
  }
}

export function ForwardsPane({ sessionId, connectionId }: Props) {
  const [runtime, setRuntime] = useState<RuntimeForward[]>([]);
  const [persistent, setPersistent] = useState<Forward[]>([]);
  const [dialog, setDialog] = useState<
    | { kind: 'ephemeral-create' }
    | { kind: 'ephemeral-edit'; existing: RuntimeForward }
    | null
  >(null);

  useEffect(() => {
    let unsub: (() => void) | undefined;
    api.forwardRuntimeList(connectionId).then(setRuntime).catch(() => {});
    api.forwardList(sessionId).then(setPersistent).catch(() => {});
    subscribeForwardEvents(connectionId, (rf) => {
      setRuntime((cur) => {
        const idx = cur.findIndex((x) => x.runtime_id === rf.runtime_id);
        if (idx === -1) return [...cur, rf];
        const next = cur.slice();
        next[idx] = rf;
        return next;
      });
    }).then((u) => { unsub = u; });
    return () => { unsub?.(); };
  }, [connectionId, sessionId]);

  async function startPersistent(id: number) {
    try { await api.forwardStart(connectionId, { kind: 'persistent', id }); }
    catch (e) { toast.danger('Start failed', String((e as { message?: string })?.message ?? e)); }
  }
  async function stop(runtimeId: number) {
    try { await api.forwardStop(connectionId, runtimeId); }
    catch (e) { toast.danger('Stop failed', String((e as { message?: string })?.message ?? e)); }
  }

  // Combine persistent rows with their runtime state (if running) so the
  // pane shows every configured forward, started or not.
  const runtimeByPersistent = new Map<number, RuntimeForward>();
  for (const rf of runtime) {
    if (rf.persistent_id != null) runtimeByPersistent.set(rf.persistent_id, rf);
  }
  const ephemeral = runtime.filter((rf) => rf.persistent_id == null);

  return (
    <div className="h-full flex flex-col bg-surface border-l border-border">
      <div className="px-3 py-2 flex items-center justify-between border-b border-border">
        <div className="text-sm font-medium">Forwards</div>
        <button onClick={() => setDialog({ kind: 'ephemeral-create' })}
                className="btn-secondary gap-1 text-xs">
          <Plus size={14} /> Add
        </button>
      </div>

      <div className="flex-1 overflow-auto">
        {persistent.length === 0 && ephemeral.length === 0 && (
          <div className="p-4 text-sm text-muted">
            No forwards yet. Use <strong>Add</strong> to tunnel a port through this session.
          </div>
        )}

        {persistent.map((p) => {
          const rt = runtimeByPersistent.get(p.id);
          const isRunning = rt?.status.status === 'running';
          const tone = rt ? statusTone(rt) : 'muted';
          const label = p.name || (p.kind === 'dynamic'
            ? `SOCKS5 @ ${p.bind_addr}:${p.bind_port}`
            : `${p.bind_addr}:${p.bind_port} → ${p.dest_addr}:${p.dest_port}`);
          return (
            <Row key={`p-${p.id}`}
                 kind={p.kind} label={label} tone={tone}
                 lastError={rt?.status.status === 'error' ? rt.status.message : null}
                 actions={
                   <>
                     {isRunning
                       ? <IconBtn title="Stop"  onClick={() => stop(rt!.runtime_id)}><Square size={14}/></IconBtn>
                       : <IconBtn title="Start" onClick={() => startPersistent(p.id)}><Play size={14}/></IconBtn>}
                     <IconBtn title="Edit" onClick={() => { /* opens persistent-edit; wired in session-dialog */ }}>
                       <Pencil size={14}/>
                     </IconBtn>
                     <IconBtn title="Delete"
                              onClick={async () => {
                                if (isRunning) await api.forwardStop(connectionId, rt!.runtime_id);
                                await api.forwardDelete(p.id);
                                setPersistent((cur) => cur.filter((x) => x.id !== p.id));
                              }}>
                       <Trash2 size={14}/>
                     </IconBtn>
                   </>
                 } />
          );
        })}

        {ephemeral.map((rf) => (
          <Row key={`e-${rf.runtime_id}`}
               kind={rf.spec.kind}
               label={autoLabel(rf)}
               tone={statusTone(rf)}
               lastError={rf.status.status === 'error' ? rf.status.message : null}
               actions={
                 <>
                   <IconBtn title="Edit"
                            onClick={() => setDialog({ kind: 'ephemeral-edit', existing: rf })}>
                     <Pencil size={14}/>
                   </IconBtn>
                   <IconBtn title="Stop" onClick={() => stop(rf.runtime_id)}>
                     <Square size={14}/>
                   </IconBtn>
                 </>
               } />
        ))}
      </div>

      {dialog?.kind === 'ephemeral-create' && (
        <ForwardDialog mode="ephemeral-create" connectionId={connectionId}
                       onClose={() => setDialog(null)}
                       onSaved={() => setDialog(null)} />
      )}
      {dialog?.kind === 'ephemeral-edit' && (
        <ForwardDialog mode="ephemeral-edit" connectionId={connectionId}
                       existing={dialog.existing}
                       onClose={() => setDialog(null)}
                       onSaved={() => setDialog(null)} />
      )}
    </div>
  );
}

function Row({ kind, label, tone, lastError, actions }: {
  kind: ForwardKind; label: string; tone: 'ok'|'warn'|'bad'|'muted';
  lastError: string | null; actions: React.ReactNode;
}) {
  const b = KIND_BADGE[kind];
  return (
    <div className="px-3 py-2 border-b border-border hover:bg-surface2">
      <div className="flex items-center gap-2 text-sm">
        <StatusDot tone={tone} />
        <span className={`font-mono text-xs ${b.tone}`}>{b.letter}</span>
        <span className="truncate flex-1">{label}</span>
        <span className="flex items-center gap-1">{actions}</span>
      </div>
      {lastError && <div className="text-xs text-danger pl-6 mt-0.5">{lastError}</div>}
    </div>
  );
}

function IconBtn({ children, title, onClick }: {
  children: React.ReactNode; title: string; onClick: () => void;
}) {
  return (
    <button title={title} onClick={onClick}
            className="p-1 rounded hover:bg-surface2 text-muted hover:text-fg">
      {children}
    </button>
  );
}
```

- [ ] **Step 12.2: Type-check + commit**

```bash
cd ui && npx tsc --noEmit && cd ..
```

```bash
git add ui/components/forwards-pane.tsx
git commit -m "feat(ui): forwards-pane component (#33)"
```

---

## Task 13: Session-dialog "Forwards" tab

**Files:**
- Modify: `ui/components/session-dialog.tsx`

- [ ] **Step 13.1: Extend `TabKey` and add the pane component**

In `session-dialog.tsx`, change the `TabKey` line:

```ts
type TabKey = 'general' | 'terminal' | 'advanced' | 'forwards';
```

Find the tab nav (search for `tab === 'advanced'`) and add a button for `'forwards'` matching the existing pattern.

Find the panel render block where `<TerminalPane>` / `<AdvancedPane>` mount and add:

```tsx
{tab === 'forwards' && (
  <ForwardsConfigPane sessionId={editId} pending={pendingForwards} setPending={setPendingForwards} />
)}
```

Add component state inside `SessionDialog`:

```ts
const [pendingForwards, setPendingForwards] = useState<ForwardInput[]>([]);
```

- [ ] **Step 13.2: Implement `ForwardsConfigPane`**

Append (above `defaultHostForKind`):

```tsx
function ForwardsConfigPane({
  sessionId, pending, setPending,
}: {
  sessionId: number | null;
  pending: ForwardInput[];
  setPending: React.Dispatch<React.SetStateAction<ForwardInput[]>>;
}) {
  const [rows, setRows] = useState<Forward[]>([]);
  const [editing, setEditing] = useState<Forward | 'new' | null>(null);

  useEffect(() => {
    if (sessionId == null) return;
    api.forwardList(sessionId).then(setRows).catch(() => {});
  }, [sessionId]);

  if (sessionId == null) {
    // New session — stage in component state, flush on save.
    return (
      <div className="space-y-3">
        <div className="text-xs text-muted">
          Forwards will be saved with the session.
        </div>
        {pending.map((p, i) => (
          <div key={i} className="flex items-center justify-between border border-border rounded px-2 py-1.5 text-sm">
            <span className="font-mono truncate">
              [{p.kind[0].toUpperCase()}] {p.bind_addr}:{p.bind_port}
              {p.kind !== 'dynamic' && ` → ${p.dest_addr}:${p.dest_port}`}
            </span>
            <button className="text-muted hover:text-fg text-xs"
                    onClick={() => setPending((cur) => cur.filter((_, j) => j !== i))}>
              Remove
            </button>
          </div>
        ))}
        <button className="btn-secondary" onClick={() => setEditing('new')}>+ Add forward</button>
        {editing === 'new' && (
          <ForwardDialog mode="persistent-create" sessionId={-1}
                         onClose={() => setEditing(null)}
                         onSaved={(out) => {
                           // mode=persistent-create with sessionId=-1 would 500;
                           // intercept by NOT calling the API and instead pushing
                           // the form values onto `pending`. We re-open the dialog
                           // with a custom flow below.
                           setEditing(null);
                           setPending((cur) => [...cur, out as unknown as ForwardInput]);
                         }} />
        )}
      </div>
    );
  }

  return (
    <div className="space-y-2">
      {rows.length === 0 && <div className="text-sm text-muted">No persistent forwards configured.</div>}
      {rows.map((r) => (
        <div key={r.id} className="flex items-center justify-between border border-border rounded px-2 py-1.5 text-sm">
          <span className="font-mono truncate">
            [{r.kind[0].toUpperCase()}] {r.bind_addr}:{r.bind_port}
            {r.kind !== 'dynamic' && ` → ${r.dest_addr}:${r.dest_port}`}
            {r.name && <span className="ml-2 text-muted">— {r.name}</span>}
          </span>
          <div className="flex gap-1">
            <button className="text-muted hover:text-fg text-xs" onClick={() => setEditing(r)}>Edit</button>
            <button className="text-muted hover:text-fg text-xs"
                    onClick={async () => {
                      await api.forwardDelete(r.id);
                      setRows((cur) => cur.filter((x) => x.id !== r.id));
                    }}>Remove</button>
          </div>
        </div>
      ))}
      <button className="btn-secondary" onClick={() => setEditing('new')}>+ Add forward</button>
      {editing === 'new' && (
        <ForwardDialog mode="persistent-create" sessionId={sessionId}
                       onClose={() => setEditing(null)}
                       onSaved={(f) => { setRows((cur) => [...cur, f as Forward]); setEditing(null); }} />
      )}
      {editing && editing !== 'new' && (
        <ForwardDialog mode="persistent-edit" forward={editing as Forward}
                       onClose={() => setEditing(null)}
                       onSaved={(f) => {
                         const upd = f as Forward;
                         setRows((cur) => cur.map((x) => x.id === upd.id ? upd : x));
                         setEditing(null);
                       }} />
      )}
    </div>
  );
}
```

- [ ] **Step 13.3: Flush pending forwards after `session_create`**

In the existing `save` function, after `sessionCreate` resolves, add (before `props.onSaved()`):

```ts
if (props.mode === 'create' && pendingForwards.length > 0) {
  for (const p of pendingForwards) {
    await api.forwardCreate(created.id, p).catch(() => {});
  }
}
```

(`created` is the variable holding the new session returned by `sessionCreate`.)

- [ ] **Step 13.4: Type-check + commit**

```bash
cd ui && npx tsc --noEmit && cd ..
```

```bash
git add ui/components/session-dialog.tsx
git commit -m "feat(ui): session-dialog Forwards tab for persistent config (#33)"
```

---

## Task 14: Toolbar toggle + side-pane mount

**Files:**
- Modify: `ui/components/tabs-shell.tsx`
- Modify: `ui/components/terminal.tsx` (only if needed for events)

- [ ] **Step 14.1: Add the toggle**

In `tabs-shell.tsx`, find the SFTP toggle button (search for `sftp` lowercase) and clone the pattern for forwards. Add a small running/total badge:

```tsx
const [forwardsOpen, setForwardsOpen] = useState(false);
const [forwardsCount, setForwardsCount] = useState({ running: 0, total: 0 });
```

Subscribe to the same `forwards:status:{connection_id}` events as the pane to keep the badge fresh, or call `forwardRuntimeList` whenever a tab becomes active. (Pick whichever matches the existing patterns in this file.)

The toolbar button:

```tsx
<button
  onClick={() => setForwardsOpen((v) => !v)}
  className={`px-2 py-1 text-xs rounded ${forwardsOpen ? 'bg-surface2' : 'hover:bg-surface2'}`}
  title="Forwards"
>
  Forwards
  {forwardsCount.total > 0 && (
    <span className="ml-1 text-muted">
      {forwardsCount.running}/{forwardsCount.total}
    </span>
  )}
</button>
```

- [ ] **Step 14.2: Mount the pane next to SFTP**

Wherever `<SftpPane>` mounts conditionally, mount `<ForwardsPane>` similarly when `forwardsOpen` and the active tab is SSH:

```tsx
{forwardsOpen && activeTab.session.session_kind === 'ssh' && (
  <ForwardsPane sessionId={activeTab.session.id} connectionId={activeTab.connectionId} />
)}
```

- [ ] **Step 14.3: Type-check + commit**

```bash
cd ui && npx tsc --noEmit && cd ..
```

```bash
git add ui/components/tabs-shell.tsx
git commit -m "feat(ui): toolbar Forwards toggle + side-pane mount (#33)"
```

---

## Task 15: Final verification

- [ ] **Step 15.1: Backend tests**

```bash
cargo test --manifest-path src-tauri/Cargo.toml --bin ezterm \
  db::forwards:: ssh::forwards::socks5::
```
Expected: all green.

- [ ] **Step 15.2: cargo check + clippy if you want**

```bash
cargo check --manifest-path src-tauri/Cargo.toml
```

- [ ] **Step 15.3: UI type-check + lint**

```bash
cd ui && npx tsc --noEmit && npm run lint && cd ..
```
Expected: 0 errors (pre-existing warnings in `sftp-pane.tsx` and `sync-dialog.tsx` are OK).

- [ ] **Step 15.4: Manual smoke test**

Run a real session:
```bash
cargo tauri dev
```

Smoke checklist:
1. Create an SSH session to a host you control.
2. In session edit → Forwards: add a local forward (e.g. `127.0.0.1:15432 → localhost:5432`) with auto-start on.
3. Save, connect. Toast: "Forward started." Pane shows green dot.
4. From another shell: `nc -v 127.0.0.1 15432` connects through.
5. Stop the forward in the pane → dot goes muted; new `nc` is refused.
6. Add an ephemeral SOCKS5 (`127.0.0.1:11080`, kind=Dynamic) from the pane → `curl --socks5-hostname localhost:11080 https://example.com` works.
7. Add a remote forward — connect from the remote side and verify the tunnel.
8. Disconnect the tab — all forwards drop, pane clears.
9. Reconnect — auto-start forwards reappear, ephemeral ones do not.

- [ ] **Step 15.5: Bump to v1.3.0 + release notes**

Bump `Cargo.toml` to `version = "1.3.0"` (final minor for the feature).
Create `docs/release-notes/v1.3.0.md` with the release notes (model on `v1.2.2.md`).

```bash
git add Cargo.toml Cargo.lock docs/release-notes/v1.3.0.md
git commit -m "release: v1.3.0 — SSH port forwarding"
```

- [ ] **Step 15.6: Push + open PR**

```bash
git push -u origin feat/ssh-port-forwarding
gh pr create --base main --title "feat: SSH port forwarding (-L / -R / -D) (#33)" \
  --body-file <(cat <<'EOF'
Closes #33.

## Summary
- Three new forward kinds (Local, Remote, Dynamic) with persistent + ad-hoc lifetimes.
- Side pane on the active tab + Forwards tab in the session edit dialog.
- Auto-start runs at the end of `ssh::connect_impl`.

## Test plan
[manual smoke checklist from plan §15.4]
EOF
)
```

---

## Self-Review

**Spec coverage:**

| Spec section                | Task(s)           |
|----------------------------|-------------------|
| Data model / migration     | Task 1            |
| Shared types               | Task 2            |
| `ssh/forwards/local.rs`    | Task 4            |
| `ssh/forwards/remote.rs`   | Task 5            |
| `ssh/forwards/socks5.rs`   | Task 6            |
| `ssh/forwards/dynamic.rs`  | Task 7            |
| `ClientHandler` callback   | Task 3            |
| Registry extensions        | Task 2            |
| Tauri commands             | Task 8            |
| Auto-start flow            | Task 9            |
| Frontend types/api/event   | Task 10           |
| `forward-dialog.tsx`       | Task 11           |
| `forwards-pane.tsx`        | Task 12           |
| Session-dialog "Forwards"  | Task 13           |
| Toolbar toggle             | Task 14           |
| Tests (unit + integration) | Task 1, Task 6, Task 15 |

**Notes / known sharp edges:**

- Step 9.1 ends with "Adjust as needed" because `connect_impl` is 750+ lines — the exact line numbers will shift as the implementer reads it. The structural change (capture `forwards`, `ssh_handle`, `connection_id` before the registry insert, run the scan after) is unambiguous; the editor pattern is up to the implementer.
- Step 11 + Step 13 have a deliberate gap: the new-session staging flow in `ForwardsConfigPane` reuses the `ForwardDialog` modal but needs to suppress its DB calls when `sessionId === -1`. Implementer should add a `mode === 'persistent-stage'` variant to the dialog (or split the form body into a sub-component shared between the two staging shapes). Either approach is small; the comment in Step 13.2 flags it.
- Per-row "Edit" on persistent rows in the forwards-pane (Step 12) is wired only as a stub. Persistent edits should go through the session edit dialog (which already has the pane). Wiring the modal directly from the pane is a v1.4 polish item; the comment in the code spells this out.

All other spec requirements have a concrete task with full code.
