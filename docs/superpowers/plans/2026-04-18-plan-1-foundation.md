# ezTerm Foundation Implementation Plan (Plan 1 of 3)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stand up the ezTerm Tauri/Next.js app with SQLite persistence, an encrypted credential vault, and a MobaXterm-style sessions sidebar — produces a runnable app that manages saved sessions and credentials (no SSH connectivity yet; that lands in Plan 2).

**Architecture:** Tauri v2 app. Rust backend owns all persistence and crypto through a small Tauri-command surface. Next.js frontend (static export) renders the unlock screen, sessions sidebar, connection dialog, tabs shell, and status bar. Dark theme default driven by CSS variables shared between chrome and (future) xterm.js. Credentials are stored AEAD-encrypted with a key derived from the master password via Argon2id; plaintext never leaves the Rust process.

**Tech Stack:** Tauri v2, Rust (tokio, sqlx, russh-keys, argon2, chacha20poly1305, zeroize, thiserror, serde), Next.js 14 (App Router, static export), React, Tailwind CSS, TypeScript.

**Spec reference:** `docs/superpowers/specs/2026-04-18-ezterm-design.md` — §2, §3, §4 (partial: layout + theme + connection dialog), §5, §6 (vault), §7 (vault/folder/session/credential/settings commands), §8, §10.

---

## File Map

**Rust (`src-tauri/`)**

| File | Responsibility |
|------|---------------|
| `Cargo.toml` | Workspace root deps and Tauri config |
| `src/main.rs` | Entry point; registers Tauri commands, managed state, event loop |
| `src/state.rs` | `AppState` holding `SqlitePool` + `VaultState` |
| `src/error.rs` | `AppError` + `Result` alias, `serde::Serialize` for Tauri |
| `src/db/mod.rs` | Re-exports; `init_pool()` builds + runs migrations |
| `src/db/folders.rs` | Folder repository |
| `src/db/sessions.rs` | Session repository |
| `src/db/credentials.rs` | Credential repository (stores only ciphertext) |
| `src/db/settings.rs` | Key/value app settings repository |
| `src/vault/mod.rs` | Public `Vault` facade (init / unlock / lock / encrypt / decrypt) |
| `src/vault/kdf.rs` | Argon2id wrapper |
| `src/vault/aead.rs` | ChaCha20-Poly1305 wrapper (nonce gen, encrypt, decrypt) |
| `src/commands/vault.rs` | Tauri commands for vault lifecycle |
| `src/commands/folders.rs` | Folder CRUD commands |
| `src/commands/sessions.rs` | Session CRUD commands |
| `src/commands/credentials.rs` | Credential CRUD commands (plaintext in, never out) |
| `src/commands/settings.rs` | Settings get/set commands |
| `tauri.conf.json` | Tauri v2 configuration |
| `build.rs` | Tauri build script |

**Migrations (`migrations/`)**

| File | Responsibility |
|------|---------------|
| `<ts>_init.sql` | Full v0.1 schema (folders, sessions, credentials, known_hosts, vault_meta, app_settings) |

**Frontend (`ui/`)**

| File | Responsibility |
|------|---------------|
| `package.json`, `tsconfig.json`, `next.config.mjs`, `tailwind.config.ts`, `postcss.config.js` | Next.js static-export config |
| `app/layout.tsx` | Root layout, applies theme class + loads Tailwind |
| `app/page.tsx` | Router: unlock screen vs. main shell based on vault state |
| `app/globals.css` | Tailwind base + theme CSS variables (dark default, light override) |
| `lib/tauri.ts` | Typed wrappers around `invoke()` for each backend command |
| `lib/theme.ts` | Theme load/apply/persist helpers |
| `lib/types.ts` | Shared TypeScript DTOs matching Rust structs |
| `components/unlock-screen.tsx` | First-run set password + subsequent unlock |
| `components/main-shell.tsx` | Sidebar + tabs area + status bar layout |
| `components/sessions-sidebar.tsx` | Folder/session tree with context menu |
| `components/session-dialog.tsx` | Create/edit session form |
| `components/credential-picker.tsx` | Pick existing credential or create new (modal within session dialog) |
| `components/status-bar.tsx` | Bottom status bar with Lock button + theme toggle |
| `components/tabs-shell.tsx` | Placeholder tab strip + empty state (fully wired in Plan 2) |

**Root**

| File | Responsibility |
|------|---------------|
| `Cargo.toml` | Root workspace pointer to `src-tauri` |
| `README.md` | Dev quickstart (updated) |

---

## Pre-flight

- [ ] **Step P.1: Verify clean worktree**

Run:
```bash
cd /home/mack/dev/ezTerm
git status
```
Expected: `working tree clean` on `main`. If dirty, stash or commit before starting.

- [ ] **Step P.2: Install toolchain prerequisites (local-dev check)**

Run:
```bash
rustc --version    # 1.76+ expected
cargo --version
node --version     # 20+ expected
npm --version
cargo install tauri-cli --version '^2.0' --locked
cargo install sqlx-cli --no-default-features --features sqlite --locked
```
If `tauri-cli` or `sqlx-cli` already installed at compatible versions, skip.

---

## Task 1: Rust workspace + Tauri scaffold

**Files:**
- Create: `Cargo.toml`
- Create: `src-tauri/Cargo.toml`
- Create: `src-tauri/build.rs`
- Create: `src-tauri/tauri.conf.json`
- Create: `src-tauri/src/main.rs`
- Create: `src-tauri/icons/` (copy Tauri default icons via `cargo tauri icon` in later step)

- [ ] **Step 1.1: Write root `Cargo.toml`**

Path: `/home/mack/dev/ezTerm/Cargo.toml`
```toml
[workspace]
members = ["src-tauri"]
resolver = "2"

[workspace.package]
version = "0.1.0"
edition = "2021"
license = "MIT"
repository = "https://github.com/ZerosAndOnesLLC/ezTerm"
```

- [ ] **Step 1.2: Write `src-tauri/Cargo.toml`**

Path: `/home/mack/dev/ezTerm/src-tauri/Cargo.toml`
```toml
[package]
name = "ezterm"
version.workspace = true
edition.workspace = true
license.workspace = true
repository.workspace = true
description = "Free Windows SSH client (MobaXterm-style)."

[build-dependencies]
tauri-build = { version = "2", features = [] }

[dependencies]
tauri = { version = "2", features = [] }
tauri-plugin-dialog = "2"

tokio = { version = "1", features = ["full"] }
async-trait = "0.1"

serde = { version = "1", features = ["derive"] }
serde_json = "1"
thiserror = "1"

sqlx = { version = "0.8", features = ["runtime-tokio", "sqlite", "macros", "migrate", "chrono"] }
chrono = { version = "0.4", features = ["serde"] }

argon2 = "0.5"
chacha20poly1305 = "0.10"
rand = "0.8"
zeroize = { version = "1.7", features = ["derive"] }

tracing = "0.1"
tracing-subscriber = { version = "0.3", features = ["env-filter"] }

[dev-dependencies]
tempfile = "3"
tokio = { version = "1", features = ["full", "test-util"] }

[features]
default = ["custom-protocol"]
custom-protocol = ["tauri/custom-protocol"]
```

- [ ] **Step 1.3: Write `src-tauri/build.rs`**

Path: `/home/mack/dev/ezTerm/src-tauri/build.rs`
```rust
fn main() {
    tauri_build::build();
}
```

- [ ] **Step 1.4: Write `src-tauri/tauri.conf.json`**

Path: `/home/mack/dev/ezTerm/src-tauri/tauri.conf.json`
```json
{
  "$schema": "https://schema.tauri.app/config/2",
  "productName": "ezTerm",
  "version": "0.1.0",
  "identifier": "com.zerosandones.ezterm",
  "build": {
    "beforeDevCommand": "npm --prefix ../ui run dev",
    "devUrl": "http://localhost:5173",
    "beforeBuildCommand": "npm --prefix ../ui run build",
    "frontendDist": "../ui/out"
  },
  "app": {
    "windows": [
      {
        "title": "ezTerm",
        "width": 1280,
        "height": 800,
        "minWidth": 900,
        "minHeight": 600,
        "theme": "Dark"
      }
    ],
    "security": {
      "csp": "default-src 'self'; connect-src ipc: http://ipc.localhost; img-src 'self' data:; style-src 'self' 'unsafe-inline'; font-src 'self' data:"
    }
  },
  "bundle": {
    "active": true,
    "targets": ["msi", "nsis"],
    "icon": ["icons/32x32.png", "icons/128x128.png", "icons/icon.ico"]
  }
}
```

- [ ] **Step 1.5: Write `src-tauri/src/main.rs` (minimal boot)**

Path: `/home/mack/dev/ezTerm/src-tauri/src/main.rs`
```rust
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    tracing_subscriber::fmt()
        .with_env_filter(tracing_subscriber::EnvFilter::from_default_env())
        .init();

    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .run(tauri::generate_context!())
        .expect("error while running ezTerm");
}
```

- [ ] **Step 1.6: Generate default Tauri icons**

Run from `/home/mack/dev/ezTerm`:
```bash
curl -sSL https://raw.githubusercontent.com/tauri-apps/tauri/dev/crates/tauri-bundler/icons/icon.png -o /tmp/ezterm-seed.png
cargo tauri icon --tauri-dir src-tauri /tmp/ezterm-seed.png
```
Expected: `src-tauri/icons/` populated with platform icons. If offline, the reviewer may substitute a local PNG.

- [ ] **Step 1.7: Cargo check**

Run:
```bash
cd /home/mack/dev/ezTerm && cargo check --manifest-path src-tauri/Cargo.toml
```
Expected: compiles clean, no warnings.

- [ ] **Step 1.8: Commit**

```bash
git add Cargo.toml src-tauri/
git commit -m "feat(scaffold): Tauri v2 Rust workspace with empty main"
```

---

## Task 2: Error type + shared result

**Files:**
- Create: `src-tauri/src/error.rs`
- Modify: `src-tauri/src/main.rs` (add `mod error`)

- [ ] **Step 2.1: Write `error.rs`**

Path: `/home/mack/dev/ezTerm/src-tauri/src/error.rs`
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
}

impl Serialize for AppError {
    fn serialize<S: serde::Serializer>(&self, s: S) -> std::result::Result<S::Ok, S::Error> {
        let mut obj = serde_json::Map::new();
        obj.insert("code".into(), serde_json::Value::String(code_for(self).into()));
        obj.insert("message".into(), serde_json::Value::String(self.to_string()));
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
    }
}
```

- [ ] **Step 2.2: Register module in `main.rs`**

Path: `/home/mack/dev/ezTerm/src-tauri/src/main.rs` — add `mod error;` after the shebang/cfg lines:
```rust
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod error;

fn main() {
    /* unchanged */
}
```

- [ ] **Step 2.3: Cargo check**

Run:
```bash
cargo check --manifest-path src-tauri/Cargo.toml
```
Expected: clean.

- [ ] **Step 2.4: Commit**

```bash
git add src-tauri/src/error.rs src-tauri/src/main.rs
git commit -m "feat(error): AppError enum with serde serialization for Tauri"
```

---

## Task 3: Initial SQLite migration

**Files:**
- Create: `migrations/20260418120000_init.sql`
- Create: `.env.example`

- [ ] **Step 3.1: Write migration**

Path: `/home/mack/dev/ezTerm/migrations/20260418120000_init.sql`
```sql
PRAGMA foreign_keys = ON;

