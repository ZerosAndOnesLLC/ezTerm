---
title: X11 forwarding
description: Run remote Linux GUI apps as native Windows windows.
sidebar:
  order: 5
---

ezTerm bundles [VcXsrv](https://sourceforge.net/projects/vcxsrv/) on Windows so X11 forwarding works with no extra install. Remote GUI apps (`xeyes`, `gedit`, JetBrains IDEs, etc.) appear as native Windows windows on your desktop.

## Enable it

In the SSH session edit dialog, tick **Forward X11**. Save and (re)connect.

## How it works

When the SSH channel opens, russh's `server_channel_open_x11` handler pipes each incoming X11 channel bidirectionally to a loopback TCP connection on VcXsrv. The X server lifecycle is ref-counted per display — VcXsrv starts on the first X11-enabled session and exits when the last one closes.

## Using your own VcXsrv

If you'd rather use a system VcXsrv install:

1. Install VcXsrv at `%ProgramFiles%\VcXsrv\` (the default path).
2. Delete the `vcxsrv/` subfolder next to `ezterm.exe`.
3. ezTerm will fall back to the system install.

## Linux / macOS

X11 forwarding works on Linux against the user's existing X server. On macOS it requires XQuartz, which ezTerm does not manage — install it yourself.
