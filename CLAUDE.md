# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project

ezTerm is a free, open-source Windows SSH client that should **look and feel like MobaXterm**. Upstream repo: `github.com/ZerosAndOnesLLC/ezTerm`. Target feature set for v0.1: connection/session manager, encrypted credential vault ("locker"), SSH, SFTP, SCP, and an xterm-compatible terminal.

## UX Requirements (non-negotiable for v0.1)

- Layout mirrors MobaXterm: left **Sessions** sidebar (folders + saved sessions), main tabbed terminal area, optional **SFTP side-pane** docked on the left of the active tab.
- **Dark mode by default**, with a light theme toggle. Theme persists per user.
- **Terminal context menu** (right-click): Copy, Paste, Select All, Clear, Find.
- **Shift+Insert** pastes from clipboard into the terminal (MobaXterm / xterm convention).
- Selection-to-copy on mouse release is optional (setting, off by default) to avoid surprising new users.

## Stack

- **Shell**: [Tauri v2](https://tauri.app/) — Rust backend, webview frontend
- **Frontend**: Next.js (static export into Tauri assets) + [xterm.js](https://xtermjs.org/) with `fit`, `web-links`, and `search` addons
- **SSH / SFTP**: [`russh`](https://crates.io/crates/russh) + [`russh-sftp`](https://crates.io/crates/russh-sftp) (pure-Rust, tokio-based)
- **Persistence**: SQLite via [`sqlx`](https://crates.io/crates/sqlx) — sessions, folders, known_hosts, encrypted credential blobs
- **Crypto**: `argon2` (KDF from master password) + `chacha20poly1305` (AEAD for vault blobs); secrets wrapped in `zeroize`

## Planned Layout

```
ezTerm/
├── src-tauri/     # Rust: Tauri commands, SSH/SFTP, vault, DB
├── ui/            # Next.js app (static export)
├── migrations/    # sqlx migrations
└── Cargo.toml
```

## Architecture Notes

- **Command boundary**: All SSH/SFTP/vault operations live in Rust; the webview calls them via Tauri commands. The frontend is a dumb renderer plus UI state — no protocol logic in TypeScript.
- **Terminal data path**: Rust opens the SSH shell channel; bytes flow to the frontend via Tauri events (`ssh:data`, `ssh:close`), keystrokes flow back through a Tauri command. xterm.js only renders and captures input.
- **SFTP pane follows the session** (MobaXterm-style): when a tab connects, an optional side pane opens an SFTP subsystem on the *same* connection — no second auth.
- **Vault**: master password unlocks the app. Argon2id derives the vault key; credentials are stored as `(nonce, ciphertext)` rows. Plaintext secrets exist only in memory during use and are zeroized on drop. Never log, serialize, or return plaintext credentials to the frontend except as ephemeral auth material.
- **Known hosts**: TOFU on first connect; mismatch is a hard failure. Stored in SQLite, not `~/.ssh/known_hosts`.

## Commands

No code has been scaffolded yet. Once `src-tauri/` and `ui/` exist, the expected workflow is:

- `cargo check` — must pass before every commit (see global rules)
- `cd src-tauri && cargo test` — Rust unit/integration tests
- `cd ui && npm run lint` — frontend lint (fix properly, no ignores)
- `cargo tauri dev` — run the app in dev mode
- `cargo tauri build` — produce a Windows installer
- `sqlx migrate add <name>` — create migration (use `date` for correct timestamp naming)
- `sqlx migrate run` — apply migrations (DATABASE_URL from `.env`)

Update this section once the actual scripts land.

## Conventions

- Bump `Cargo.toml` version before each commit (major=breaking, minor=features, patch=fixes).
- Fix warnings properly — remove unused code, don't `#[allow(...)]` past them.
- Async everywhere (tokio); no blocking calls on the Tauri command thread.
- Read struct definitions before writing code that uses them.

## Out of Scope for v0.1

Port forwarding, jump hosts / ProxyJump, X11 server, RDP / Telnet / Serial, macros, session recording, split panes, and theming beyond a default dark/light pair. Don't add these without an explicit design update.
