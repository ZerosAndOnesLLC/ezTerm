# ezTerm v0.1 — Design Spec

**Date:** 2026-04-18
**Status:** Approved for planning
**Upstream:** `github.com/ZerosAndOnesLLC/ezTerm`
**License:** See repo `LICENSE` (free, open-source distribution)

## 1. Goal

Build a free Windows SSH client whose **look and feel closely mirror MobaXterm**, with:

- Connection/session manager (folders + saved sessions)
- Encrypted credential vault ("locker")
- SSH (shell)
- SFTP (side-pane file browser)
- SCP (one-shot transfers)
- xterm-compatible terminal with right-click menu and Shift+Insert paste
- Dark theme default, light theme toggle

Everything outside that list is explicitly **out of scope for v0.1** (see §9).

## 2. Stack

| Layer         | Choice                                                                 |
|---------------|------------------------------------------------------------------------|
| Desktop shell | Tauri v2                                                               |
| Frontend      | Next.js (static export into Tauri assets) + React                      |
| Terminal      | `xterm.js` + addons: `fit`, `web-links`, `search`                      |
| SSH / SFTP    | `russh` + `russh-sftp` (pure Rust, tokio)                              |
| Persistence   | SQLite via `sqlx`                                                      |
| Vault crypto  | `argon2` (KDF) + `chacha20poly1305` (AEAD) + `zeroize` (scrubbing)     |
| Styling       | Tailwind CSS + CSS variables for theme tokens                          |

Windows is the only target platform for v0.1. No macOS/Linux builds published.

## 3. High-Level Architecture

```
┌─────────────────────────────────────────────────────────────┐
│  Webview (Next.js + xterm.js)                               │
│  ┌──────────────┐ ┌──────────────────────────────────────┐  │
│  │ Sessions     │ │ Tab 1 (term)  Tab 2 (term) …         │  │
│  │ sidebar      │ ├──────────────────────────────────────┤  │
│  │ (tree)       │ │ ┌─SFTP─┐  ┌──────────────────────┐   │  │
│  │              │ │ │pane  │  │ xterm.js terminal    │   │  │
│  │              │ │ └──────┘  └──────────────────────┘   │  │
│  └──────────────┘ └──────────────────────────────────────┘  │
└──────────────────────┬──────────────────────────────────────┘
                       │ Tauri commands / events
┌──────────────────────▼──────────────────────────────────────┐
│  Rust backend (src-tauri)                                   │
│  ┌──────┐  ┌────────┐  ┌─────────┐  ┌─────────┐  ┌───────┐  │
│  │Vault │  │  DB    │  │  SSH    │  │  SFTP   │  │  SCP  │  │
│  │      │  │(sqlx)  │  │ (russh) │  │(russh-  │  │       │  │
│  │      │  │        │  │         │  │ sftp)   │  │       │  │
│  └──────┘  └────────┘  └─────────┘  └─────────┘  └───────┘  │
└─────────────────────────────────────────────────────────────┘
```

Each boxed Rust module is independently testable and exposes a small Tauri command surface.

## 4. UX Spec (MobaXterm parity)

### 4.1 Window layout

- **Left sidebar (240px default, resizable)** — "Sessions" tree.
  - Folder → Session hierarchy, drag-to-reorder, right-click menu (New Session / New Folder / Rename / Delete / Duplicate).
  - Double-click a session opens it in a new tab (or focuses an existing tab for that session).
  - Bottom of sidebar: "+ New Session" button.
- **Top tab bar** — one tab per active connection. Middle-click closes; right-click offers Close / Close Others / Rename / Duplicate.
- **Main area** — active tab contents: xterm terminal, with optional SFTP side-pane docked to its **left** (collapsible, remembered per-tab).
- **Status bar** (bottom) — connection state, host:port, bytes in/out, latency (if available), lock-vault button.

### 4.2 Terminal

- `xterm.js` with `fit` addon for resize, `web-links` for clickable URLs, `search` for Ctrl+Shift+F.
- **Right-click context menu** items: Copy, Paste, Select All, Clear Scrollback, Find. Menu disables Copy when no selection, disables Paste when clipboard empty.
- **Keyboard**:
  - `Shift+Insert` → paste clipboard.
  - `Ctrl+Shift+C` → copy selection (Ctrl+C is reserved for terminal SIGINT).
  - `Ctrl+Shift+V` → paste.
  - `Ctrl+Shift+F` → find.
  - `Ctrl+Tab` / `Ctrl+Shift+Tab` → cycle tabs.
