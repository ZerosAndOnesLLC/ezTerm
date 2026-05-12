---
title: SFTP
description: File transfer side-pane on the same SSH connection.
sidebar:
  order: 2
---

Each SSH tab can optionally open an **SFTP side-pane** — a file browser docked on the left of the terminal. The pane uses an SFTP subsystem on the same SSH connection, so there's no second authentication step.

## Opening the pane

- Click the **SFTP toggle** on the active tab's right-edge, or
- Use the keyboard shortcut (see [keybinds](/docs/troubleshooting/)).

## What you can do

- **Browse** — click folders to descend, breadcrumb at the top to ascend.
- **Download** — right-click a file → Download. The file is streamed to your local Downloads folder.
- **Upload** — drag a file from Windows Explorer into the pane. Uploads are 32 KiB-chunked with live progress.
- **Rename / Delete** — right-click context menu.

## What you can't do (yet)

- Symbolic links are listed but not followed graphically.
- No "Open in editor" (would need a local editor handoff — not in v1).
- No multi-select for batch operations.
