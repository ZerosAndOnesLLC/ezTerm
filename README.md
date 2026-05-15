# ezTerm

A free, open-source Windows SSH client with a MobaXterm-style session manager,
encrypted credential vault, xterm-compatible terminal, SFTP side-pane, WSL and
local-shell tabs, and X11 forwarding.

**Status:** pre-release. v0.11.0 is the first tagged build with the full SSH +
WSL + X11 feature set. Windows-first; Linux and macOS binaries are produced by
the release pipeline but only the SSH / SFTP / terminal features are meaningful
on those platforms.

**Licence:** GNU General Public License, version 3 — see [LICENSE](LICENSE).

## Features

### Connections
- **SSH** over [russh](https://crates.io/crates/russh) with password, private
  key, or SSH-agent auth. Host-key TOFU on first connect; hard-fail on mismatch.
- **WSL** tabs — `wsl.exe -d <distro> [-u <user>]` under a ConPTY. `code .`,
  `explorer.exe`, and the rest of WSL interop Just Works.
- **Local shells** — `cmd`, `powershell`, `pwsh`, or any absolute path, with an
  optional starting directory.
- **X11 forwarding** against bundled [VcXsrv](https://sourceforge.net/projects/vcxsrv/) —
  tick "Forward X11" on an SSH session and remote GUI apps (`xeyes`, `gedit`,
  JetBrains tools, …) pop as native Windows windows. The Windows release
  tarball ships VcXsrv in a `vcxsrv/` subfolder so no separate install is
  needed.
- **MobaXterm import** — point at a `.mxtsessions` export or `MobaXterm.ini` and
  import SSH + WSL rows with their folder structure. Private-key files are read
  off disk and stored as encrypted vault credentials, auto-attached to the
  matching sessions.

### Terminal
- xterm.js with **full 16-colour + 256-colour + 24-bit truecolor** support
  (remote sees `TERM=xterm-256color`).
- Copy / Paste (`Ctrl+Shift+C` / `Ctrl+Shift+V` / `Shift+Insert`), Select All,
  Clear Scrollback, Find (`Ctrl+Shift+F`) with case-sensitive / regex toggles.
- **Ctrl + mouse wheel** zoom (8–48 pt, SSH channel resized on every step).
- Per-session font size, scrollback depth, cursor style, env vars, keepalive,
  connect timeout, initial command, compression.

### Workspace
- **Sessions sidebar** — folders + drag-and-drop (sessions into folders, folders
  into folders, drop on the tree background to root). Folder session-count
  badges, coloured icons per folder, green-glow rail for the currently connected
  row. Resizable with a grab-strip on the right edge (180 – 520 px, persisted).
- **Tab bar** with coloured status dots (pulse on connecting, green on
  connected, red on error), middle-click to close, per-tab SFTP toggle.
- **SFTP side-pane** docked on the active SSH tab — breadcrumb navigation,
  right-click context menu (Download, Rename, Delete), drag-drop upload from
  Explorer with streaming 32 KiB chunks and live progress.
- **Inline auth-fix overlay** — when a connect fails with bad auth / missing
  credential, a dedicated overlay lets the user fix username, auth method, or
  vault credential without leaving the tab. No "close tab and start over" ritual.
- **Status bar** — active-session `user@host`, SFTP cwd, X-server pill,
  theme + lock buttons.
- **Toasts** for create / rename / delete / import events.
- Dark by default with a light theme toggle; theme persists per user.

### Security
- **Vault** — Argon2id KDF → ChaCha20-Poly1305 AEAD for every stored secret.
  Master password unlocks the app; secrets live encrypted at rest in SQLite and
  are zeroised in memory after use.
- **Credentials** — passwords, private keys, and key passphrases are three
  distinct kinds so a single stored passphrase can back multiple sessions.
- **Known hosts** — stored in SQLite, not `~/.ssh/known_hosts`. Mismatch is a
  hard fail unless the user explicitly trusts the new fingerprint.
- **Redacted logging** — host / user / fingerprint are the only identifiers
  that appear in traces; secrets never touch logs.

## Website

Project site: <https://ezterm.zerosandones.us/> — landing page, docs,
screenshots, and changelog. Source lives in [`site/`](site/).

Develop locally:

```bash
npm --prefix site install     # one-time
npm --prefix site run dev     # http://localhost:4321/
npm --prefix site run build   # → site/dist/
```

The site auto-deploys on every push to `main` that touches `site/**` or
`docs/release-notes/**` (see `.github/workflows/site.yml`).

## Install

Pre-built binaries live on the
[Releases](https://github.com/ZerosAndOnesLLC/ezTerm/releases) page — one
`tar.xz` per platform:

| Platform | Archive |
|---|---|
| Windows x86_64 | `ezterm-windows-x86_64.tar.xz` |
| Linux x86_64 | `ezterm-linux-x86_64.tar.xz` |
| Linux aarch64 | `ezterm-linux-aarch64.tar.xz` |
| macOS aarch64 | `ezterm-macos-aarch64.tar.xz` |

Extract, run the `ezterm` / `ezterm.exe` binary. No install step required — the
UI is embedded in the executable.

**Runtime dependencies:**
- **Windows** — the release tarball bundles VcXsrv in a `vcxsrv/` subfolder
  next to `ezterm.exe`, so X11 forwarding works out of the box. If you'd
  rather use a system install, delete the bundled folder and install
  [VcXsrv](https://sourceforge.net/projects/vcxsrv/) at
  `%ProgramFiles%\VcXsrv\` — ezTerm falls back to that path.
- **Linux** — needs `webkit2gtk-4.1` and `libssl` (matches the build host).

## Dev quickstart

```bash
# one-time
cargo install tauri-cli --version '^2.0' --locked
cargo install sqlx-cli --no-default-features --features sqlite --locked
cp .env.example .env
npm --prefix ui install

# run (uses cargo tauri dev, which runs the Next.js dev server + Rust)
cargo tauri dev
```

Use `cargo tauri dev`, not `cargo run` — the latter fails with
`frontendDist "../ui/out" doesn't exist` because `ui/out/` is a build artifact.
If you must use `cargo run`, build the UI first:
`npm --prefix ui run build && cargo run`.

### Tests + linters

```bash
cargo test --manifest-path src-tauri/Cargo.toml
npm --prefix ui run typecheck
npm --prefix ui run lint
```

### Local release build

```bash
cargo tauri build        # full MSI + NSIS installers on Windows
cargo build --release    # raw self-contained binary in target/release/
```

## Architecture

```
ezTerm/
├── src-tauri/       Rust: Tauri commands, SSH/SFTP, vault, local PTY, X server mgmt
├── ui/              Next.js app (static export embedded into the Rust binary)
├── migrations/      sqlx migrations (SQLite)
└── .github/         release workflow
```

- **Command boundary** — all SSH / SFTP / vault / local-PTY / X-server ops live
  in Rust behind Tauri commands. The UI is a renderer + keyboard capture; no
  protocol logic in TypeScript.
- **Events** — bytes flow from Rust to the UI via `ssh:data:<id>` /
  `ssh:close:<id>` events (reused by both SSH and local PTY drivers).
  Keystrokes flow the other way through `ssh_write` / `local_write` commands.
- **Session kinds** — a single `sessions` table with a `session_kind` column
  (`ssh` / `wsl` / `local`) re-purposes `host` + `username` per kind. The
  connect flow dispatches to either the russh client (SSH) or the
  `portable-pty` backend (WSL / local).
- **X11 forwarding** — russh's `server_channel_open_x11` handler pipes each
  incoming X11 channel bidirectionally into a loopback TCP connection to
  VcXsrv. VcXsrv lifecycle is ref-counted per display.

## Releases

See [docs/RELEASING.md](docs/RELEASING.md) for the tag-push workflow. tl;dr:
bump the version in `Cargo.toml`, push a `v*` tag, GitHub Actions produces the
four `tar.xz` archives and opens a draft release for you to review.

## Licence

ezTerm is licensed under the **GNU General Public License, version 3** (GPLv3
only — not "or later"). See [LICENSE](LICENSE) for the full text.

Third-party components retain their own licences:
- `russh`, `russh-sftp` — Apache 2.0
- `sqlx`, `tokio` — MIT / Apache 2.0
- `portable-pty` — MIT
- `xterm.js` — MIT
- `lucide-react` — ISC
- VcXsrv (not bundled; user-installed) — GPL v2

## Contributing

Issues and PRs welcome at <https://github.com/ZerosAndOnesLLC/ezTerm>. Please
run `cargo test`, `npm --prefix ui run typecheck`, and `npm --prefix ui run lint`
before opening a PR.