- Selection-to-copy: **off by default**, toggle in settings.
- Default font: **Cascadia Mono** 11pt (fallback: Consolas, monospace).

### 4.3 Theme

- **Dark default** (MobaXterm-ish): near-black background, off-white foreground, muted ANSI palette.
- Light mode toggle in settings; persists in SQLite.
- CSS variables drive both the terminal theme object passed to xterm.js **and** the chrome (sidebar, tabs, status bar) so theme switching is instant and consistent.

### 4.4 SFTP side-pane

- Opens automatically on a successful SSH connection (can be toggled off per-tab).
- Shows remote working directory at top with a breadcrumb; below it a file list (name, size, modified, permissions).
- Drag-and-drop upload from OS file explorer; context menu for Download, Rename, Delete, Chmod, Mkdir, New File.
- Uses the **same SSH session** as the terminal (SFTP subsystem channel); no second auth.

### 4.5 Connection dialog

- Fields: name, host, port (default 22), username, auth method (Password / Private key / SSH agent), credential picker or "new credential" inline, folder, tab color.
- Saves to DB on OK; secrets routed through the vault (see §6).

## 5. Data Model (SQLite)

```sql
-- folders: tree structure for the sessions sidebar
folders(
  id          INTEGER PRIMARY KEY,
  parent_id   INTEGER REFERENCES folders(id) ON DELETE CASCADE,
  name        TEXT NOT NULL,
  sort        INTEGER NOT NULL DEFAULT 0
);

-- sessions: one per saved connection
sessions(
  id            INTEGER PRIMARY KEY,
  folder_id     INTEGER REFERENCES folders(id) ON DELETE SET NULL,
  name          TEXT NOT NULL,
  host          TEXT NOT NULL,
  port          INTEGER NOT NULL DEFAULT 22,
  username      TEXT NOT NULL,
  auth_type     TEXT NOT NULL CHECK (auth_type IN ('password','key','agent')),
  credential_id INTEGER REFERENCES credentials(id) ON DELETE SET NULL,
  color         TEXT,
  sort          INTEGER NOT NULL DEFAULT 0,
  created_at    DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at    DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- credentials: encrypted blobs (AEAD: ChaCha20-Poly1305)
credentials(
  id          INTEGER PRIMARY KEY,
  kind        TEXT NOT NULL CHECK (kind IN ('password','private_key','key_passphrase')),
  label       TEXT NOT NULL,
  nonce       BLOB NOT NULL,        -- 12 bytes
  ciphertext  BLOB NOT NULL,        -- includes Poly1305 tag
  created_at  DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- known_hosts: TOFU
known_hosts(
  host         TEXT NOT NULL,
  port         INTEGER NOT NULL,
  key_type     TEXT NOT NULL,
  fingerprint  TEXT NOT NULL,
  first_seen   DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (host, port, key_type)
);

-- vault_meta: master-password verifier + KDF params
vault_meta(
  id          INTEGER PRIMARY KEY CHECK (id = 1),  -- singleton
  salt        BLOB NOT NULL,        -- 16 bytes
  kdf_params  TEXT NOT NULL,        -- JSON: argon2 m, t, p
  verifier    BLOB NOT NULL         -- AEAD ciphertext of a known plaintext
);

-- app_settings: key/value for theme, font, etc.
app_settings(
  key    TEXT PRIMARY KEY,
  value  TEXT NOT NULL
);
```

Migrations live in `migrations/` and are created via `sqlx migrate add …` with correct date-based timestamps.

## 6. Security Model

### 6.1 Master password / vault

- First launch: user sets a master password.
  - Generate 16-byte random salt, store in `vault_meta.salt`.
  - Run Argon2id with tuned params (default: m=64MiB, t=3, p=1) → 32-byte vault key.
  - Encrypt a known plaintext (e.g. `"eztermV1"`) with the key → store as `vault_meta.verifier` for unlock checks.
- Subsequent launches: password prompt; KDF + AEAD-decrypt the verifier to confirm.
- Vault key lives in a `Zeroizing<[u8; 32]>` inside an `Arc<RwLock<Option<…>>>` held by the Tauri state. "Lock vault" wipes it; all subsequent SSH connects will reprompt.

### 6.2 Credentials

- On save: caller passes plaintext → Rust picks random 12-byte nonce, AEAD-encrypts with vault key, stores `(nonce, ciphertext, kind, label)`. Plaintext is zeroized immediately.
- On connect: Rust decrypts in-process, passes to `russh` auth, zeroizes after handshake.
- **No Tauri command ever returns plaintext credentials to the frontend.** The frontend only ever sees credential IDs and labels.

