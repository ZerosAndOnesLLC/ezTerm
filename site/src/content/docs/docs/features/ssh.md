---
title: SSH
description: russh-backed sessions with password, key, or agent auth.
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
