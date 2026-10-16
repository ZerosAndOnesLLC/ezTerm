---
title: SFTP
description: "ezTerm docks an SFTP file browser beside your terminal on the same SSH connection — browse, upload, download, and manage remote files with no second login."
head:
  - tag: title
    content: "SFTP File Browser in ezTerm — Transfers on One Connection"
sidebar:
  order: 2
---

Each SSH tab can optionally open an **SFTP side-pane** — a file browser docked on the left of the terminal. The pane uses an SFTP subsystem on the same SSH connection, so there's no second authentication step.

## Opening the pane

Click the **SFTP toggle** on the active tab's right edge.

## What you can do

- **Browse** — double-click folders to descend, breadcrumb at the top to ascend.
- **Download** — right-click a file → Download. The file is streamed to a location you choose.
- **Upload** — drag files or whole folders from Explorer into the pane, or use the Upload button. Drop onto a folder row to upload into that folder. Uploads are 32 KiB-chunked with live progress; folder uploads show a per-file count.
- **Select several** — Ctrl-click toggles a row, Shift-click selects a range.
- **New folder, Rename, Delete** — toolbar button and right-click context menu.

## Resizing

The pane and its columns are both adjustable, and every width is remembered across restarts.

- **Pane width** — drag the grab-strip on the pane's right edge (200–640 px). Double-click it to reset.
- **Columns** — drag the right edge of the **Name** or **Size** header. Double-click a header edge to reset that column. When the columns add up to more than the pane width, the list scrolls sideways instead of cutting off long filenames.
- **Keyboard** — Tab to any handle and use the arrow keys (Shift for larger steps); Home restores the default.

## What you can't do (yet)

- Symbolic links are listed but not followed graphically.
- No "Open in editor" (would need a local editor handoff).
- No chmod dialog; the Mode column is read-only.
