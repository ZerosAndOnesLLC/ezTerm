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

# run — IMPORTANT: use cargo tauri dev, not cargo run
cargo tauri dev
```

> **Heads up:** `cargo run` will fail with `frontendDist "../ui/out" doesn't exist`
> because `ui/out/` is a build artifact (gitignored). Use `cargo tauri dev` — it
> runs the frontend dev server automatically via `beforeDevCommand`. If you
> really want to use `cargo run`, build the UI first:
> `npm --prefix ui run build && cargo run` (Windows `cmd`: same commands).

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

## v0.3 — SFTP side-pane + SCP

Plan 3 completes the v0.1 feature set:
- Left-docked SFTP file browser in each tab — auto-opens on successful SSH connect
- Breadcrumb navigation, double-click into directories
- Context menu: Download…, Rename, Delete
- Drag-drop upload from the OS file explorer (with native-dialog fallback when the webview doesn't expose the dropped path)
- 32 KiB streaming chunks with per-transfer progress events
- `scp_upload` / `scp_download` command surface present as stubs — routes through SFTP for now; real SCP-protocol support is a follow-up

ezTerm v0.1 milestone is now feature-complete. See GH issues for backlog (X11 forwarding, port forwarding, jump hosts, true SCP, transfer cancel).