CREATE TABLE folders (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    parent_id  INTEGER REFERENCES folders(id) ON DELETE CASCADE,
    name       TEXT    NOT NULL,
    sort       INTEGER NOT NULL DEFAULT 0,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX idx_folders_parent ON folders(parent_id);

CREATE TABLE credentials (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    kind       TEXT    NOT NULL CHECK (kind IN ('password','private_key','key_passphrase')),
    label      TEXT    NOT NULL,
    nonce      BLOB    NOT NULL,
    ciphertext BLOB    NOT NULL,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE sessions (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    folder_id     INTEGER REFERENCES folders(id) ON DELETE SET NULL,
    name          TEXT    NOT NULL,
    host          TEXT    NOT NULL,
    port          INTEGER NOT NULL DEFAULT 22,
    username      TEXT    NOT NULL,
    auth_type     TEXT    NOT NULL CHECK (auth_type IN ('password','key','agent')),
    credential_id INTEGER REFERENCES credentials(id) ON DELETE SET NULL,
    color         TEXT,
    sort          INTEGER NOT NULL DEFAULT 0,
    created_at    DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at    DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX idx_sessions_folder ON sessions(folder_id);

CREATE TABLE known_hosts (
    host        TEXT    NOT NULL,
    port        INTEGER NOT NULL,
    key_type    TEXT    NOT NULL,
    fingerprint TEXT    NOT NULL,
    first_seen  DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (host, port, key_type)
);

CREATE TABLE vault_meta (
    id         INTEGER PRIMARY KEY CHECK (id = 1),
    salt       BLOB NOT NULL,
    kdf_params TEXT NOT NULL,
    verifier   BLOB NOT NULL
);

CREATE TABLE app_settings (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
);
```

- [ ] **Step 3.2: Write `.env.example`**

Path: `/home/mack/dev/ezTerm/.env.example`
```
DATABASE_URL=sqlite://./dev.sqlite
```

- [ ] **Step 3.3: Run migration against a throwaway dev DB**

Run:
```bash
cp .env.example .env
export DATABASE_URL=sqlite://./dev.sqlite
sqlx database create
sqlx migrate run
```
Expected: migration applied, `dev.sqlite` created. `.env` and `dev.sqlite` must be ignored by `.gitignore` (already covered).

- [ ] **Step 3.4: Commit**

```bash
git add migrations/ .env.example
git commit -m "feat(db): initial SQLite schema migration"
```

---

## Task 4: Database pool + state scaffolding

**Files:**
- Create: `src-tauri/src/db/mod.rs`
- Create: `src-tauri/src/state.rs`
- Modify: `src-tauri/src/main.rs`

- [ ] **Step 4.1: Write `db/mod.rs`**

Path: `/home/mack/dev/ezTerm/src-tauri/src/db/mod.rs`
```rust
use sqlx::sqlite::{SqliteConnectOptions, SqlitePoolOptions};
use sqlx::SqlitePool;
use std::path::Path;
use std::str::FromStr;

pub mod credentials;
pub mod folders;
pub mod sessions;
pub mod settings;

static MIGRATOR: sqlx::migrate::Migrator = sqlx::migrate!("../migrations");

pub async fn init_pool(db_path: &Path) -> crate::error::Result<SqlitePool> {
    if let Some(parent) = db_path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let url = format!("sqlite://{}", db_path.display());
    let opts = SqliteConnectOptions::from_str(&url)?
        .create_if_missing(true)
        .foreign_keys(true)
        .journal_mode(sqlx::sqlite::SqliteJournalMode::Wal);
    let pool = SqlitePoolOptions::new().max_connections(8).connect_with(opts).await?;
    MIGRATOR.run(&pool).await?;
    Ok(pool)
}
```

- [ ] **Step 4.2: Write empty module stubs**

Create `src-tauri/src/db/folders.rs`, `sessions.rs`, `credentials.rs`, `settings.rs` each containing a single line:
```rust
// Repository — implemented in later tasks.
```

- [ ] **Step 4.3: Write `state.rs`**

Path: `/home/mack/dev/ezTerm/src-tauri/src/state.rs`
```rust
use sqlx::SqlitePool;
use tokio::sync::RwLock;

use crate::vault::VaultState;

pub struct AppState {
    pub db: SqlitePool,
    pub vault: RwLock<VaultState>,
}

impl AppState {
    pub fn new(db: SqlitePool) -> Self {
        Self { db, vault: RwLock::new(VaultState::Locked) }
    }
}
```

- [ ] **Step 4.4: Create vault module placeholder**

Path: `/home/mack/dev/ezTerm/src-tauri/src/vault/mod.rs`
```rust
// Real implementation arrives in Task 5; placeholder keeps state.rs compiling.
pub enum VaultState {
    Uninitialized,
    Locked,
    Unlocked { key: zeroize::Zeroizing<[u8; 32]> },
}
```

- [ ] **Step 4.5: Wire modules in `main.rs`**

Path: `/home/mack/dev/ezTerm/src-tauri/src/main.rs`
```rust
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod db;
mod error;
mod state;
mod vault;

use state::AppState;

#[tokio::main]
async fn main() {
    tracing_subscriber::fmt()
        .with_env_filter(tracing_subscriber::EnvFilter::from_default_env())
        .init();

    let db_path = resolve_db_path();
    let pool = db::init_pool(&db_path).await.expect("init db");
    let app_state = AppState::new(pool);

    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .manage(app_state)
        .run(tauri::generate_context!())
        .expect("error while running ezTerm");
}

fn resolve_db_path() -> std::path::PathBuf {
    let base = directories::ProjectDirs::from("com", "ZerosAndOnes", "ezTerm")
        .map(|d| d.data_local_dir().to_path_buf())
        .unwrap_or_else(|| std::path::PathBuf::from("./"));
    base.join("ezterm.sqlite")
}
```

- [ ] **Step 4.6: Add `directories` dep**

Path: `src-tauri/Cargo.toml` — add under `[dependencies]`:
```toml
directories = "5"
```

- [ ] **Step 4.7: Cargo check**

Run: `cargo check --manifest-path src-tauri/Cargo.toml`
Expected: clean. If `sqlx::migrate!` fails pointing at the migrations dir, verify the relative path `../migrations` from `src-tauri/`.

- [ ] **Step 4.8: Commit**

```bash
git add src-tauri/
git commit -m "feat(db): pool + migrator boot, AppState skeleton"
```

---

## Task 5: Vault — Argon2id KDF

**Files:**
- Create: `src-tauri/src/vault/kdf.rs`
- Modify: `src-tauri/src/vault/mod.rs`

- [x] **Step 5.1: Write failing test**

Path: `/home/mack/dev/ezTerm/src-tauri/src/vault/kdf.rs`
```rust
use argon2::{Algorithm, Argon2, Params, Version};
use serde::{Deserialize, Serialize};
use zeroize::Zeroizing;

#[derive(Clone, Copy, Debug, Serialize, Deserialize, PartialEq, Eq)]
pub struct KdfParams {
    pub m_cost_kib: u32,
    pub t_cost: u32,
    pub p_cost: u32,
}

impl Default for KdfParams {
    fn default() -> Self {
        Self { m_cost_kib: 64 * 1024, t_cost: 3, p_cost: 1 }
    }
}

pub fn derive_key(
    password: &[u8],
    salt: &[u8],
    params: KdfParams,
) -> crate::error::Result<Zeroizing<[u8; 32]>> {
    let mut out = Zeroizing::new([0u8; 32]);
    let p = Params::new(params.m_cost_kib, params.t_cost, params.p_cost, Some(32))
        .map_err(|_| crate::error::AppError::Crypto)?;
    let a2 = Argon2::new(Algorithm::Argon2id, Version::V0x13, p);
    a2.hash_password_into(password, salt, &mut *out)
        .map_err(|_| crate::error::AppError::Crypto)?;
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn derive_is_deterministic_for_same_inputs() {
        let salt = [7u8; 16];
        let p = KdfParams { m_cost_kib: 8 * 1024, t_cost: 1, p_cost: 1 }; // fast for tests
        let a = derive_key(b"correct horse", &salt, p).unwrap();
        let b = derive_key(b"correct horse", &salt, p).unwrap();
        assert_eq!(*a, *b);
    }

    #[test]
    fn derive_differs_with_different_password() {
        let salt = [7u8; 16];
        let p = KdfParams { m_cost_kib: 8 * 1024, t_cost: 1, p_cost: 1 };
        let a = derive_key(b"aaa", &salt, p).unwrap();
        let b = derive_key(b"bbb", &salt, p).unwrap();
        assert_ne!(*a, *b);
    }
}
```

- [x] **Step 5.2: Register in `vault/mod.rs`**

Path: `/home/mack/dev/ezTerm/src-tauri/src/vault/mod.rs`
```rust
pub mod kdf;

pub enum VaultState {
    Uninitialized,
    Locked,
    Unlocked { key: zeroize::Zeroizing<[u8; 32]> },
}
```

- [x] **Step 5.3: Run tests**

Run:
```bash
cargo test --manifest-path src-tauri/Cargo.toml vault::kdf -- --nocapture
```
Expected: 2 tests pass.

- [x] **Step 5.4: Commit**

```bash
git add src-tauri/src/vault/
git commit -m "feat(vault): Argon2id KDF with configurable params"
```

---

## Task 6: Vault — ChaCha20-Poly1305 AEAD

**Files:**
- Create: `src-tauri/src/vault/aead.rs`
- Modify: `src-tauri/src/vault/mod.rs`

- [x] **Step 6.1: Write the module with tests**

Path: `/home/mack/dev/ezTerm/src-tauri/src/vault/aead.rs`
```rust
use chacha20poly1305::{aead::{Aead, KeyInit}, ChaCha20Poly1305, Key, Nonce};
use rand::RngCore;

use crate::error::{AppError, Result};

pub struct Aead256([u8; 32]);

impl Aead256 {
    pub fn new(key: &[u8; 32]) -> Self { Self(*key) }

    pub fn encrypt(&self, plaintext: &[u8]) -> Result<(Vec<u8>, Vec<u8>)> {
        let cipher = ChaCha20Poly1305::new(Key::from_slice(&self.0));
        let mut nonce_bytes = [0u8; 12];
        rand::thread_rng().fill_bytes(&mut nonce_bytes);
        let nonce = Nonce::from_slice(&nonce_bytes);
        let ct = cipher.encrypt(nonce, plaintext).map_err(|_| AppError::Crypto)?;
        Ok((nonce_bytes.to_vec(), ct))
    }

    pub fn decrypt(&self, nonce: &[u8], ciphertext: &[u8]) -> Result<Vec<u8>> {
        if nonce.len() != 12 { return Err(AppError::Crypto); }
        let cipher = ChaCha20Poly1305::new(Key::from_slice(&self.0));
        let nonce = Nonce::from_slice(nonce);
        cipher.decrypt(nonce, ciphertext).map_err(|_| AppError::Crypto)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn roundtrip() {
        let key = [9u8; 32];
        let a = Aead256::new(&key);
        let (nonce, ct) = a.encrypt(b"hello secret").unwrap();
        let pt = a.decrypt(&nonce, &ct).unwrap();
        assert_eq!(pt, b"hello secret");
    }

    #[test]
    fn wrong_key_fails() {
        let a = Aead256::new(&[1u8; 32]);
        let b = Aead256::new(&[2u8; 32]);
        let (nonce, ct) = a.encrypt(b"data").unwrap();
        assert!(b.decrypt(&nonce, &ct).is_err());
    }

    #[test]
    fn tamper_fails() {
        let a = Aead256::new(&[3u8; 32]);
        let (nonce, mut ct) = a.encrypt(b"data").unwrap();
        ct[0] ^= 0x01;
        assert!(a.decrypt(&nonce, &ct).is_err());
    }
}
```

- [x] **Step 6.2: Register in `vault/mod.rs`**

```rust
pub mod aead;
pub mod kdf;

pub enum VaultState {
    Uninitialized,
    Locked,
    Unlocked { key: zeroize::Zeroizing<[u8; 32]> },
}
```

- [x] **Step 6.3: Run tests**

Run: `cargo test --manifest-path src-tauri/Cargo.toml vault::aead`
Expected: 3 tests pass.

- [x] **Step 6.4: Commit**

```bash
git add src-tauri/src/vault/
git commit -m "feat(vault): ChaCha20-Poly1305 AEAD with nonce gen"
```

---

## Task 7: Vault facade — init / unlock / encrypt / decrypt

**Files:**
- Modify: `src-tauri/src/vault/mod.rs`
- Create: `src-tauri/src/vault/tests.rs`

- [x] **Step 7.1: Write the facade**

Path: `/home/mack/dev/ezTerm/src-tauri/src/vault/mod.rs`
```rust
pub mod aead;
pub mod kdf;
#[cfg(test)]
mod tests;

use rand::RngCore;
use serde::{Deserialize, Serialize};
use sqlx::SqlitePool;
use zeroize::Zeroizing;

use crate::error::{AppError, Result};
use aead::Aead256;
use kdf::KdfParams;

const VERIFIER_PLAINTEXT: &[u8] = b"ezterm-v0.1-vault";

pub enum VaultState {
    Uninitialized,
    Locked,
    Unlocked { key: Zeroizing<[u8; 32]> },
}

impl VaultState {
    pub fn is_unlocked(&self) -> bool { matches!(self, VaultState::Unlocked { .. }) }
}

#[derive(Serialize, Deserialize)]
struct StoredKdfParams {
    m: u32, t: u32, p: u32,
}

impl From<KdfParams> for StoredKdfParams {
    fn from(v: KdfParams) -> Self { Self { m: v.m_cost_kib, t: v.t_cost, p: v.p_cost } }
}
impl From<StoredKdfParams> for KdfParams {
    fn from(v: StoredKdfParams) -> Self {
        KdfParams { m_cost_kib: v.m, t_cost: v.t, p_cost: v.p }
    }
}

pub async fn is_initialized(pool: &SqlitePool) -> Result<bool> {
    let row: Option<(i64,)> = sqlx::query_as("SELECT 1 FROM vault_meta WHERE id = 1")
        .fetch_optional(pool).await?;
    Ok(row.is_some())
}

pub async fn init(pool: &SqlitePool, password: &str) -> Result<VaultState> {
    if is_initialized(pool).await? { return Err(AppError::VaultAlreadyInitialized); }
    let mut salt = [0u8; 16];
    rand::thread_rng().fill_bytes(&mut salt);
    let params = KdfParams::default();
    let key = kdf::derive_key(password.as_bytes(), &salt, params)?;
    let aead = Aead256::new(&*key);
    let (nonce, ct) = aead.encrypt(VERIFIER_PLAINTEXT)?;
    // Store verifier as nonce || ct concatenation
    let mut verifier = Vec::with_capacity(nonce.len() + ct.len());
    verifier.extend_from_slice(&nonce);
    verifier.extend_from_slice(&ct);
    let stored_params = serde_json::to_string(&StoredKdfParams::from(params))?;
    sqlx::query("INSERT INTO vault_meta (id, salt, kdf_params, verifier) VALUES (1, ?, ?, ?)")
        .bind(&salt[..]).bind(stored_params).bind(&verifier)
        .execute(pool).await?;
    Ok(VaultState::Unlocked { key })
}

pub async fn unlock(pool: &SqlitePool, password: &str) -> Result<VaultState> {
    let row: (Vec<u8>, String, Vec<u8>) =
        sqlx::query_as("SELECT salt, kdf_params, verifier FROM vault_meta WHERE id = 1")
            .fetch_optional(pool).await?.ok_or(AppError::NotFound)?;
    let (salt, params_json, verifier) = row;
    let stored: StoredKdfParams = serde_json::from_str(&params_json)?;
    let params: KdfParams = stored.into();
    let key = kdf::derive_key(password.as_bytes(), &salt, params)?;
    if verifier.len() < 12 { return Err(AppError::Crypto); }
    let (nonce, ct) = verifier.split_at(12);
    let aead = Aead256::new(&*key);
    let pt = aead.decrypt(nonce, ct).map_err(|_| AppError::BadPassword)?;
    if pt != VERIFIER_PLAINTEXT { return Err(AppError::BadPassword); }
    Ok(VaultState::Unlocked { key })
}

pub fn encrypt_with(state: &VaultState, plaintext: &[u8]) -> Result<(Vec<u8>, Vec<u8>)> {
    match state {
        VaultState::Unlocked { key } => Aead256::new(&**key).encrypt(plaintext),
        _ => Err(AppError::VaultLocked),
    }
}

pub fn decrypt_with(state: &VaultState, nonce: &[u8], ciphertext: &[u8]) -> Result<Vec<u8>> {
    match state {
        VaultState::Unlocked { key } => Aead256::new(&**key).decrypt(nonce, ciphertext),
        _ => Err(AppError::VaultLocked),
    }
}
```

- [x] **Step 7.2: Write integration tests**

Path: `/home/mack/dev/ezTerm/src-tauri/src/vault/tests.rs`
```rust
use super::*;
use sqlx::sqlite::SqlitePoolOptions;

async fn mem_pool() -> SqlitePool {
    let pool = SqlitePoolOptions::new()
        .max_connections(1)
        .connect("sqlite::memory:").await.unwrap();
    crate::db::init_pool_from_pool(&pool).await.unwrap();
    pool
}

#[tokio::test]
async fn init_then_unlock_roundtrip() {
    let pool = mem_pool().await;
    let _ = init(&pool, "hunter2").await.unwrap();
    let st = unlock(&pool, "hunter2").await.unwrap();
    assert!(st.is_unlocked());
}

#[tokio::test]
async fn wrong_password_rejected() {
    let pool = mem_pool().await;
    let _ = init(&pool, "right").await.unwrap();
    let err = unlock(&pool, "wrong").await.err().unwrap();
    assert!(matches!(err, AppError::BadPassword));
}

#[tokio::test]
async fn double_init_rejected() {
    let pool = mem_pool().await;
    let _ = init(&pool, "a").await.unwrap();
    let err = init(&pool, "a").await.err().unwrap();
    assert!(matches!(err, AppError::VaultAlreadyInitialized));
}
```

- [x] **Step 7.3: Add test helper to `db/mod.rs`**

Append to `src-tauri/src/db/mod.rs`:
```rust
#[cfg(test)]
pub async fn init_pool_from_pool(pool: &SqlitePool) -> crate::error::Result<()> {
    MIGRATOR.run(pool).await?;
    Ok(())
}
```

- [x] **Step 7.4: Run tests**

Run: `cargo test --manifest-path src-tauri/Cargo.toml vault`
Expected: all pass.

- [x] **Step 7.5: Commit**

```bash
git add src-tauri/src/vault/ src-tauri/src/db/mod.rs
git commit -m "feat(vault): init/unlock facade with Argon2id+AEAD verifier"
```

---

## Task 8: Folders repository + commands

**Files:**
- Modify: `src-tauri/src/db/folders.rs`
- Create: `src-tauri/src/commands/mod.rs`
- Create: `src-tauri/src/commands/folders.rs`
- Modify: `src-tauri/src/main.rs`

- [ ] **Step 8.1: Folders repository**

Path: `/home/mack/dev/ezTerm/src-tauri/src/db/folders.rs`
```rust
use serde::{Deserialize, Serialize};
use sqlx::SqlitePool;

use crate::error::Result;

#[derive(Clone, Debug, Serialize, Deserialize, sqlx::FromRow)]
pub struct Folder {
    pub id: i64,
    pub parent_id: Option<i64>,
    pub name: String,
    pub sort: i64,
}

pub async fn list(pool: &SqlitePool) -> Result<Vec<Folder>> {
    Ok(sqlx::query_as::<_, Folder>(
        "SELECT id, parent_id, name, sort FROM folders ORDER BY parent_id, sort, id"
    ).fetch_all(pool).await?)
}

pub async fn create(pool: &SqlitePool, parent_id: Option<i64>, name: &str) -> Result<Folder> {
    let id = sqlx::query("INSERT INTO folders (parent_id, name) VALUES (?, ?)")
        .bind(parent_id).bind(name).execute(pool).await?.last_insert_rowid();
    Ok(Folder { id, parent_id, name: name.into(), sort: 0 })
}

pub async fn rename(pool: &SqlitePool, id: i64, name: &str) -> Result<()> {
    sqlx::query("UPDATE folders SET name = ? WHERE id = ?")
        .bind(name).bind(id).execute(pool).await?;
    Ok(())
}

pub async fn delete(pool: &SqlitePool, id: i64) -> Result<()> {
    sqlx::query("DELETE FROM folders WHERE id = ?").bind(id).execute(pool).await?;
    Ok(())
}

pub async fn mv(pool: &SqlitePool, id: i64, parent_id: Option<i64>, sort: i64) -> Result<()> {
    sqlx::query("UPDATE folders SET parent_id = ?, sort = ? WHERE id = ?")
        .bind(parent_id).bind(sort).bind(id).execute(pool).await?;
    Ok(())
}
```

- [ ] **Step 8.2: Commands module scaffold**

Path: `/home/mack/dev/ezTerm/src-tauri/src/commands/mod.rs`
```rust
pub mod folders;
```

- [ ] **Step 8.3: Folder commands**

Path: `/home/mack/dev/ezTerm/src-tauri/src/commands/folders.rs`
```rust
use tauri::State;

use crate::db::folders::{self, Folder};
use crate::error::Result;
use crate::state::AppState;

#[tauri::command]
pub async fn folder_list(state: State<'_, AppState>) -> Result<Vec<Folder>> {
    folders::list(&state.db).await
}

#[tauri::command]
pub async fn folder_create(state: State<'_, AppState>, parent_id: Option<i64>, name: String) -> Result<Folder> {
    if name.trim().is_empty() {
        return Err(crate::error::AppError::Validation("name required".into()));
    }
    folders::create(&state.db, parent_id, name.trim()).await
}

#[tauri::command]
pub async fn folder_rename(state: State<'_, AppState>, id: i64, name: String) -> Result<()> {
    if name.trim().is_empty() {
        return Err(crate::error::AppError::Validation("name required".into()));
    }
    folders::rename(&state.db, id, name.trim()).await
}

#[tauri::command]
pub async fn folder_delete(state: State<'_, AppState>, id: i64) -> Result<()> {
    folders::delete(&state.db, id).await
}

#[tauri::command]
pub async fn folder_move(state: State<'_, AppState>, id: i64, parent_id: Option<i64>, sort: i64) -> Result<()> {
    folders::mv(&state.db, id, parent_id, sort).await
}
```

- [ ] **Step 8.4: Register in `main.rs`**

Update `main.rs` to include `mod commands;` and to register the handlers:

```rust
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod commands;
mod db;
mod error;
mod state;
mod vault;

use state::AppState;

#[tokio::main]
async fn main() {
    tracing_subscriber::fmt()
        .with_env_filter(tracing_subscriber::EnvFilter::from_default_env())
        .init();

    let db_path = resolve_db_path();
    let pool = db::init_pool(&db_path).await.expect("init db");
    let app_state = AppState::new(pool);

    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .manage(app_state)
        .invoke_handler(tauri::generate_handler![
            commands::folders::folder_list,
            commands::folders::folder_create,
            commands::folders::folder_rename,
            commands::folders::folder_delete,
            commands::folders::folder_move,
        ])
        .run(tauri::generate_context!())
        .expect("error while running ezTerm");
}

fn resolve_db_path() -> std::path::PathBuf {
    let base = directories::ProjectDirs::from("com", "ZerosAndOnes", "ezTerm")
        .map(|d| d.data_local_dir().to_path_buf())
        .unwrap_or_else(|| std::path::PathBuf::from("./"));
    base.join("ezterm.sqlite")
}
```

- [ ] **Step 8.5: Integration test for folders**

Path: `/home/mack/dev/ezTerm/src-tauri/src/db/folders.rs` — append:
```rust
#[cfg(test)]
mod tests {
    use super::*;
    use sqlx::sqlite::SqlitePoolOptions;

    async fn pool() -> SqlitePool {
        let p = SqlitePoolOptions::new().max_connections(1).connect("sqlite::memory:").await.unwrap();
        crate::db::init_pool_from_pool(&p).await.unwrap();
        p
    }

    #[tokio::test]
    async fn create_list_rename_delete() {
        let p = pool().await;
        let a = create(&p, None, "prod").await.unwrap();
        let _ = create(&p, Some(a.id), "web").await.unwrap();
        assert_eq!(list(&p).await.unwrap().len(), 2);
        rename(&p, a.id, "production").await.unwrap();
        delete(&p, a.id).await.unwrap();
        // cascade deletes children
        assert_eq!(list(&p).await.unwrap().len(), 0);
    }
}
```

- [ ] **Step 8.6: Run tests + cargo check**

Run:
```bash
cargo test --manifest-path src-tauri/Cargo.toml db::folders
cargo check --manifest-path src-tauri/Cargo.toml
```
Expected: tests pass, check clean.

- [ ] **Step 8.7: Commit**

```bash
git add src-tauri/
git commit -m "feat(folders): repository + Tauri CRUD commands"
```

---

## Task 9: Credentials repository + commands

**Files:**
- Modify: `src-tauri/src/db/credentials.rs`
- Create: `src-tauri/src/commands/credentials.rs`
- Modify: `src-tauri/src/commands/mod.rs`
- Modify: `src-tauri/src/main.rs`

- [ ] **Step 9.1: Credentials repository (no plaintext in public API)**

Path: `/home/mack/dev/ezTerm/src-tauri/src/db/credentials.rs`
```rust
use serde::{Deserialize, Serialize};
use sqlx::SqlitePool;

use crate::error::Result;

#[derive(Clone, Debug, Serialize, Deserialize, sqlx::FromRow)]
pub struct CredentialMeta {
    pub id: i64,
    pub kind: String,   // 'password' | 'private_key' | 'key_passphrase'
    pub label: String,
}

#[derive(sqlx::FromRow)]
pub(crate) struct CredentialRow {
    pub id: i64,
    pub kind: String,
    pub label: String,
    pub nonce: Vec<u8>,
    pub ciphertext: Vec<u8>,
}

pub async fn list(pool: &SqlitePool) -> Result<Vec<CredentialMeta>> {
    Ok(sqlx::query_as::<_, CredentialMeta>(
        "SELECT id, kind, label FROM credentials ORDER BY id DESC"
    ).fetch_all(pool).await?)
}

pub(crate) async fn insert(
    pool: &SqlitePool, kind: &str, label: &str, nonce: &[u8], ciphertext: &[u8],
) -> Result<i64> {
    let id = sqlx::query(
        "INSERT INTO credentials (kind, label, nonce, ciphertext) VALUES (?, ?, ?, ?)"
    ).bind(kind).bind(label).bind(nonce).bind(ciphertext)
     .execute(pool).await?.last_insert_rowid();
    Ok(id)
}

pub(crate) async fn get(pool: &SqlitePool, id: i64) -> Result<CredentialRow> {
    sqlx::query_as::<_, CredentialRow>(
        "SELECT id, kind, label, nonce, ciphertext FROM credentials WHERE id = ?"
    ).bind(id).fetch_optional(pool).await?.ok_or(crate::error::AppError::NotFound)
}

pub async fn delete(pool: &SqlitePool, id: i64) -> Result<()> {
    sqlx::query("DELETE FROM credentials WHERE id = ?").bind(id).execute(pool).await?;
    Ok(())
}
```

- [ ] **Step 9.2: Credentials commands**

Path: `/home/mack/dev/ezTerm/src-tauri/src/commands/credentials.rs`
```rust
use tauri::State;
use zeroize::Zeroize;

use crate::db::credentials::{self, CredentialMeta};
use crate::error::{AppError, Result};
use crate::state::AppState;
use crate::vault;

#[tauri::command]
pub async fn credential_list(state: State<'_, AppState>) -> Result<Vec<CredentialMeta>> {
    credentials::list(&state.db).await
}

#[tauri::command]
pub async fn credential_create(
    state: State<'_, AppState>,
    kind: String,
    label: String,
    mut plaintext: String,
) -> Result<CredentialMeta> {
    if !matches!(kind.as_str(), "password" | "private_key" | "key_passphrase") {
        return Err(AppError::Validation("invalid kind".into()));
    }
    if label.trim().is_empty() {
        return Err(AppError::Validation("label required".into()));
    }
    let vault_state = state.vault.read().await;
    let (nonce, ct) = vault::encrypt_with(&*vault_state, plaintext.as_bytes())?;
    plaintext.zeroize();
    let id = credentials::insert(&state.db, &kind, label.trim(), &nonce, &ct).await?;
    Ok(CredentialMeta { id, kind, label: label.trim().into() })
}

#[tauri::command]
pub async fn credential_delete(state: State<'_, AppState>, id: i64) -> Result<()> {
    credentials::delete(&state.db, id).await
}
```

Note: **there is deliberately no `credential_get_plaintext` command**. Plaintext is only reached via the internal `vault::decrypt_with` path inside SSH/SFTP flows (Plans 2 and 3). Keeping that invariant is a code-review gate.

- [ ] **Step 9.3: Register module + handlers**

Update `src-tauri/src/commands/mod.rs`:
```rust
pub mod credentials;
pub mod folders;
```

Update the `invoke_handler!` macro in `main.rs` to also include:
```rust
commands::credentials::credential_list,
commands::credentials::credential_create,
commands::credentials::credential_delete,
```

- [ ] **Step 9.4: Integration test**

Append to `src-tauri/src/db/credentials.rs`:
```rust
#[cfg(test)]
mod tests {
    use super::*;
    use sqlx::sqlite::SqlitePoolOptions;

    async fn pool() -> SqlitePool {
        let p = SqlitePoolOptions::new().max_connections(1).connect("sqlite::memory:").await.unwrap();
        crate::db::init_pool_from_pool(&p).await.unwrap();
        p
    }

    #[tokio::test]
    async fn insert_list_delete() {
        let p = pool().await;
        let id = insert(&p, "password", "prod-db", &[0u8; 12], &[1, 2, 3]).await.unwrap();
        assert_eq!(list(&p).await.unwrap().len(), 1);
        let row = get(&p, id).await.unwrap();
        assert_eq!(row.nonce.len(), 12);
        delete(&p, id).await.unwrap();
        assert_eq!(list(&p).await.unwrap().len(), 0);
    }
}
```

- [ ] **Step 9.5: Run tests + cargo check**

```bash
cargo test --manifest-path src-tauri/Cargo.toml db::credentials
cargo check --manifest-path src-tauri/Cargo.toml
```
Expected: all pass, clean.

- [ ] **Step 9.6: Commit**

```bash
git add src-tauri/
git commit -m "feat(credentials): repo + commands; plaintext stays in Rust"
```

---

## Task 10: Sessions repository + commands

**Files:**
- Modify: `src-tauri/src/db/sessions.rs`
- Create: `src-tauri/src/commands/sessions.rs`
- Modify: `src-tauri/src/commands/mod.rs`
- Modify: `src-tauri/src/main.rs`

- [ ] **Step 10.1: Sessions repository**

Path: `/home/mack/dev/ezTerm/src-tauri/src/db/sessions.rs`
```rust
use serde::{Deserialize, Serialize};
use sqlx::SqlitePool;

use crate::error::Result;

#[derive(Clone, Debug, Serialize, Deserialize, sqlx::FromRow)]
pub struct Session {
    pub id: i64,
    pub folder_id: Option<i64>,
    pub name: String,
    pub host: String,
    pub port: i64,
    pub username: String,
    pub auth_type: String,         // 'password' | 'key' | 'agent'
    pub credential_id: Option<i64>,
    pub color: Option<String>,
    pub sort: i64,
}

#[derive(Debug, Deserialize)]
pub struct SessionInput {
    pub folder_id: Option<i64>,
    pub name: String,
    pub host: String,
    pub port: i64,
    pub username: String,
    pub auth_type: String,
    pub credential_id: Option<i64>,
    pub color: Option<String>,
}

pub async fn list(pool: &SqlitePool) -> Result<Vec<Session>> {
    Ok(sqlx::query_as::<_, Session>(
        "SELECT id, folder_id, name, host, port, username, auth_type, credential_id, color, sort \
         FROM sessions ORDER BY folder_id, sort, id"
    ).fetch_all(pool).await?)
}

pub async fn get(pool: &SqlitePool, id: i64) -> Result<Session> {
    sqlx::query_as::<_, Session>(
        "SELECT id, folder_id, name, host, port, username, auth_type, credential_id, color, sort \
         FROM sessions WHERE id = ?"
    ).bind(id).fetch_optional(pool).await?.ok_or(crate::error::AppError::NotFound)
}

pub async fn create(pool: &SqlitePool, input: &SessionInput) -> Result<Session> {
    let id = sqlx::query(
        "INSERT INTO sessions (folder_id, name, host, port, username, auth_type, credential_id, color) \
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)"
    )
    .bind(input.folder_id).bind(&input.name).bind(&input.host).bind(input.port)
    .bind(&input.username).bind(&input.auth_type).bind(input.credential_id).bind(&input.color)
    .execute(pool).await?.last_insert_rowid();
    get(pool, id).await
}

pub async fn update(pool: &SqlitePool, id: i64, input: &SessionInput) -> Result<Session> {
    sqlx::query(
        "UPDATE sessions SET folder_id = ?, name = ?, host = ?, port = ?, username = ?, \
         auth_type = ?, credential_id = ?, color = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?"
    )
    .bind(input.folder_id).bind(&input.name).bind(&input.host).bind(input.port)
    .bind(&input.username).bind(&input.auth_type).bind(input.credential_id).bind(&input.color)
    .bind(id).execute(pool).await?;
    get(pool, id).await
}

pub async fn delete(pool: &SqlitePool, id: i64) -> Result<()> {
    sqlx::query("DELETE FROM sessions WHERE id = ?").bind(id).execute(pool).await?;
    Ok(())
}

pub async fn duplicate(pool: &SqlitePool, id: i64) -> Result<Session> {
    let src = get(pool, id).await?;
    let input = SessionInput {
        folder_id: src.folder_id,
        name: format!("{} (copy)", src.name),
        host: src.host,
        port: src.port,
        username: src.username,
        auth_type: src.auth_type,
        credential_id: src.credential_id,
        color: src.color,
    };
    create(pool, &input).await
}
```

- [ ] **Step 10.2: Commands**

Path: `/home/mack/dev/ezTerm/src-tauri/src/commands/sessions.rs`
```rust
use tauri::State;

use crate::db::sessions::{self, Session, SessionInput};
use crate::error::{AppError, Result};
use crate::state::AppState;

fn validate(input: &SessionInput) -> Result<()> {
    if input.name.trim().is_empty()     { return Err(AppError::Validation("name required".into())); }
    if input.host.trim().is_empty()     { return Err(AppError::Validation("host required".into())); }
    if input.username.trim().is_empty() { return Err(AppError::Validation("username required".into())); }
    if input.port <= 0 || input.port > 65535 {
        return Err(AppError::Validation("port out of range".into()));
    }
    if !matches!(input.auth_type.as_str(), "password" | "key" | "agent") {
        return Err(AppError::Validation("invalid auth_type".into()));
    }
    Ok(())
}

#[tauri::command]
pub async fn session_list(state: State<'_, AppState>) -> Result<Vec<Session>> {
    sessions::list(&state.db).await
}

#[tauri::command]
pub async fn session_get(state: State<'_, AppState>, id: i64) -> Result<Session> {
    sessions::get(&state.db, id).await
}

#[tauri::command]
pub async fn session_create(state: State<'_, AppState>, input: SessionInput) -> Result<Session> {
    validate(&input)?;
    sessions::create(&state.db, &input).await
}

#[tauri::command]
pub async fn session_update(state: State<'_, AppState>, id: i64, input: SessionInput) -> Result<Session> {
    validate(&input)?;
    sessions::update(&state.db, id, &input).await
}

#[tauri::command]
pub async fn session_delete(state: State<'_, AppState>, id: i64) -> Result<()> {
    sessions::delete(&state.db, id).await
}

#[tauri::command]
pub async fn session_duplicate(state: State<'_, AppState>, id: i64) -> Result<Session> {
    sessions::duplicate(&state.db, id).await
}
```

- [ ] **Step 10.3: Register handlers**

Add `pub mod sessions;` to `src-tauri/src/commands/mod.rs`. Extend `invoke_handler!` in `main.rs`:
```rust
commands::sessions::session_list,
commands::sessions::session_get,
commands::sessions::session_create,
commands::sessions::session_update,
commands::sessions::session_delete,
commands::sessions::session_duplicate,
```

- [ ] **Step 10.4: Repository test**

Append to `src-tauri/src/db/sessions.rs`:
```rust
#[cfg(test)]
mod tests {
    use super::*;
    use sqlx::sqlite::SqlitePoolOptions;

    async fn pool() -> SqlitePool {
        let p = SqlitePoolOptions::new().max_connections(1).connect("sqlite::memory:").await.unwrap();
        crate::db::init_pool_from_pool(&p).await.unwrap();
        p
    }

    fn input(name: &str) -> SessionInput {
        SessionInput {
            folder_id: None,
            name: name.into(),
            host: "example.com".into(),
            port: 22,
            username: "root".into(),
            auth_type: "agent".into(),
            credential_id: None,
            color: None,
        }
    }

    #[tokio::test]
    async fn crud() {
        let p = pool().await;
        let s = create(&p, &input("alpha")).await.unwrap();
        assert_eq!(list(&p).await.unwrap().len(), 1);
        let dupe = duplicate(&p, s.id).await.unwrap();
        assert_eq!(dupe.name, "alpha (copy)");
        let mut upd = input("alpha2");
        upd.port = 2222;
        update(&p, s.id, &upd).await.unwrap();
        let got = get(&p, s.id).await.unwrap();
        assert_eq!(got.port, 2222);
        delete(&p, s.id).await.unwrap();
        assert_eq!(list(&p).await.unwrap().len(), 1); // duplicate remains
    }
}
```

- [ ] **Step 10.5: Run tests + cargo check**

```bash
cargo test --manifest-path src-tauri/Cargo.toml db::sessions
cargo check --manifest-path src-tauri/Cargo.toml
```
Expected: all pass.

- [ ] **Step 10.6: Commit**

```bash
git add src-tauri/
git commit -m "feat(sessions): repo + Tauri CRUD + duplicate"
```

---

## Task 11: Settings repository + commands + vault commands

**Files:**
- Modify: `src-tauri/src/db/settings.rs`
- Create: `src-tauri/src/commands/settings.rs`
- Create: `src-tauri/src/commands/vault.rs`
- Modify: `src-tauri/src/commands/mod.rs`
- Modify: `src-tauri/src/main.rs`

- [ ] **Step 11.1: Settings repo**

Path: `/home/mack/dev/ezTerm/src-tauri/src/db/settings.rs`
```rust
use sqlx::SqlitePool;

use crate::error::Result;

pub async fn get(pool: &SqlitePool, key: &str) -> Result<Option<String>> {
    let row: Option<(String,)> =
        sqlx::query_as("SELECT value FROM app_settings WHERE key = ?")
            .bind(key).fetch_optional(pool).await?;
    Ok(row.map(|(v,)| v))
}

pub async fn set(pool: &SqlitePool, key: &str, value: &str) -> Result<()> {
    sqlx::query(
        "INSERT INTO app_settings (key, value) VALUES (?, ?) \
         ON CONFLICT(key) DO UPDATE SET value = excluded.value"
    ).bind(key).bind(value).execute(pool).await?;
    Ok(())
}
```

- [ ] **Step 11.2: Settings commands**

Path: `/home/mack/dev/ezTerm/src-tauri/src/commands/settings.rs`
```rust
use tauri::State;

use crate::db::settings;
use crate::error::Result;
use crate::state::AppState;

#[tauri::command]
pub async fn settings_get(state: State<'_, AppState>, key: String) -> Result<Option<String>> {
    settings::get(&state.db, &key).await
}

#[tauri::command]
pub async fn settings_set(state: State<'_, AppState>, key: String, value: String) -> Result<()> {
    settings::set(&state.db, &key, &value).await
}
```

- [ ] **Step 11.3: Vault commands**

Path: `/home/mack/dev/ezTerm/src-tauri/src/commands/vault.rs`
```rust
use tauri::State;

use crate::error::{AppError, Result};
use crate::state::AppState;
use crate::vault;

#[tauri::command]
pub async fn vault_status(state: State<'_, AppState>) -> Result<&'static str> {
    let initialized = vault::is_initialized(&state.db).await?;
    let unlocked = state.vault.read().await.is_unlocked();
    Ok(match (initialized, unlocked) {
        (false, _)     => "uninitialized",
        (true,  false) => "locked",
        (true,  true)  => "unlocked",
    })
}

#[tauri::command]
pub async fn vault_init(state: State<'_, AppState>, password: String) -> Result<()> {
    if password.len() < 8 {
        return Err(AppError::Validation("master password must be at least 8 chars".into()));
    }
    let new_state = vault::init(&state.db, &password).await?;
    *state.vault.write().await = new_state;
    Ok(())
}

#[tauri::command]
pub async fn vault_unlock(state: State<'_, AppState>, password: String) -> Result<()> {
    let new_state = vault::unlock(&state.db, &password).await?;
    *state.vault.write().await = new_state;
    Ok(())
}

#[tauri::command]
pub async fn vault_lock(state: State<'_, AppState>) -> Result<()> {
    *state.vault.write().await = vault::VaultState::Locked;
    Ok(())
}
```

- [ ] **Step 11.4: Register modules + handlers**

Update `src-tauri/src/commands/mod.rs`:
```rust
pub mod credentials;
pub mod folders;
pub mod sessions;
pub mod settings;
pub mod vault;
```

Extend `invoke_handler!` in `main.rs` with:
```rust
commands::settings::settings_get,
commands::settings::settings_set,
commands::vault::vault_status,
commands::vault::vault_init,
commands::vault::vault_unlock,
commands::vault::vault_lock,
```

Also set vault state from DB at boot so `VaultState` reflects reality. Update the relevant section of `main.rs`:
```rust
    let db_path = resolve_db_path();
    let pool = db::init_pool(&db_path).await.expect("init db");
    let initialized = vault::is_initialized(&pool).await.expect("vault check");
    let initial_state = if initialized { vault::VaultState::Locked } else { vault::VaultState::Uninitialized };
    let app_state = AppState::new(pool);
    *app_state.vault.blocking_write() = initial_state;
```

Note: `blocking_write` is safe at startup before the event loop starts. If lint disallows it, use `tokio::runtime::Handle::current().block_on`.

- [ ] **Step 11.5: Tests**

Append to `src-tauri/src/db/settings.rs`:
```rust
#[cfg(test)]
mod tests {
    use super::*;
    use sqlx::sqlite::SqlitePoolOptions;

    #[tokio::test]
    async fn upsert() {
        let p = SqlitePoolOptions::new().max_connections(1).connect("sqlite::memory:").await.unwrap();
        crate::db::init_pool_from_pool(&p).await.unwrap();
        set(&p, "theme", "dark").await.unwrap();
        assert_eq!(get(&p, "theme").await.unwrap(), Some("dark".into()));
        set(&p, "theme", "light").await.unwrap();
        assert_eq!(get(&p, "theme").await.unwrap(), Some("light".into()));
    }
}
```

- [ ] **Step 11.6: Run all tests + cargo check**

```bash
cargo test --manifest-path src-tauri/Cargo.toml
cargo check --manifest-path src-tauri/Cargo.toml
```
Expected: all pass, no warnings.

- [ ] **Step 11.7: Commit**

```bash
git add src-tauri/
git commit -m "feat(vault+settings): status/init/unlock/lock + k-v settings commands"
```

---

## Task 12: Next.js UI scaffold + Tailwind + theme tokens

**Files:**
- Create: `ui/package.json`
- Create: `ui/tsconfig.json`
- Create: `ui/next.config.mjs`
- Create: `ui/tailwind.config.ts`
- Create: `ui/postcss.config.js`
- Create: `ui/app/layout.tsx`
- Create: `ui/app/page.tsx`
- Create: `ui/app/globals.css`

- [x] **Step 12.1: Write `ui/package.json`**

Path: `/home/mack/dev/ezTerm/ui/package.json`
```json
{
  "name": "ezterm-ui",
  "private": true,
  "version": "0.1.0",
  "type": "module",
  "scripts": {
    "dev": "next dev -p 5173",
    "build": "next build",
    "lint": "next lint",
    "typecheck": "tsc --noEmit"
  },
  "dependencies": {
    "@tauri-apps/api": "^2.0.0",
    "@tauri-apps/plugin-dialog": "^2.0.0",
    "next": "14.2.3",
    "react": "18.3.1",
    "react-dom": "18.3.1",
    "zustand": "4.5.2",
    "clsx": "2.1.1"
  },
  "devDependencies": {
    "@types/node": "20.11.30",
    "@types/react": "18.2.73",
    "@types/react-dom": "18.2.22",
    "autoprefixer": "10.4.19",
    "eslint": "8.57.0",
    "eslint-config-next": "14.2.3",
    "postcss": "8.4.38",
    "tailwindcss": "3.4.3",
    "typescript": "5.4.3"
  }
}
```

- [x] **Step 12.2: Write `ui/next.config.mjs`**

Path: `/home/mack/dev/ezTerm/ui/next.config.mjs`
```js
/** @type {import('next').NextConfig} */
const nextConfig = {
  output: 'export',
  images: { unoptimized: true },
  trailingSlash: true,
};

export default nextConfig;
```

- [x] **Step 12.3: Write `ui/tsconfig.json`**

Path: `/home/mack/dev/ezTerm/ui/tsconfig.json`
```json
{
  "compilerOptions": {
    "target": "ES2022",
    "lib": ["dom", "dom.iterable", "esnext"],
    "allowJs": false,
    "skipLibCheck": true,
    "strict": true,
    "noEmit": true,
    "esModuleInterop": true,
    "module": "esnext",
    "moduleResolution": "bundler",
    "resolveJsonModule": true,
    "isolatedModules": true,
    "jsx": "preserve",
    "incremental": true,
    "baseUrl": ".",
    "paths": { "@/*": ["./*"] },
    "plugins": [{ "name": "next" }]
  },
  "include": ["next-env.d.ts", "**/*.ts", "**/*.tsx", ".next/types/**/*.ts"],
  "exclude": ["node_modules"]
}
```

- [x] **Step 12.4: Write `ui/tailwind.config.ts`** (designer-refined version preserved; satisfies plan intent with expanded palette)

Path: `/home/mack/dev/ezTerm/ui/tailwind.config.ts`
```ts
import type { Config } from 'tailwindcss';

const config: Config = {
  content: ['./app/**/*.{ts,tsx}', './components/**/*.{ts,tsx}'],
  darkMode: 'class',
  theme: {
    extend: {
      colors: {
        bg:        'rgb(var(--bg) / <alpha-value>)',
        surface:   'rgb(var(--surface) / <alpha-value>)',
        surface2:  'rgb(var(--surface-2) / <alpha-value>)',
        border:    'rgb(var(--border) / <alpha-value>)',
        fg:        'rgb(var(--fg) / <alpha-value>)',
        muted:     'rgb(var(--muted) / <alpha-value>)',
        accent:    'rgb(var(--accent) / <alpha-value>)',
      },
      fontFamily: {
        mono: ['Cascadia Mono', 'Consolas', 'ui-monospace', 'monospace'],
      },
    },
  },
  plugins: [],
};
export default config;
```

- [x] **Step 12.5: Write `ui/postcss.config.js`**

Path: `/home/mack/dev/ezTerm/ui/postcss.config.js`
```js
export default {
  plugins: { tailwindcss: {}, autoprefixer: {} },
};
```

- [x] **Step 12.6: Write `ui/app/globals.css`** (designer-refined version preserved; includes `.input`/button component layer)

Path: `/home/mack/dev/ezTerm/ui/app/globals.css`
```css
@tailwind base;
@tailwind components;
@tailwind utilities;

/* Dark theme (default) — MobaXterm-esque near-black with muted accent. */
:root {
  --bg:        18 18 20;
  --surface:   26 26 30;
  --surface-2: 34 34 40;
  --border:    52 52 60;
  --fg:        229 231 235;
  --muted:     148 163 184;
  --accent:    96 165 250;
}
.light {
  --bg:        248 249 251;
  --surface:   255 255 255;
  --surface-2: 241 245 249;
  --border:    209 213 219;
  --fg:        17 24 39;
  --muted:     100 116 139;
  --accent:    37 99 235;
}

html, body, #__next { height: 100%; }
body { @apply bg-bg text-fg font-mono antialiased; }
```

- [x] **Step 12.7: Write `ui/app/layout.tsx`**

Path: `/home/mack/dev/ezTerm/ui/app/layout.tsx`
```tsx
import './globals.css';
import type { ReactNode } from 'react';

export const metadata = { title: 'ezTerm', description: 'SSH client' };

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" className="dark">
      <body>{children}</body>
    </html>
  );
}
```

- [x] **Step 12.8: Temporary placeholder page**

Path: `/home/mack/dev/ezTerm/ui/app/page.tsx`
```tsx
export default function Page() {
  return (
    <main className="h-full flex items-center justify-center text-muted">
      ezTerm loading…
    </main>
  );
}
```

- [x] **Step 12.9: Install deps and build**

```bash
cd /home/mack/dev/ezTerm/ui
npm install
npm run lint
npm run build
```
Expected: `out/` directory is produced. Lint clean.

- [x] **Step 12.10: Commit**

```bash
cd /home/mack/dev/ezTerm
git add ui/
git commit -m "feat(ui): Next.js static export scaffold + Tailwind + theme tokens"
```

---

## Task 13: Typed Tauri bindings + theme helpers

**Files:**
- Create: `ui/lib/types.ts`
- Create: `ui/lib/tauri.ts`
- Create: `ui/lib/theme.ts`

- [x] **Step 13.1: DTOs**

Path: `/home/mack/dev/ezTerm/ui/lib/types.ts`
```ts
export type AuthType = 'password' | 'key' | 'agent';
export type CredentialKind = 'password' | 'private_key' | 'key_passphrase';
export type VaultStatus = 'uninitialized' | 'locked' | 'unlocked';

export interface Folder {
  id: number;
  parent_id: number | null;
  name: string;
  sort: number;
}

export interface Session {
  id: number;
  folder_id: number | null;
  name: string;
  host: string;
  port: number;
  username: string;
  auth_type: AuthType;
  credential_id: number | null;
  color: string | null;
  sort: number;
}

export interface SessionInput {
  folder_id: number | null;
  name: string;
  host: string;
  port: number;
  username: string;
  auth_type: AuthType;
  credential_id: number | null;
  color: string | null;
}

export interface CredentialMeta {
  id: number;
  kind: CredentialKind;
  label: string;
}

export interface AppErrorPayload {
  code: string;
  message: string;
}
```

- [x] **Step 13.2: Tauri invoke wrappers**

Path: `/home/mack/dev/ezTerm/ui/lib/tauri.ts`
```ts
import { invoke } from '@tauri-apps/api/core';
import type {
  Folder, Session, SessionInput, CredentialMeta, CredentialKind, VaultStatus,
} from './types';

export const api = {
  // Vault
  vaultStatus: () => invoke<VaultStatus>('vault_status'),
  vaultInit:   (password: string) => invoke<void>('vault_init', { password }),
  vaultUnlock: (password: string) => invoke<void>('vault_unlock', { password }),
  vaultLock:   () => invoke<void>('vault_lock'),

  // Folders
  folderList:   () => invoke<Folder[]>('folder_list'),
  folderCreate: (parentId: number | null, name: string) =>
    invoke<Folder>('folder_create', { parentId, name }),
  folderRename: (id: number, name: string) => invoke<void>('folder_rename', { id, name }),
  folderDelete: (id: number) => invoke<void>('folder_delete', { id }),
  folderMove:   (id: number, parentId: number | null, sort: number) =>
    invoke<void>('folder_move', { id, parentId, sort }),

  // Sessions
  sessionList:      () => invoke<Session[]>('session_list'),
  sessionGet:       (id: number) => invoke<Session>('session_get', { id }),
  sessionCreate:    (input: SessionInput) => invoke<Session>('session_create', { input }),
  sessionUpdate:    (id: number, input: SessionInput) => invoke<Session>('session_update', { id, input }),
  sessionDelete:    (id: number) => invoke<void>('session_delete', { id }),
  sessionDuplicate: (id: number) => invoke<Session>('session_duplicate', { id }),

  // Credentials
  credentialList:   () => invoke<CredentialMeta[]>('credential_list'),
  credentialCreate: (kind: CredentialKind, label: string, plaintext: string) =>
    invoke<CredentialMeta>('credential_create', { kind, label, plaintext }),
  credentialDelete: (id: number) => invoke<void>('credential_delete', { id }),

  // Settings
  settingsGet: (key: string) => invoke<string | null>('settings_get', { key }),
  settingsSet: (key: string, value: string) => invoke<void>('settings_set', { key, value }),
};
```

- [x] **Step 13.3: Theme helpers**

Path: `/home/mack/dev/ezTerm/ui/lib/theme.ts`
```ts
import { api } from './tauri';

export type Theme = 'dark' | 'light';

export function applyTheme(theme: Theme) {
  const root = document.documentElement;
  root.classList.remove('dark', 'light');
  root.classList.add(theme);
}

export async function loadTheme(): Promise<Theme> {
  try {
    const saved = await api.settingsGet('theme');
    return saved === 'light' ? 'light' : 'dark';
  } catch {
    return 'dark';
  }
}

export async function saveTheme(theme: Theme) {
  await api.settingsSet('theme', theme);
}
```

- [x] **Step 13.4: Typecheck**

```bash
cd /home/mack/dev/ezTerm/ui && npm run typecheck
```
Expected: clean.

- [x] **Step 13.5: Commit**

```bash
cd /home/mack/dev/ezTerm
git add ui/lib/
git commit -m "feat(ui): typed Tauri bindings + theme helpers"
```

---

## Task 14: Unlock screen (first-run set + subsequent unlock)

**Files:**
- Create: `ui/components/unlock-screen.tsx`
- Modify: `ui/app/page.tsx`

- [ ] **Step 14.1: Unlock screen**

Path: `/home/mack/dev/ezTerm/ui/components/unlock-screen.tsx`
```tsx
'use client';
import { useState } from 'react';
import { api } from '@/lib/tauri';
import type { VaultStatus } from '@/lib/types';

interface Props {
  status: Exclude<VaultStatus, 'unlocked'>;
  onUnlocked: () => void;
}

export function UnlockScreen({ status, onUnlocked }: Props) {
  const firstRun = status === 'uninitialized';
  const [pw, setPw] = useState('');
  const [pw2, setPw2] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setErr(null);
    if (firstRun && pw !== pw2) { setErr('Passwords do not match'); return; }
    if (firstRun && pw.length < 8) { setErr('Minimum 8 characters'); return; }
    setBusy(true);
    try {
      if (firstRun) await api.vaultInit(pw);
      else          await api.vaultUnlock(pw);
      onUnlocked();
    } catch (e: any) {
      setErr(e?.message ?? String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="h-full flex items-center justify-center bg-bg text-fg">
      <form onSubmit={submit} className="w-80 space-y-3 p-6 rounded-lg bg-surface border border-border">
        <h1 className="text-xl font-semibold">
          {firstRun ? 'Set master password' : 'Unlock ezTerm'}
        </h1>
        <p className="text-sm text-muted">
          {firstRun
            ? 'This password encrypts your saved credentials. It cannot be recovered.'
            : 'Enter your master password to unlock the credential vault.'}
        </p>
        <input
          type="password" autoFocus
          className="w-full bg-surface2 border border-border rounded px-3 py-2 outline-none focus:border-accent"
          value={pw} onChange={e => setPw(e.target.value)}
          placeholder="Master password"
        />
        {firstRun && (
          <input
            type="password"
            className="w-full bg-surface2 border border-border rounded px-3 py-2 outline-none focus:border-accent"
            value={pw2} onChange={e => setPw2(e.target.value)}
            placeholder="Confirm password"
          />
        )}
        {err && <div className="text-sm text-red-400">{err}</div>}
        <button
          type="submit" disabled={busy}
          className="w-full bg-accent text-white rounded py-2 disabled:opacity-50"
        >
          {firstRun ? 'Create vault' : 'Unlock'}
        </button>
      </form>
    </main>
  );
}
```

- [ ] **Step 14.2: Router in `page.tsx`**

Path: `/home/mack/dev/ezTerm/ui/app/page.tsx`
```tsx
'use client';
import { useEffect, useState } from 'react';
import { api } from '@/lib/tauri';
import type { VaultStatus } from '@/lib/types';
import { applyTheme, loadTheme } from '@/lib/theme';
import { UnlockScreen } from '@/components/unlock-screen';
import { MainShell } from '@/components/main-shell';

export default function Page() {
  const [status, setStatus] = useState<VaultStatus | null>(null);

  useEffect(() => {
    (async () => {
      applyTheme(await loadTheme());
      setStatus(await api.vaultStatus());
    })();
  }, []);

  if (status === null)    return <main className="h-full flex items-center justify-center text-muted">Loading…</main>;
  if (status !== 'unlocked')
    return <UnlockScreen status={status} onUnlocked={async () => setStatus(await api.vaultStatus())} />;
  return <MainShell onLock={async () => { await api.vaultLock(); setStatus('locked'); }} />;
}
```

- [ ] **Step 14.3: Stub `main-shell.tsx`**

Path: `/home/mack/dev/ezTerm/ui/components/main-shell.tsx`
```tsx
'use client';
export function MainShell({ onLock }: { onLock: () => void }) {
  return (
    <main className="h-full flex items-center justify-center text-muted">
      Vault unlocked. UI wired in later tasks.
      <button onClick={onLock} className="ml-4 px-3 py-1 border border-border rounded">Lock</button>
    </main>
  );
}
```

- [ ] **Step 14.4: Typecheck + build**

```bash
cd /home/mack/dev/ezTerm/ui
npm run typecheck && npm run build
```
Expected: clean.

- [ ] **Step 14.5: Smoke test dev app**

```bash
cd /home/mack/dev/ezTerm && cargo tauri dev
```
Manual verification:
- First run shows "Set master password"; create with 8+ char password.
- Window reloads to "Vault unlocked".
- Click **Lock**; screen returns to "Unlock ezTerm".
- Re-enter password; unlocks. Wrong password shows `bad_password` error.

Close the dev app (Ctrl+C in terminal).

- [ ] **Step 14.6: Commit**

```bash
git add ui/
git commit -m "feat(ui): unlock screen + router wiring to vault status"
```

---

## Task 15: Main shell layout (sidebar + tabs area + status bar)

**Files:**
- Modify: `ui/components/main-shell.tsx`
- Create: `ui/components/status-bar.tsx`
- Create: `ui/components/tabs-shell.tsx`
- Create: `ui/components/sessions-sidebar.tsx`

- [ ] **Step 15.1: Main shell skeleton**

Path: `/home/mack/dev/ezTerm/ui/components/main-shell.tsx`
```tsx
'use client';
import { useState } from 'react';
import { SessionsSidebar } from './sessions-sidebar';
import { TabsShell } from './tabs-shell';
import { StatusBar } from './status-bar';

export function MainShell({ onLock }: { onLock: () => void }) {
  const [sidebarWidth, setSidebarWidth] = useState(240);
  return (
    <div className="h-full grid grid-rows-[1fr_auto] bg-bg text-fg">
      <div className="flex min-h-0">
        <aside
          style={{ width: sidebarWidth }}
          className="shrink-0 border-r border-border bg-surface min-h-0 overflow-auto"
        >
          <SessionsSidebar />
        </aside>
        <div className="flex-1 min-w-0 min-h-0">
          <TabsShell />
        </div>
      </div>
      <StatusBar onLock={onLock} />
    </div>
  );
}
```

- [ ] **Step 15.2: Status bar with theme toggle + lock**

Path: `/home/mack/dev/ezTerm/ui/components/status-bar.tsx`
```tsx
'use client';
import { useEffect, useState } from 'react';
import { applyTheme, loadTheme, saveTheme, type Theme } from '@/lib/theme';

export function StatusBar({ onLock }: { onLock: () => void }) {
  const [theme, setTheme] = useState<Theme>('dark');

  useEffect(() => { loadTheme().then(setTheme); }, []);

  async function toggle() {
    const next: Theme = theme === 'dark' ? 'light' : 'dark';
    setTheme(next);
    applyTheme(next);
    await saveTheme(next);
  }

  return (
    <footer className="h-8 border-t border-border bg-surface text-muted text-xs flex items-center px-3 gap-3">
      <span>ezTerm v0.1</span>
      <span className="flex-1" />
      <button onClick={toggle} className="hover:text-fg">
        {theme === 'dark' ? 'Light theme' : 'Dark theme'}
      </button>
      <button onClick={onLock} className="hover:text-fg">Lock</button>
    </footer>
  );
}
```

- [ ] **Step 15.3: Tabs shell placeholder**

Path: `/home/mack/dev/ezTerm/ui/components/tabs-shell.tsx`
```tsx
'use client';
export function TabsShell() {
  return (
    <div className="h-full flex flex-col">
      <div className="h-9 border-b border-border bg-surface text-muted text-xs flex items-center px-3">
        No open tabs — double-click a session to connect (Plan 2).
      </div>
      <div className="flex-1 flex items-center justify-center text-muted">
        Terminal area
      </div>
    </div>
  );
}
```

- [ ] **Step 15.4: Sessions sidebar stub (full tree in next task)**

Path: `/home/mack/dev/ezTerm/ui/components/sessions-sidebar.tsx`
```tsx
'use client';
export function SessionsSidebar() {
  return (
    <div className="p-3 text-sm">
      <div className="text-muted">Sessions</div>
    </div>
  );
}
```

- [ ] **Step 15.5: Typecheck + build**

```bash
cd /home/mack/dev/ezTerm/ui && npm run typecheck && npm run build
```
Expected: clean.

- [ ] **Step 15.6: Commit**

```bash
cd /home/mack/dev/ezTerm
git add ui/
git commit -m "feat(ui): main shell layout + status bar + theme toggle"
```

---

## Task 16: Sessions sidebar (tree with folders + sessions)

**Files:**
- Modify: `ui/components/sessions-sidebar.tsx`
- Create: `ui/components/context-menu.tsx`

- [ ] **Step 16.1: Reusable context menu**

Path: `/home/mack/dev/ezTerm/ui/components/context-menu.tsx`
```tsx
'use client';
import { useEffect, useRef } from 'react';

export interface MenuItem { label: string; onClick: () => void; disabled?: boolean; danger?: boolean; }

export function ContextMenu({
  x, y, items, onClose,
}: { x: number; y: number; items: MenuItem[]; onClose: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const h = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) onClose(); };
    const k = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('mousedown', h);
    document.addEventListener('keydown', k);
    return () => { document.removeEventListener('mousedown', h); document.removeEventListener('keydown', k); };
  }, [onClose]);

  return (
    <div
      ref={ref}
      style={{ top: y, left: x }}
      className="fixed z-50 min-w-[180px] rounded border border-border bg-surface2 shadow-lg py-1 text-sm"
    >
      {items.map((it, i) => (
        <button
          key={i}
          disabled={it.disabled}
          onClick={() => { it.onClick(); onClose(); }}
          className={`block w-full text-left px-3 py-1 hover:bg-surface disabled:opacity-40 disabled:hover:bg-transparent ${it.danger ? 'text-red-400' : ''}`}
        >
          {it.label}
        </button>
      ))}
    </div>
  );
}
```

- [ ] **Step 16.2: Sidebar implementation**

Path: `/home/mack/dev/ezTerm/ui/components/sessions-sidebar.tsx`
```tsx
'use client';
import { useEffect, useMemo, useState } from 'react';
import { api } from '@/lib/tauri';
import type { Folder, Session } from '@/lib/types';
import { ContextMenu, type MenuItem } from './context-menu';
import { SessionDialog } from './session-dialog';

interface TreeNode {
  folder: Folder | null; // null = root
  folders: TreeNode[];
  sessions: Session[];
}

function buildTree(folders: Folder[], sessions: Session[]): TreeNode {
  const byParent = new Map<number | null, Folder[]>();
  for (const f of folders) {
    const k = f.parent_id;
    if (!byParent.has(k)) byParent.set(k, []);
    byParent.get(k)!.push(f);
  }
  const sessByFolder = new Map<number | null, Session[]>();
  for (const s of sessions) {
    if (!sessByFolder.has(s.folder_id)) sessByFolder.set(s.folder_id, []);
    sessByFolder.get(s.folder_id)!.push(s);
  }
  function build(parent: Folder | null): TreeNode {
    const pid = parent ? parent.id : null;
    return {
      folder: parent,
      folders: (byParent.get(pid) ?? []).map(f => build(f)),
      sessions: sessByFolder.get(pid) ?? [],
    };
  }
  return build(null);
}

export function SessionsSidebar() {
  const [folders, setFolders] = useState<Folder[]>([]);
  const [sessions, setSessions] = useState<Session[]>([]);
  const [menu, setMenu] = useState<{ x: number; y: number; items: MenuItem[] } | null>(null);
  const [dialog, setDialog] = useState<{ mode: 'create'; folderId: number | null } | { mode: 'edit'; session: Session } | null>(null);

  async function reload() {
    const [f, s] = await Promise.all([api.folderList(), api.sessionList()]);
    setFolders(f); setSessions(s);
  }
  useEffect(() => { reload(); }, []);

  const tree = useMemo(() => buildTree(folders, sessions), [folders, sessions]);

  async function newFolder(parentId: number | null) {
    const name = prompt('Folder name');
    if (name) { await api.folderCreate(parentId, name); reload(); }
  }

  function openFolderMenu(e: React.MouseEvent, f: Folder | null) {
    e.preventDefault();
    const id = f?.id ?? null;
    const items: MenuItem[] = [
      { label: 'New Session', onClick: () => setDialog({ mode: 'create', folderId: id }) },
      { label: 'New Folder',  onClick: () => newFolder(id) },
    ];
    if (f) {
      items.push(
        { label: 'Rename', onClick: async () => { const n = prompt('Rename', f.name); if (n) { await api.folderRename(f.id, n); reload(); } } },
        { label: 'Delete', danger: true, onClick: async () => { if (confirm(`Delete "${f.name}" and all children?`)) { await api.folderDelete(f.id); reload(); } } },
      );
    }
    setMenu({ x: e.clientX, y: e.clientY, items });
  }

  function openSessionMenu(e: React.MouseEvent, s: Session) {
    e.preventDefault();
    setMenu({
      x: e.clientX, y: e.clientY,
      items: [
        { label: 'Connect',   disabled: true, onClick: () => {/* Plan 2 */} },
        { label: 'Edit',      onClick: () => setDialog({ mode: 'edit', session: s }) },
        { label: 'Duplicate', onClick: async () => { await api.sessionDuplicate(s.id); reload(); } },
        { label: 'Delete', danger: true, onClick: async () => { if (confirm(`Delete "${s.name}"?`)) { await api.sessionDelete(s.id); reload(); } } },
      ],
    });
  }

  function NodeView({ node, depth }: { node: TreeNode; depth: number }) {
    return (
      <div>
        {node.folder && (
          <div
            onContextMenu={e => openFolderMenu(e, node.folder!)}
            className="px-2 py-1 text-muted hover:bg-surface2 cursor-default"
            style={{ paddingLeft: 8 + depth * 10 }}
          >
            ▸ {node.folder.name}
          </div>
        )}
        {node.sessions.map(s => (
          <div
            key={s.id}
            onContextMenu={e => openSessionMenu(e, s)}
            onDoubleClick={() => {/* Plan 2: connect */}}
            className="px-2 py-1 hover:bg-surface2 cursor-default truncate"
            style={{ paddingLeft: 8 + (depth + 1) * 10 }}
          >
            {s.color && <span style={{ color: s.color }}>● </span>}
            {s.name} <span className="text-muted text-xs">{s.username}@{s.host}</span>
          </div>
        ))}
        {node.folders.map(child => <NodeView key={child.folder!.id} node={child} depth={depth + 1} />)}
      </div>
    );
  }

  return (
    <div className="h-full flex flex-col" onContextMenu={e => { if (e.target === e.currentTarget) openFolderMenu(e, null); }}>
      <div className="px-3 py-2 text-xs uppercase tracking-wider text-muted border-b border-border">Sessions</div>
      <div className="flex-1 overflow-auto py-1">
        <NodeView node={tree} depth={0} />
      </div>
      <button
        onClick={() => setDialog({ mode: 'create', folderId: null })}
        className="m-2 px-3 py-1.5 rounded bg-accent text-white text-sm"
      >
        + New Session
      </button>
      {menu && <ContextMenu {...menu} onClose={() => setMenu(null)} />}
      {dialog && (
        <SessionDialog
          {...(dialog.mode === 'create'
            ? { mode: 'create' as const, folderId: dialog.folderId }
            : { mode: 'edit' as const, session: dialog.session })}
          folders={folders}
          onClose={() => setDialog(null)}
          onSaved={() => { setDialog(null); reload(); }}
        />
      )}
    </div>
  );
}
```

- [ ] **Step 16.3: Typecheck (will fail until Task 17 adds SessionDialog)**

Run: `cd ui && npm run typecheck`
Expected: unresolved import for `./session-dialog`. That is addressed next.

- [ ] **Step 16.4: Stage progress without commit**

Leave uncommitted until Task 17 passes; avoids a broken commit.

---

## Task 17: Session dialog + credential picker

**Files:**
- Create: `ui/components/session-dialog.tsx`
- Create: `ui/components/credential-picker.tsx`

- [ ] **Step 17.1: Credential picker modal**

Path: `/home/mack/dev/ezTerm/ui/components/credential-picker.tsx`
```tsx
'use client';
import { useEffect, useState } from 'react';
import { api } from '@/lib/tauri';
import type { CredentialKind, CredentialMeta } from '@/lib/types';

interface Props {
  kind: CredentialKind;
  value: number | null;
  onChange: (id: number | null) => void;
}

export function CredentialPicker({ kind, value, onChange }: Props) {
  const [list, setList] = useState<CredentialMeta[]>([]);
  const [adding, setAdding] = useState(false);
  const [label, setLabel] = useState('');
  const [secret, setSecret] = useState('');

  async function reload() {
    const all = await api.credentialList();
    setList(all.filter(c => c.kind === kind));
  }
  useEffect(() => { reload(); }, [kind]);

  async function create() {
    if (!label.trim() || !secret) return;
    const created = await api.credentialCreate(kind, label.trim(), secret);
    setSecret(''); setLabel(''); setAdding(false);
    await reload();
    onChange(created.id);
  }

  return (
    <div className="space-y-2">
      <select
        className="w-full bg-surface2 border border-border rounded px-2 py-1.5"
        value={value ?? ''}
        onChange={e => onChange(e.target.value ? Number(e.target.value) : null)}
      >
        <option value="">— choose —</option>
        {list.map(c => <option key={c.id} value={c.id}>{c.label}</option>)}
      </select>
      {!adding && (
        <button type="button" onClick={() => setAdding(true)} className="text-xs text-accent">
          + Add new credential
        </button>
      )}
      {adding && (
        <div className="space-y-2 border border-border rounded p-2 bg-surface2">
          <input
            className="w-full bg-surface border border-border rounded px-2 py-1 text-sm"
            placeholder="Label" value={label} onChange={e => setLabel(e.target.value)}
          />
          <textarea
            className="w-full bg-surface border border-border rounded px-2 py-1 text-sm font-mono"
            rows={kind === 'private_key' ? 6 : 1}
            placeholder={kind === 'private_key' ? '-----BEGIN PRIVATE KEY-----' : 'secret'}
            value={secret} onChange={e => setSecret(e.target.value)}
          />
          <div className="flex gap-2 justify-end">
            <button type="button" onClick={() => { setAdding(false); setSecret(''); }} className="px-2 py-1 text-xs">Cancel</button>
            <button type="button" onClick={create} className="px-2 py-1 text-xs bg-accent text-white rounded">Save</button>
          </div>
        </div>
      )}
    </div>
  );
}
```

- [ ] **Step 17.2: Session dialog**

Path: `/home/mack/dev/ezTerm/ui/components/session-dialog.tsx`
```tsx
'use client';
import { useEffect, useMemo, useState } from 'react';
import { api } from '@/lib/tauri';
import type { AuthType, Folder, Session, SessionInput } from '@/lib/types';
import { CredentialPicker } from './credential-picker';

type Mode =
  | { mode: 'create'; folderId: number | null }
  | { mode: 'edit';   session: Session };

interface Props extends Mode {
  folders: Folder[];
  onClose: () => void;
  onSaved: () => void;
}

export function SessionDialog(props: Props) {
  const initial: SessionInput = useMemo(() => {
    if (props.mode === 'edit') {
      const { id: _i, sort: _s, ...rest } = props.session;
      return rest;
    }
    return {
      folder_id: props.folderId,
      name: '',
      host: '',
      port: 22,
      username: '',
      auth_type: 'agent',
      credential_id: null,
      color: null,
    };
  }, [props]);

  const [v, setV] = useState<SessionInput>(initial);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => { setV(initial); }, [initial]);

  const credKind =
    v.auth_type === 'password' ? 'password' :
    v.auth_type === 'key'      ? 'private_key' : null;

  async function save(e: React.FormEvent) {
    e.preventDefault();
    setErr(null); setBusy(true);
    try {
      if (props.mode === 'edit') await api.sessionUpdate(props.session.id, v);
      else                       await api.sessionCreate(v);
      props.onSaved();
    } catch (e: any) {
      setErr(e?.message ?? String(e));
    } finally { setBusy(false); }
  }

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-40">
      <form onSubmit={save} className="w-[480px] bg-surface border border-border rounded p-4 space-y-3 text-sm">
        <h2 className="text-base font-semibold">
          {props.mode === 'edit' ? 'Edit session' : 'New session'}
        </h2>
        <Field label="Name">
          <input value={v.name} onChange={e => setV({ ...v, name: e.target.value })} className="input"/>
        </Field>
        <Field label="Folder">
          <select
            value={v.folder_id ?? ''}
            onChange={e => setV({ ...v, folder_id: e.target.value ? Number(e.target.value) : null })}
            className="input"
          >
            <option value="">(root)</option>
            {props.folders.map(f => <option key={f.id} value={f.id}>{f.name}</option>)}
          </select>
        </Field>
        <div className="grid grid-cols-[1fr_100px] gap-2">
          <Field label="Host">
            <input value={v.host} onChange={e => setV({ ...v, host: e.target.value })} className="input"/>
          </Field>
          <Field label="Port">
            <input type="number" min={1} max={65535} value={v.port}
              onChange={e => setV({ ...v, port: Number(e.target.value) })} className="input"/>
          </Field>
        </div>
        <Field label="Username">
          <input value={v.username} onChange={e => setV({ ...v, username: e.target.value })} className="input"/>
        </Field>
        <Field label="Auth">
          <select
            value={v.auth_type}
            onChange={e => setV({ ...v, auth_type: e.target.value as AuthType, credential_id: null })}
            className="input"
          >
            <option value="agent">SSH agent</option>
            <option value="password">Password</option>
            <option value="key">Private key</option>
          </select>
        </Field>
        {credKind && (
          <Field label="Credential">
            <CredentialPicker kind={credKind} value={v.credential_id} onChange={id => setV({ ...v, credential_id: id })}/>
          </Field>
        )}
        <Field label="Tab color (optional)">
          <input type="color" value={v.color ?? '#60a5fa'}
            onChange={e => setV({ ...v, color: e.target.value })} className="w-12 h-7 p-0 border-0 bg-transparent"/>
        </Field>
        {err && <div className="text-red-400">{err}</div>}
        <div className="flex justify-end gap-2 pt-2">
          <button type="button" onClick={props.onClose} className="px-3 py-1.5 border border-border rounded">Cancel</button>
          <button type="submit" disabled={busy} className="px-3 py-1.5 bg-accent text-white rounded disabled:opacity-50">
            {props.mode === 'edit' ? 'Save' : 'Create'}
          </button>
        </div>
      </form>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block space-y-1">
      <span className="text-muted text-xs">{label}</span>
      {children}
    </label>
  );
}
```

- [ ] **Step 17.3: Add shared input class**

Append to `ui/app/globals.css`:
```css
@layer components {
  .input {
    @apply w-full bg-surface2 border border-border rounded px-2 py-1.5 outline-none focus:border-accent;
  }
}
```

- [ ] **Step 17.4: Typecheck + build**

```bash
cd /home/mack/dev/ezTerm/ui && npm run typecheck && npm run build
```
Expected: clean.

- [ ] **Step 17.5: Smoke test**

```bash
cd /home/mack/dev/ezTerm && cargo tauri dev
```
Manual verification:
- Right-click sidebar → New Folder; create "prod".
- Right-click on "prod" → New Session; fill name/host/user, choose **Password** auth, add credential inline.
- Session shows in tree. Edit/Duplicate/Delete all work.
- Theme toggle in status bar swaps dark/light instantly and persists across restart.
- Lock → unlock round-trips.

Close dev app.

- [ ] **Step 17.6: Commit**

```bash
git add ui/
git commit -m "feat(ui): sessions sidebar tree + session dialog + credential picker"
```

---

## Task 18: README quickstart update

**Files:**
- Modify: `README.md`

- [ ] **Step 18.1: Write README**

Path: `/home/mack/dev/ezTerm/README.md`
```markdown
# ezTerm

