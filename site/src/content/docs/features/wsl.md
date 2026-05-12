---
title: WSL
description: WSL distros as tabs under ConPTY.
sidebar:
  order: 3
---

ezTerm can open WSL distros as terminal tabs — same UI as SSH sessions, but the backend is `wsl.exe -d <distro>` under a [ConPTY](https://devblogs.microsoft.com/commandline/windows-command-line-introducing-the-windows-pseudo-console-conpty/) on Windows.

## Create a WSL session

1. New session → **WSL**.
2. Pick the distro from the dropdown (ezTerm enumerates installed distros via `wsl.exe -l -v`).
3. (Optional) set the user.
4. Save and connect.

## Interop

Because the tab runs `wsl.exe`, all WSL ↔ Windows interop works:

- `code .` opens VS Code on the Windows host with the current WSL folder mounted.
- `explorer.exe .` opens Windows Explorer at the current path.
- Windows commands run via `<command>.exe`.

## Limitations

- Only one distro per session — switch by opening a new tab.
- WSL1 is supported but slower; WSL2 is preferred.
