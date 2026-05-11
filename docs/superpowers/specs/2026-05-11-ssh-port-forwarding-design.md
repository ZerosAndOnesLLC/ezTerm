# SSH port forwarding — design

Closes / implements [#33](https://github.com/ZerosAndOnesLLC/ezTerm/issues/33).

## Goal

First-class SSH port forwarding inside ezTerm sessions, matching what
`ssh -L`, `ssh -R`, and `ssh -D` do on the command line. All three
forward kinds ship in a single release. Persistent forwards live in
the database and auto-start with their session; ad-hoc forwards can
be added to a live tab and die with the connection. Both kinds flow
through the same runtime so the side-pane UI treats them identically.

## Forward types

| Kind     | OpenSSH flag | What it does                                                                 |
|----------|--------------|------------------------------------------------------------------------------|
| Local    | `-L`         | `bind_addr:bind_port` on the client → `dest_addr:dest_port` reachable from remote |
| Remote   | `-R`         | `bind_addr:bind_port` on the remote → `dest_addr:dest_port` reachable from client |
| Dynamic  | `-D`         | Local SOCKS5 proxy that tunnels client app traffic through the remote        |

## Decisions (locked in during brainstorming)

| Topic                    | Decision                                                                                       |
|--------------------------|------------------------------------------------------------------------------------------------|
| Release scoping          | All three kinds in one release.                                                                |
| Lifecycle                | Persistent (DB-backed, auto-start) + ad-hoc (per-connection, ephemeral).                       |
| UI surface (active tab)  | Toolbar button → side pane, same shape as the SFTP pane.                                       |
| UI surface (session cfg) | New "Forwards" tab inside the session edit dialog.                                             |
| Privileged ports (<1024) | Allow in the UI; the OS enforces. Bind failure → clear error message with elevation guidance.  |
| Default bind address     | `127.0.0.1`. Non-loopback values are allowed but trigger a yellow LAN-reachable warning.       |
| Forward labels           | Optional `name` field; empty falls back to an auto-label.                                      |
| Editing a running forward| Save = stop + restart.                                                                         |
| Concurrent forwards across tabs | No dedupe. Second tab's bind hits `EADDRINUSE`; the pane surfaces it.                   |
| SOCKS5 auth              | No-auth method only.                                                                           |
| SOCKS5 verbs             | `CONNECT` only — `BIND` and `UDP ASSOCIATE` are not supported.                                 |

## Architecture overview

```
┌────────────────────────────────────────────────────────────────┐
│ Frontend (Next.js)                                             │
│  ┌────────────────┐   ┌──────────────────────┐                 │
│  │ forwards-pane  │   │ session-dialog       │                 │
│  │ (active tab)   │   │  └─ "Forwards" tab   │                 │
│  └────────────────┘   └──────────────────────┘                 │
│           │ Tauri invoke / events                              │
└───────────┼────────────────────────────────────────────────────┘
            ▼
┌────────────────────────────────────────────────────────────────┐
│ Backend (Rust)                                                 │
│                                                                │
│  commands/forwards.rs ────► db/forwards.rs (sqlx)              │
│        │                                                       │
│        ▼                                                       │
│  ssh/forwards/                                                 │
│   ├── mod.rs           shared types, RuntimeForward            │
│   ├── local.rs         TcpListener → channel_open_direct_tcpip │
│   ├── remote.rs        tcpip_forward + handler dispatch        │
│   └── dynamic.rs       SOCKS5 → channel_open_direct_tcpip      │
│                                                                │
│  ssh/registry.rs::Connection                                   │
│   ├── forwards:                  Arc<RwLock<HashMap<id,RF>>>   │
│   └── forwarded_tcpip_dispatch:  Arc<RwLock<HashMap<(addr,port), Sender<Channel>>>> │
│                                                                │
│  ssh/client.rs::ClientHandler                                  │
│   └── new: server_channel_open_forwarded_tcpip(...)            │
└────────────────────────────────────────────────────────────────┘
            │
            ▼ russh 0.60
       remote sshd
```

No new crate dependencies — russh 0.60 already exposes
`channel_open_direct_tcpip`, `tcpip_forward`, and
`cancel_tcpip_forward`, and SOCKS5 is implemented hand-rolled
because the protocol is small.

## Data model

New migration `YYYYMMDDHHMMSS_session_forwards.sql`:

```sql
CREATE TABLE session_forwards (
  id           INTEGER PRIMARY KEY,
  session_id   INTEGER NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  name         TEXT NOT NULL DEFAULT '',
  kind         TEXT NOT NULL CHECK (kind IN ('local','remote','dynamic')),
  bind_addr    TEXT NOT NULL DEFAULT '127.0.0.1',
  bind_port    INTEGER NOT NULL CHECK (bind_port BETWEEN 1 AND 65535),
  dest_addr    TEXT NOT NULL DEFAULT '',   -- '' for dynamic
  dest_port    INTEGER NOT NULL DEFAULT 0, --  0 for dynamic
  auto_start   INTEGER NOT NULL DEFAULT 1,
  sort         INTEGER NOT NULL DEFAULT 0,
  created_at   TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_session_forwards_session ON session_forwards(session_id, sort);
```

- `ON DELETE CASCADE` removes forwards automatically when a session
  is deleted.
- Rust-side validation in the insert/update layer enforces the
  kind-specific shape: `kind = 'dynamic'` ⇒ `dest_addr = '' AND dest_port = 0`;
  `kind IN ('local','remote')` ⇒ both required and non-empty.
- `bind_port` allows the full 1–65535 range; privileged binds are
  enforced by the OS at start time, not by the schema.

## Backend modules

### `src-tauri/src/ssh/forwards/mod.rs`

Shared types (serde-serializable so they cross the Tauri boundary):

```rust
#[derive(Clone, Copy, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum ForwardKind { Local, Remote, Dynamic }

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct ForwardSpec {
    pub name:      String,        // may be empty
    pub kind:      ForwardKind,
    pub bind_addr: String,
    pub bind_port: u16,
    pub dest_addr: String,        // "" for Dynamic
    pub dest_port: u16,           //  0 for Dynamic
}

#[derive(Clone, Debug, Serialize)]
#[serde(tag = "status", rename_all = "lowercase")]
pub enum ForwardStatus {
    Starting,
    Running,
    Restarting,                     // edit-in-place: stopped, about to re-start
    Stopped,
    Error { message: String },
}

pub struct RuntimeForward {
    pub id:            u64,                  // per-connection
    pub persistent_id: Option<i64>,          // None ⇒ ad-hoc
    pub spec:          ForwardSpec,
    pub status:        StdMutex<ForwardStatus>,
    pub stop_tx:       Mutex<Option<oneshot::Sender<()>>>,
}
```

### `src-tauri/src/ssh/forwards/local.rs`

```text
start(handle, spec):
  listener = TcpListener::bind((spec.bind_addr, spec.bind_port))
  spawn task:
    loop:
      (tcp, peer) = listener.accept().await
      spawn per-connection:
        channel = handle.channel_open_direct_tcpip(
                    spec.dest_addr, spec.dest_port,
                    peer.ip().to_string(), peer.port())
        copy_bidirectional(channel.into_stream(), tcp)
  return Handle { listener task abort handle, stop_tx }
```

`copy_bidirectional` from `tokio::io` does both directions and exits
cleanly when either side EOFs.

### `src-tauri/src/ssh/forwards/remote.rs`

```text
start(handle, spec, conn):
  conn.forwarded_tcpip_dispatch
       .insert((spec.bind_addr, spec.bind_port as u32), tx)
  handle.tcpip_forward(spec.bind_addr, spec.bind_port).await?
  spawn task:
    while let Some(channel) = rx.recv().await:
      spawn per-connection:
        tcp = TcpStream::connect((spec.dest_addr, spec.dest_port))
        copy_bidirectional(channel.into_stream(), tcp)

stop:
  handle.cancel_tcpip_forward(addr, port)
  conn.forwarded_tcpip_dispatch.remove(key)
```

Channels arrive in the handler (below) and are pushed onto `tx`. The
dispatch table is keyed by `(bind_addr, bind_port)` because that's
what the server echoes back in `forwarded-tcpip`.

### `src-tauri/src/ssh/forwards/dynamic.rs`

Hand-rolled SOCKS5, only the bits we need:

- **Greeting (RFC 1928 §3):** read `[VER=05, NMETHODS, METHODS...]`;
  reply `[05, 00]` (no auth) if `00` is in the list, else `[05, FF]`
  and close.
- **Request (§4):** read `[VER=05, CMD, RSV, ATYP, DST.ADDR, DST.PORT]`;
  only `CMD=01 (CONNECT)` supported. Reply `[05, 07, 00, 01, 0,0,0,0, 0,0]`
  for any other CMD ("Command not supported"). ATYP supports `01` (IPv4),
  `03` (domain), `04` (IPv6).
- **Connect:** `handle.channel_open_direct_tcpip(dst, port, peer.ip(), peer.port())`.
  Reply `[05, 00, 00, 01, 0,0,0,0, 0,0]` (success, BND.ADDR fixed to
  `0.0.0.0:0` since russh doesn't surface the bound socket).
- **Pump** with `copy_bidirectional` until either side closes.

The reply layout for non-CONNECT / domain-too-long / connect-failed
cases is detailed in the implementation plan; suffice it that we
always send a properly-framed SOCKS5 reply before closing — never a
TCP RST mid-handshake, which breaks Chrome's SOCKS client.

### `src-tauri/src/ssh/client.rs` — `ClientHandler`

Add one new field and one new callback:

```rust
pub struct ClientHandler {
    server_key: Arc<StdMutex<Option<(String, String)>>>,
    x11_display: Option<u8>,
    forwarded_tcpip_dispatch: Arc<RwLock<HashMap<(String, u32), Sender<Channel<Msg>>>>>,
}

impl client::Handler for ClientHandler {
    async fn server_channel_open_forwarded_tcpip(
        &mut self,
        channel: Channel<Msg>,
        connected_address: &str,
        connected_port: u32,
        _originator_address: &str,
        _originator_port: u32,
        _session: &mut client::Session,
    ) -> Result<(), Self::Error> {
        let key = (connected_address.to_string(), connected_port);
        let tx = self.forwarded_tcpip_dispatch.read().await.get(&key).cloned();
        if let Some(tx) = tx {
            let _ = tx.send(channel).await;
        }
        // No entry = forward was cancelled mid-flight; drop the channel,
        // which russh closes on its side.
        Ok(())
    }
}
```

The dispatch map is shared between the handler and `remote.rs` via
`Arc<RwLock<...>>` stored on the `Connection`.

### `src-tauri/src/ssh/registry.rs`

`Connection` gains:

```rust
pub forwards: Arc<RwLock<HashMap<u64, Arc<RuntimeForward>>>>,
pub forwarded_tcpip_dispatch:
    Arc<RwLock<HashMap<(String, u32), mpsc::Sender<Channel<Msg>>>>>,
```

`ConnectionRegistry` gains:

```rust
pub async fn forwards_list(&self, id: u64) -> Vec<RuntimeForwardSummary>
pub async fn forward_insert(&self, conn_id: u64, rf: Arc<RuntimeForward>)
pub async fn forward_remove(&self, conn_id: u64, rf_id: u64)
pub async fn forwards_stop_all(&self, conn_id: u64)
```

`close(id)` is extended to call `forwards_stop_all(id)` before
removing the connection — guarantees all listener tasks and
SOCKS5 acceptors are torn down before the russh handle goes away.

## Database layer

New `src-tauri/src/db/forwards.rs` mirroring the existing
`db/sessions.rs` shape:

```rust
pub struct Forward { id, session_id, name, kind, bind_addr, bind_port,
                     dest_addr, dest_port, auto_start, sort, created_at }
pub struct ForwardInput { name, kind, bind_addr, bind_port,
                          dest_addr, dest_port, auto_start }

pub async fn list_for_session(pool, session_id) -> Vec<Forward>
pub async fn list_auto_start(pool, session_id) -> Vec<Forward>
pub async fn create(pool, session_id, input) -> Forward
pub async fn update(pool, id, input) -> Forward
pub async fn delete(pool, id) -> ()
pub async fn reorder(pool, session_id, ids) -> ()
```

Kind-specific shape validation lives at the `create` / `update`
boundary and returns `AppError::Validation` on misuse.

## Tauri commands

New `src-tauri/src/commands/forwards.rs`:

### Persistent (require_unlocked, return DB rows)

- `forward_list(session_id: i64) -> Vec<Forward>`
- `forward_create(session_id: i64, input: ForwardInput) -> Forward`
- `forward_update(id: i64, input: ForwardInput) -> Forward`
- `forward_delete(id: i64) -> ()`
- `forward_reorder(session_id: i64, ids: Vec<i64>) -> ()`

### Runtime (require_unlocked, operate on a live connection)

- `forward_runtime_list(connection_id: u64) -> Vec<RuntimeForwardSummary>`
- `forward_start(connection_id: u64, target: ForwardStartTarget) -> RuntimeForwardSummary`
  - `ForwardStartTarget = { Persistent { id: i64 } | Ephemeral { spec: ForwardSpec } }`
- `forward_stop(connection_id: u64, runtime_id: u64) -> ()`
- `forward_stop_all(connection_id: u64) -> ()`

`RuntimeForwardSummary` is the serializable view: `{ runtime_id,
persistent_id, spec, status, last_error }`.

## Auto-start flow

At the end of `ssh::connect_impl`, after the shell channel is open
and the connection is registered:

```text
for f in db::forwards::list_auto_start(pool, session.id):
    spec = ForwardSpec::from(&f)
    spawn:
        forward_start_inner(conn_id, Persistent { id: f.id })
          .await
          .or_else(|e| emit "forwards:status" with Error(e))
```

Failures don't abort the connect — the terminal is still useful.
Each failure also fires a toast on the frontend.

## Events

- `forwards:status:{connection_id}` — emitted on every state
  transition (`Starting → Running`, `Running → Stopped`,
  `Running → Error`, ad-hoc add, persistent removal). Payload is the
  `RuntimeForwardSummary` for the affected forward; the pane uses it
  to update one row in place.

## Frontend

### `ui/lib/types.ts`

New types mirroring the Rust serialization:

```ts
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
  auto_start: number;  // 0 | 1
  sort:       number;
  created_at: string;
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
```

### `ui/lib/tauri.ts`

Adds all the new commands under a `forwards*` namespace + a
`subscribeForwardEvents(connectionId, onUpdate)` helper that wires
the `forwards:status:{id}` event with a `subscribeSshEvents`-style
unsubscribe.

### `ui/components/forwards-pane.tsx`  *(new)*

Same shape as `sftp-pane.tsx`. Columns: status dot · kind badge
(`L` / `R` / `D`) · label (name or auto: `bind → dest` for L/R,
`SOCKS5 @ bind` for D) · last error · row actions.

Toolbar: "Add forward" button (opens `forward-dialog` in ephemeral
mode), filter, "Stop all" overflow item. Empty state mirrors the
SFTP pane: "No forwards. Add one to tunnel a port." with a link to
the docs.

### `ui/components/forward-dialog.tsx`  *(new)*

Modal for create / edit. Mode is "ephemeral" or "persistent":

- Ephemeral form: no `auto_start` checkbox; submit calls
  `forward_start` with `Ephemeral { spec }`.
- Persistent form: includes `auto_start`; submit calls
  `forward_create` / `forward_update`.

Fields:
- `name` (optional) — placeholder shows auto-label preview.
- `kind` (radio L / R / D) — switching to D hides `dest_*`.
- `bind_addr` — defaults `127.0.0.1`. Any other value renders a yellow
  callout: *"This forward will be reachable from other machines on
  your network."*
- `bind_port` — number 1–65535. Sub-1024 renders a hint: *"Ports
  below 1024 require admin/root on most systems."*
- `dest_addr` / `dest_port` — hidden for D; required for L/R.
- `auto_start` (persistent only).

### `ui/components/session-dialog.tsx`

- Extend `TabKey = 'general' | 'terminal' | 'advanced' | 'forwards'`.
- New `ForwardsPane` lists `forward_list(session_id)` and offers
  add / edit / delete / reorder.
- For brand-new (unsaved) sessions the pane stages forwards in
  component state, then writes them in one batch after
  `session_create` succeeds. Matches the existing `env` flow.

### `ui/components/tabs-shell.tsx`

Toolbar gets a "Forwards" toggle next to the SFTP one. Badge shows
`running/total` (e.g. `2/3`) when nonzero. Click toggles the side
pane visible / hidden — same behavior as the SFTP toggle.

## Error handling

| Failure                                | UX                                                                                          |
|----------------------------------------|---------------------------------------------------------------------------------------------|
| `bind` `EADDRINUSE`                    | Pane row enters Error; toast: "Bind 127.0.0.1:5432 in use (another ezTerm tab?)"            |
| `bind` `EACCES` (privileged port)      | Pane row enters Error; toast: "Ports below 1024 require admin/root; run elevated or pick ≥ 1024" |
| Remote rejects `tcpip_forward`         | Pane row enters Error; toast: server's error message                                        |
| Per-connection target unreachable (L)  | Logged at `tracing::warn`; pane row stays Running; counter increments                        |
| SOCKS5 malformed handshake             | Send protocol-correct error reply, close TCP, log warn. Forward stays running.              |
| SSH disconnect                         | All forwards for that connection are stopped (`forwards_stop_all`); persistent rows stay in DB |

## Editing a running forward

Save = stop + restart, for both persistent and ad-hoc forwards. The
pane briefly shows `Restarting…` (a dedicated `ForwardStatus`
variant), then transitions to `Running` (or `Error` on failure). No
"Apply" gate, no separate stop step.

For ad-hoc forwards there is no DB row to update; the dialog's submit
calls `forward_stop` followed by `forward_start { Ephemeral { spec } }`
with the new spec, reusing the same runtime id when possible so the
pane row updates in place rather than disappearing and reappearing.

## Concurrent tabs on the same session

Each `Connection` has its own listener — no dedupe. If two tabs of
the same session both try to bind `127.0.0.1:5432`, the second one
hits `EADDRINUSE` and surfaces the error in its pane. Matches
OpenSSH (multiple `ssh -L` invocations race in the same way).

## Testing

### Unit

- `socks5::parse_greeting` — well-formed, no-auth missing, truncated
  reads.
- `socks5::parse_request` — IPv4 / IPv6 / domain, oversized domain,
  unsupported CMD, unsupported ATYP, truncated reads.
- `db::forwards::validate_input` — kind/dest shape rules.

### Integration

In-process `russh-server` fixture. One test per kind:

1. **Local:** start a local echo TCP server bound to a random port,
   request a local forward, connect from a client to the local bind
   port, write bytes, read them back through the echo.
2. **Remote:** start a local echo on the *client side*, request a
   remote forward, have the in-process server connect to the
   forwarded bind, write / read back.
3. **Dynamic:** start a local echo, send a SOCKS5 CONNECT request
   with that target, write / read.

Plus teardown tests: disconnect mid-pump, verify the listener is
gone and no task is leaked.

### Manual

PR description includes a manual test plan covering: real OpenSSH
server, auto-start happy path, port-in-use error, privileged-port
error, edit-while-running, multiple forwards on one session,
multiple tabs on the same session, SOCKS5 via curl `--socks5-hostname`
and Chrome `--proxy-server`.

## Out of scope (v1)

- Privileged-port elevation flow (always allowed; OS enforces)
- SOCKS5 authentication (no-auth only)
- SOCKS5 `BIND` and `UDP ASSOCIATE` verbs
- ProxyJump / jump hosts, agent forwarding `-A`, ControlMaster /
  connection sharing
- Per-forward bandwidth limits, byte / connection counters in the UI
- Sharing or deduping forwards across tabs of the same session
- Forwards in non-SSH session kinds (WSL, local) — these have no
  upstream channel to forward over

## Workflow

1. Spec — *this document*
2. Implementation plan (next step, via `writing-plans`)
3. GH issues per plan step (mirroring the local-shells workflow)
4. Branch + implement
5. Optional: parallel review agents (perf, security, completeness, code quality) — invoked by the user on the PR, not automatically
6. Merge + release notes for v1.3.0
