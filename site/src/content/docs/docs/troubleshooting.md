---
title: Troubleshooting
description: Common issues and fixes.
---

## "Host key mismatch" hard-failure

ezTerm refuses to connect if the server's host key has changed since the last successful connect. This is intentional — a mismatch usually means MITM, a server rebuild, or someone reinstalling the OS.

**Fix:** open the known-hosts manager, find the entry for this host, and delete it. The next connect prompts for fresh trust.

## "EADDRINUSE" on a port forward

The bind port is already in use — usually by another ezTerm tab forwarding the same port, or by a non-ezTerm process.

**Fix:** pick a different local port, or stop the conflicting process. `netstat -ano` on Windows shows what owns a port.

## X11 forwarding window doesn't appear

Check:

1. The session has **Forward X11** enabled.
2. The remote shell has `$DISPLAY` set after connect (`echo $DISPLAY` should print something like `localhost:10.0`).
3. On Windows, VcXsrv is bundled — confirm `vcxsrv/` exists next to `ezterm.exe`.

## Vault won't unlock after upgrade

ezTerm's vault format is stable — upgrades don't invalidate it. If unlock fails after an upgrade, the master password is wrong. There's no recovery (see [Vault docs](/docs/features/vault/)).

## Linux: `error while loading shared libraries: libwebkit2gtk-4.1.so.0`

Install the runtime dep:

```bash
sudo apt install libwebkit2gtk-4.1-0
```

## Reporting a bug

Open an issue at [github.com/ZerosAndOnesLLC/ezTerm/issues](https://github.com/ZerosAndOnesLLC/ezTerm/issues) with:

- ezTerm version (Help → About, or run `ezterm --version`).
- OS and architecture.
- Steps to reproduce.
- Any logs from `%LOCALAPPDATA%\ezterm\logs\` (Windows) or `~/.local/share/ezterm/logs/` (Linux).
