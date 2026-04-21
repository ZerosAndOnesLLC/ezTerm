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

## v0.4 — Passphrase-protected keys + inline connect errors

- Session dialog gained a **Key passphrase (optional)** credential picker when
  **Auth = Private key**. The passphrase is stored as its own encrypted
  credential (kind `key_passphrase`) so one saved passphrase can be reused
  across multiple sessions that share the same private key.
- SSH connect errors (auth failure, key parse, host-key issues, etc.) are now
  rendered directly into the terminal tab as `[Error] …` instead of only a
  silent red `!` indicator.

## v0.7 — MobaXterm import + font-size wheel zoom

- **Import from MobaXterm** — sidebar toolbar gains an import button and the
  root right-click menu gets an "Import from MobaXterm…" entry. Point at a
  `.mxtsessions` export or `MobaXterm.ini`; the preview dialog shows session
  counts, the folder hierarchy that will be recreated, and a per-duplicate
  strategy picker (**skip** / **overwrite** host-port-user / **rename** with
  an `(imported)` suffix). Non-SSH rows (RDP, VNC, Telnet, …) are counted and
  left behind — v0.7 is SSH-only by design. Imported sessions land with
  `auth=agent`; attach vault credentials after import.
- **Ctrl + mouse wheel** inside a terminal tab zooms the font size in/out,
  clamped to the same 8–48 range the session dialog enforces. The SSH channel
  is resized on every change so the remote program sees the new grid
  immediately.

## v0.6 — Visual polish pass

- **Lucide icons** everywhere — sidebar, tab bar, SFTP header, find overlay,
  status bar, dialog close. Replaces the Unicode-glyph placeholders.
- **Status bar** now shows active-session `user@host`, SFTP cwd, icon-only
  theme + lock buttons at 24px.
- **Sidebar** rows are 24px with folder/session icons, selection state,
  collapsible folders (`▸`/`▾`), and a 2px success rail on currently
  connected sessions. New sessions / folders use icon-only toolbar buttons;
  native `window.prompt` / `window.confirm` replaced with in-app dialogs
  that match the app chrome.
- **Tab bar** is 32px with underline-on-active, coloured status dots
  (pulse on connecting), and always-visible close on the active tab.
- **Terminal connection overlay** — centered card for `Connecting…`,
  `Connection failed` with Reconnect, and `Disconnected` with Reconnect.
  The old ANSI `[Error]` line is gone; the overlay + tab dot + status bar
  carry the signal.
- **Toast region** (bottom-right, 4s auto-dismiss) for all create /
  rename / delete confirmations.
- **SFTP pane** widened to 288px, real icons per row (folder/file/
  symlink with color), full-pane drop-zone overlay when dragging files in.
- **Find overlay** upgraded to proper icon-buttons, match count
  (`3 / 12`), case-sensitive / regex toggles.
- **Host-key dialog** uses semantic danger / warning tokens instead of raw
  Tailwind reds, plus a shield icon reflecting threat level.
- **Unlock screen** — strength meter (4-bar heuristic), show/hide toggle,
  card-style layout with an app glyph.
- **Focus rings** unified under a single `.focus-ring` utility for
  consistency across every interactive element.
- New dependency: `lucide-react` (MIT).

## v0.5 — Redesigned session dialog + per-session settings

MobaXterm-style edit dialog with three tabs (General / Terminal / Advanced)
and a live `user@host:port` summary strip. Dialog is wider, keyboard-friendly
(`Esc` closes, `Ctrl+Enter` saves), and credential-picker buttons are now real
buttons instead of tiny text links.

New per-session settings (all persisted in `sessions`):

- **Initial command** — written into the shell as keystrokes after connect.
- **Scrollback lines** / **Font size** / **Cursor style** (block / bar /
  underline) — applied to xterm when the tab opens.
- **Environment variables** — list of `KEY=VALUE` pairs sent via SSH
  `env` requests at channel-open time (subject to the server's `AcceptEnv`).
- **Connect timeout** — bounds the whole SSH handshake, mapped to a distinct
  `connect timeout` error in the UI.
- **Keepalive (seconds)** — drives russh's `keepalive_interval`; `0`
  disables.
- **SSH compression** — toggles zlib/zlib@openssh.com in the russh preferred
  algorithm list.

## v0.3 — SFTP side-pane + SCP

Plan 3 completes the v0.1 feature set:
- Left-docked SFTP file browser in each tab — auto-opens on successful SSH connect
- Breadcrumb navigation, double-click into directories
- Context menu: Download…, Rename, Delete
- Drag-drop upload from the OS file explorer (with native-dialog fallback when the webview doesn't expose the dropped path)
- 32 KiB streaming chunks with per-transfer progress events
- `scp_upload` / `scp_download` command surface present as stubs — routes through SFTP for now; real SCP-protocol support is a follow-up

ezTerm v0.1 milestone is now feature-complete. See GH issues for backlog (X11 forwarding, port forwarding, jump hosts, true SCP, transfer cancel).
