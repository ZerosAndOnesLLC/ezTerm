---
title: Import from MobaXterm
description: Bring SSH and WSL sessions over from MobaXterm.
---

ezTerm can read MobaXterm's session exports and recreate them — including the folder structure and any private-key files referenced by the sessions.

## What gets imported

- **SSH sessions** — host, port, username, auth method, attached private keys.
- **WSL sessions** — distro name and user.
- **Folder structure** — top-level folders are preserved.

Other kinds (RDP, Telnet, serial) are not in scope for ezTerm and are skipped.

## How to import

1. In MobaXterm: **Settings → Export sessions** → save the `.mxtsessions` file somewhere.
   (Alternatively, locate your `MobaXterm.ini` — same import works.)
2. In ezTerm: **File menu → Import from MobaXterm** → pick the file.
3. Review the import summary (how many sessions, how many keys), then **Confirm**.

## What happens to private keys

If a MobaXterm session references a private key on disk, ezTerm reads the key file and stores its contents as an encrypted vault credential, then attaches it to the matching session. The original key file on disk is left untouched.

If a key is passphrase-protected, you'll be prompted to enter the passphrase once during import — it's stored as a separate vault credential and reused for any session that needs it.

## Caveats

- ezTerm doesn't currently import macro definitions, terminal colour overrides, or per-session font settings. Sessions come in with ezTerm's defaults; tweak each one in the session-edit dialog if needed.
- Folder colours and icons are not imported — pick fresh ones in ezTerm.
