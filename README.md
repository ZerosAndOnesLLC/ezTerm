# ezTerm

Free, open-source Windows SSH client with a MobaXterm-style session manager, encrypted credential vault, and xterm-compatible terminal.

**Status:** Pre-alpha. Plan 1 tagged at `v0.1.0-foundation` (scaffold + vault + session manager). Plan 2 (SSH + terminal) is next; SFTP follows in Plan 3.

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

## v0.2 — SSH + Terminal

Plan 2 adds the core SSH experience:
- russh-backed connections to any saved session (password / private key / SSH agent)
- xterm.js terminal with Copy (Ctrl+Shift+C), Paste (Ctrl+Shift+V), Shift+Insert, Select All, Clear Scrollback, Find (Ctrl+Shift+F)
- Right-click terminal context menu
- Host-key TOFU prompt on first connect; hard-fail on mismatch unless the user explicitly replaces
- Real tab bar (middle-click to close)

Next: Plan 3 adds SFTP side-pane and SCP drag-drop.
