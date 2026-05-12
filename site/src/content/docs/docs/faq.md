---
title: FAQ
description: Frequently asked questions.
---

## Is it really free?

Yes. GPLv3. No paid tier, no nag screen, no "pro" features.

## Does it work on Linux / macOS?

Yes, the binary builds and runs. SSH, SFTP, local shells, and the terminal all work. WSL is Windows-only by nature; X11 forwarding on Linux uses your system X server, and on macOS requires XQuartz.

## Why Tauri instead of Electron?

Smaller binary (~20 MB vs ~150 MB), lower memory, and the Rust backend handles all SSH / SFTP / vault / PTY work directly — no Node runtime in the protocol path.

## Can I run my own X server instead of the bundled VcXsrv?

Yes — install VcXsrv at `%ProgramFiles%\VcXsrv\` and delete the `vcxsrv/` folder next to `ezterm.exe`. See [X11 forwarding](/docs/features/x11-forwarding/).

## Does it support Telnet / RDP / serial?

No, and not planned. ezTerm is SSH-focused. Out of scope: Telnet, RDP, serial, X11 *server*, macros, session recording.

## How do I import existing sessions?

From MobaXterm — see [Import from MobaXterm](/docs/getting-started/importing-from-mobaxterm/). Importers for PuTTY / SecureCRT are not in v1 but tracked on the issue board.

## Where does ezTerm store data?

- **Database** (sessions, known-hosts, vault): `%LOCALAPPDATA%\ezterm\ezterm.db` (Windows) or `~/.local/share/ezterm/ezterm.db` (Linux).
- **Logs**: same parent dir, `logs/` subfolder.
- **Config**: same parent dir, `config.toml`.

## How do I report a security issue?

See [SECURITY.md](https://github.com/ZerosAndOnesLLC/ezTerm/blob/main/SECURITY.md) — please **don't** open a public issue.
