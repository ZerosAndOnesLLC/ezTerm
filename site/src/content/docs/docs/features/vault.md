---
title: Vault
description: Encrypted credential storage. Argon2id + ChaCha20-Poly1305.
sidebar:
  order: 7
---

Every secret ezTerm stores — SSH passwords, private keys, key passphrases — lives encrypted in the **vault**. Plaintext only exists in memory while a connection is being made, and is zeroized on drop.

## How it works

1. On first launch, you set a **master password**. Argon2id (memory-hard KDF) derives a vault key from it.
2. Each stored secret is encrypted as `(nonce, ciphertext)` using ChaCha20-Poly1305 (AEAD) and written to SQLite.
3. The vault key lives only in memory while the app is unlocked. Lock the vault (status-bar lock button) and the key is zeroized — re-entering the master password is required to use any session.

## Credential kinds

Three distinct kinds — so one stored passphrase can back many sessions:

- **Password** — used directly for password auth.
- **Private key** — the key material (PEM/OpenSSH format).
- **Passphrase** — the unlock passphrase for a private key.

## Backup

The vault can be exported as a single encrypted blob (master-password-protected). Import on another machine to migrate.

## What ezTerm never does

- Never logs plaintext secrets, ever — host, user, and fingerprint are the only identifiers that appear in traces.
- Never sends plaintext credentials to the renderer process — even auth material is passed only as an ephemeral handle.
- Never stores the master password itself — only the Argon2id verifier needed to derive the vault key.

## What happens if you forget the master password

There is no recovery. The vault is encrypted with a key derived from your password, and ezTerm has no escrow. If you lose it, the only path forward is to delete the vault and recreate sessions from scratch.