### 6.3 Known hosts / TOFU

- On first connect: show a dialog with the key fingerprint, require explicit "Trust" to persist.
- On mismatch: hard fail with a visible warning; offer "Remove existing and re-trust" only via an explicit confirm dialog.

### 6.4 Other

- Windows DPAPI wrapping of the Argon2-derived key is **deferred** to a later version; v0.1 ships with vault-key-in-memory only, which matches MobaXterm's "master password" behavior.
- No telemetry. No auto-update phone-home in v0.1.

## 7. Tauri Command Surface (draft)

Names only — full signatures land in the implementation plan.

- `vault_init(master_password)` / `vault_unlock(password)` / `vault_lock()` / `vault_is_unlocked()`
- `folder_list()` / `folder_create(parent, name)` / `folder_rename(id, name)` / `folder_delete(id)` / `folder_move(id, parent, sort)`
- `session_list()` / `session_get(id)` / `session_create(dto)` / `session_update(id, dto)` / `session_delete(id)` / `session_duplicate(id)`
- `credential_create(kind, label, plaintext)` / `credential_list()` / `credential_delete(id)`
- `ssh_connect(session_id)` → `connection_id`
- `ssh_write(connection_id, bytes)` / `ssh_resize(connection_id, cols, rows)` / `ssh_disconnect(connection_id)`
- Event `ssh:data:{connection_id}` / `ssh:close:{connection_id}` / `ssh:error:{connection_id}`
- `sftp_open(connection_id)` / `sftp_list(connection_id, path)` / `sftp_upload(connection_id, local, remote)` / `sftp_download(connection_id, remote, local)` / `sftp_mkdir` / `sftp_rename` / `sftp_delete` / `sftp_chmod`
- `scp_upload(session_id, local, remote)` / `scp_download(session_id, remote, local)`
- `settings_get(key)` / `settings_set(key, value)`
- `known_host_list()` / `known_host_remove(host, port)`

## 8. Project Layout

```
ezTerm/
├── src-tauri/
│   ├── src/
│   │   ├── main.rs
│   │   ├── commands/        # one module per command group above
│   │   ├── ssh/             # russh wrappers, connection registry
│   │   ├── sftp/
│   │   ├── scp/
│   │   ├── vault/           # argon2 + chacha20poly1305 + zeroize
│   │   ├── db/              # sqlx pool, repositories
│   │   └── state.rs         # Tauri managed state
│   ├── Cargo.toml
│   └── tauri.conf.json
├── ui/
│   ├── app/                 # Next.js App Router
│   ├── components/
│   │   ├── sessions/        # sidebar tree
│   │   ├── tabs/            # tab bar + tab container
│   │   ├── terminal/        # xterm.js wrapper + context menu
│   │   ├── sftp/            # side-pane
│   │   └── ui/              # shared primitives
│   ├── lib/                 # Tauri invoke helpers, theme tokens
│   └── styles/
├── migrations/              # sqlx
├── docs/
│   └── superpowers/
│       ├── specs/           # this doc
│       └── plans/
├── CLAUDE.md
├── Cargo.toml               # workspace (if needed)
└── README.md
```

## 9. Out of Scope (v0.1)

- Port forwarding / jump hosts / ProxyJump
- X11 server
- RDP / Telnet / Serial / FTP / VNC
- Macros or scripting
- Session recording / logging to file
- Split panes (horizontal/vertical)
- Themes beyond one dark + one light
- Cross-platform builds (mac/linux)
- Auto-update
- Telemetry

Any of these require an explicit design update before being added.

## 10. Testing Strategy

- **Rust unit tests** for vault (KDF round-trip, AEAD round-trip, wrong-password rejection), DB repos, known-hosts TOFU logic.
- **Rust integration tests** for SSH/SFTP against a dockerized `linuxserver/openssh-server` container in CI (gated behind a feature flag so offline `cargo test` stays fast).
- **Frontend unit tests** for session tree reducers and terminal input mapping (Vitest or Jest).
- **Manual smoke checklist** in `docs/superpowers/testing/smoke.md` for each release.

## 11. Release

- `cargo tauri build` produces an `.msi` installer.
- GitHub Releases hosts binaries; issues track bugs and feature requests.
- Version bumped in `Cargo.toml` before each commit per repo convention.

## 12. Open Questions

None blocking v0.1. Deferred topics: DPAPI wrapping, auto-update channel, signed installers.
