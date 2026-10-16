---
title: SSH
description: "How SSH works in ezTerm — password, private-key, and agent authentication, host-key TOFU verification, keepalives, timeouts, and compression via russh."
head:
  - tag: title
    content: "SSH in ezTerm — Password, Key & Agent Auth, Host-Key TOFU"
sidebar:
  order: 1
---

ezTerm uses [russh](https://crates.io/crates/russh) — a pure-Rust SSH client — for all SSH sessions. Connections run inside async tokio tasks; no OpenSSH or PuTTY dependency.

## Auth methods

| Method | What it does |
|---|---|
| **Password** | Stored encrypted in the vault. Re-used across reconnects. |
| **Private key** | Stored encrypted in the vault. Key file on disk is read once at save time. |
| **SSH agent** | Talks to a running ssh-agent (Windows: openssh-agent service, or Pageant). |

Pick one per session; ezTerm doesn't try multiple methods automatically.

## Host-key TOFU

On first connect to a host, ezTerm shows the server's fingerprint and asks for confirmation. On subsequent connects, the stored fingerprint is compared — a mismatch is a hard failure (no "ignore" prompt). To re-trust a server (legitimate key rotation), delete the entry from the known-hosts manager.

Known-hosts entries live in ezTerm's own SQLite database — not `~/.ssh/known_hosts`. This keeps ezTerm's trust state independent of the OpenSSH CLI.

## Keepalive and timeouts

Each session has independent **connect timeout** (initial handshake) and **keepalive interval** (TCP-level liveness ping while connected). Defaults are reasonable for most networks; bump keepalive shorter for flaky connections that drop idle.

## Compression

Optional — enable in the session edit dialog. Useful on slow links; mostly invisible on LAN.

## Disconnects

When a session ends, the tab says why. A shell that exits with a non-zero status shows **Disconnected (exit N)**; one killed by a signal shows the signal name, such as **Disconnected (killed by SIGKILL)**. An error that happened earlier in the session is kept on the tab rather than being replaced by the final close.

Terminal output also has a stall watchdog. The backend counts what it has sent, the terminal checks every few seconds that it is keeping up, and if output stops arriving while the backend is still ahead, the tab fails with a visible error instead of appearing frozen.
