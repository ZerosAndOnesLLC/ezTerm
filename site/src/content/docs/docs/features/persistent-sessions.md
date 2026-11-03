---
title: Persistent sessions & auto-reconnect
description: "ezTerm runs your SSH shell inside tmux or screen and reconnects automatically, so a dropped connection, a sleeping laptop or a closed tab never loses your work."
head:
  - tag: title
    content: "Persistent SSH Sessions & Auto-Reconnect in ezTerm (tmux / screen)"
sidebar:
  order: 2
---

A dropped SSH connection normally kills everything running in it: the build, the editor, the `tail -f`. ezTerm can run your shell inside a **tmux** or **screen** session on the server instead, and reconnect by itself when the link comes back. You land exactly where you left off.

## Turn it on

Open the session's settings and go to **Advanced → Persistent session**.

1. Pick **tmux** or **screen**. The server needs that tool installed.
2. Leave **Reconnect automatically if the connection drops** ticked. It's switched on the first time you pick tmux or screen.
3. Set a **Keepalive** in the Connection section (60 seconds is the default for new sessions). Without one, a dead link can take minutes to notice. The dialog warns you if it's off.

Save and connect. Nothing else changes about how you use the terminal.

## What happens

- **On connect,** ezTerm checks whether this tab's remote session already exists. If it does, ezTerm reattaches to it. If not, it creates one and runs your starting directory and initial command inside it. Those run only on creation, never on a reattach, so they won't type into whatever you left running.
- **When the connection drops** (Wi-Fi loss, laptop sleep, VPN flap, server restart), the tab shows *Connection lost — reconnecting* and retries on its own: after roughly 1, 2, 4, 8 and 16 seconds, then about every 30 seconds (with a little random spread so many tabs don’t all retry at once), up to 20 attempts. **Retry now** and **Cancel** are on the overlay. When the network is back you're reattached with everything still running.
- **When you close a tab,** it only detaches. The remote session keeps running, and opening the session again later reattaches to it, even after restarting ezTerm.
- **When you're done** with a remote session, type `exit` in its last shell, or right-click in the terminal and choose **End remote session…**.

Typing `exit` or detaching from tmux (`Ctrl-b d`) ends the tab normally. That isn't a dropped connection, so ezTerm doesn't reconnect.

## One remote session per tab

Each tab gets its own remote session, named `ezterm-<install>-<session>-<tab>`. Open the same saved session in two tabs and you get two independent shells, not one mirrored screen. The `<install>` part is a random id for this copy of ezTerm, so other people (or your other machines) using the same server account never attach to yours.

## Safe by design

- Auto-reconnect never trusts a changed host key. A host-key prompt, a wrong password or a locked vault stops the retries and shows the usual dialog.
- Login failures from your SSH agent or the server ("too many authentication failures") are not retried either, so ezTerm won't trip fail2ban or lock your account.
- The commands ezTerm sends to the server are fixed templates. Nothing you type into a session's settings is spliced into them.

## If tmux or screen isn't installed

You get a normal shell and a one-line yellow notice in the terminal, such as *tmux not found on this host — using a normal shell*. Auto-reconnect still works, but the shell itself won't survive a drop. Install the tool on the server (`apt install tmux`, `dnf install tmux`, `brew install tmux`, …) and reconnect.

## Scrolling and Find

Inside tmux or screen, the history lives in the multiplexer, so ezTerm's scrollback and **Find** only see what's been drawn on screen. To scroll with the mouse wheel in tmux, add this to `~/.tmux.conf` on the server:

```
set -g mouse on
```

ezTerm never edits files on the server for you.
