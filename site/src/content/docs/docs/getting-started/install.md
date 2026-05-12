---
title: Install
description: How to install ezTerm on Windows, Linux, and macOS.
---

ezTerm ships as a single self-contained binary — no installer required.

Download the archive for your platform from the [latest release](https://github.com/ZerosAndOnesLLC/ezTerm/releases/latest):

| Platform | Archive |
|---|---|
| Windows x86_64 | `ezterm-windows-x86_64.tar.xz` |
| Linux x86_64 | `ezterm-linux-x86_64.tar.xz` |
| Linux aarch64 | `ezterm-linux-aarch64.tar.xz` |
| macOS aarch64 | `ezterm-macos-aarch64.tar.xz` |

Extract, then run the `ezterm` (or `ezterm.exe`) binary inside.

## Runtime requirements

### Windows
The release tarball bundles VcXsrv in a `vcxsrv/` subfolder next to `ezterm.exe`, so X11 forwarding works out of the box. To use a system install instead, delete the bundled folder and install [VcXsrv](https://sourceforge.net/projects/vcxsrv/) at `%ProgramFiles%\VcXsrv\`.

### Linux
Needs `webkit2gtk-4.1` and `libssl` (match the build host's versions). On Debian/Ubuntu:

```bash
sudo apt install libwebkit2gtk-4.1-0 libssl3
```

### macOS
Apple Silicon only at present. No extra deps.

## First run

Launch the binary. You'll be prompted to set a master password — this unlocks the encrypted credential vault. Pick something memorable; there's no recovery path (see [vault docs](../features/vault/)).

After that, the [first-connect walkthrough](./first-connect/) covers creating your first SSH session.
