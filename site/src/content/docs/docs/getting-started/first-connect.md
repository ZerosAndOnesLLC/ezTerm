---
title: First connect
description: Create a session, connect, and run a command.
---

After setting your master password, you'll see the empty sessions sidebar. Let's connect to a server.

## Create a session

1. Click **New session** in the sidebar (or right-click → New session).
2. Pick **SSH** as the session kind.
3. Fill in:
   - **Host** — e.g. `example.com` or an IP address.
   - **Port** — `22` unless your server uses a different port.
   - **Username** — your remote user.
   - **Auth method** — Password, Private key, or SSH agent.
4. Click **Save**.

The session appears in the sidebar.

## Connect

Double-click the saved session (or right-click → Connect). A new tab opens.

- On **first connect**, ezTerm shows the server's host-key fingerprint. Verify it matches what your server admin published, then click **Trust**. Subsequent connects use the stored key — a mismatch is a hard failure (see [SSH docs](../features/ssh/) for TOFU details).
- If auth fails, an inline overlay appears in the tab — fix the credentials there without closing the tab.

## What you can do now

- **Terminal** — full xterm.js with 24-bit colour, scrollback, find (`Ctrl+Shift+F`), copy (`Ctrl+Shift+C`), paste (`Ctrl+Shift+V` or `Shift+Insert`).
- **SFTP** — click the SFTP toggle on the tab to open a docked file browser on the same connection.
- **Forwards** — open the Forwards side-pane to add a port forward to the running session.

## Importing from MobaXterm

Got a `.mxtsessions` export? See [Import from MobaXterm](./importing-from-mobaxterm/).