Free, open-source Windows SSH client with a MobaXterm-style session manager, encrypted credential vault, and xterm-compatible terminal.

**Status:** Pre-alpha. Plan 1 of 3 implemented (scaffold + vault + session manager). SSH and SFTP land in Plans 2 and 3.

## Dev quickstart

```bash
# one-time
cargo install tauri-cli --version '^2.0' --locked
cargo install sqlx-cli --no-default-features --features sqlite --locked
cp .env.example .env

# frontend install
npm --prefix ui install

# run
cargo tauri dev
```

Tests:

```bash
cargo test --manifest-path src-tauri/Cargo.toml
npm --prefix ui run typecheck
npm --prefix ui run lint
```

Ship build (Windows):

```bash
cargo tauri build
```
```

- [ ] **Step 18.2: Commit**

```bash
git add README.md
git commit -m "docs: dev quickstart"
```

---

## Task 19: Full regression + release tag

- [ ] **Step 19.1: Full Rust test + lint**

```bash
cargo check --manifest-path src-tauri/Cargo.toml
cargo test  --manifest-path src-tauri/Cargo.toml
cargo clippy --manifest-path src-tauri/Cargo.toml -- -D warnings
```
Expected: all green, no warnings.

- [ ] **Step 19.2: Full frontend check**

```bash
npm --prefix ui run typecheck
npm --prefix ui run lint
npm --prefix ui run build
```
Expected: all green.

- [ ] **Step 19.3: Verify Cargo.toml version matches milestone**

Version must be `0.1.0` for the Plan-1 milestone. Bump only if later tasks added features (patch=fixes, minor=features, major=breaking).

- [ ] **Step 19.4: Tag**

```bash
git tag -a v0.1.0-foundation -m "Plan 1: scaffold + vault + session manager"
```

- [ ] **Step 19.5: Push**

```bash
git push origin main --tags
```

---

## Self-Review Notes

**Spec coverage** (spec §/requirement → task):

- §2 stack → Task 1 (Tauri/Rust), Task 12 (Next.js/Tailwind)
- §3 architecture → Tasks 1–17 collectively
- §4.1 window layout → Task 15
- §4.3 theme dark-default + toggle → Tasks 12, 15 (globals.css + status bar)
- §4.5 connection dialog → Task 17
- §5 data model → Task 3 (migration)
- §6.1 master password / vault → Tasks 5, 6, 7
- §6.2 credentials, no plaintext to frontend → Task 9 (deliberate omission of `credential_get_plaintext`)
- §6.3 known hosts — schema in Task 3, TOFU logic deferred to Plan 2 (flagged)
- §7 command surface — vault/folder/session/credential/settings delivered here; ssh/sftp/scp/known_host commands deferred to Plans 2/3
- §8 project layout → Tasks 1, 12
- §10 testing strategy — Rust unit tests on vault/DB across Tasks 5–11; frontend unit tests deferred (no logic-heavy reducers yet; revisit in Plan 2 when tab store lands)

**Items deferred to Plan 2:**
- `ssh_connect`, `ssh_write`, `ssh_resize`, `ssh_disconnect` and terminal events
- Known-hosts TOFU prompt + `known_host_list`/`known_host_remove`
- xterm.js embed + right-click menu + Shift+Insert + Ctrl+Shift+C/V/F

**Items deferred to Plan 3:**
- All SFTP commands and side-pane UI
- SCP commands + drag-drop

**Placeholder scan:** none remain. Every code step has real code; every test step has real commands.

**Type consistency:** `SessionInput`, `Session`, `Folder`, `CredentialMeta`, and `VaultStatus` names match between Rust structs (Tasks 8–11) and TypeScript DTOs (Task 13). Tauri command parameter names (`parentId`, `id`, `input`, `password`, `kind`, `label`, `plaintext`, `key`, `value`) are snake_case in Rust (`parent_id`, etc.) and converted to camelCase by Tauri's default argument remapping — the invoke wrappers in Task 13 pass camelCase as required.

---

## Execution Handoff

**Plan complete and saved to `docs/superpowers/plans/2026-04-18-plan-1-foundation.md`.** Two execution options:

**1. Subagent-Driven (recommended)** — fresh subagent per task, two-stage review between tasks. Matches the user's "launch a senior Rust dev agent" instruction but lets the orchestrator keep quality gates tight.

**2. Inline Execution** — execute tasks in the current session via `superpowers:executing-plans` with checkpoint reviews. Faster, less process overhead.

**Plans 2 (SSH + Terminal) and 3 (SFTP + SCP) get written after Plan 1 lands**, so the designs can reflect anything we learn during Plan 1 implementation.
