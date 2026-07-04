---
title: Local shells
description: "Run cmd, PowerShell, pwsh, or any local executable as an ezTerm tab — keep local shells, WSL distros, and remote SSH sessions together in one window."
head:
  - tag: title
    content: "Local Shell Tabs in ezTerm — cmd, PowerShell & Custom"
sidebar:
  order: 4
---

ezTerm can also open **local shells** — a Windows cmd, PowerShell, pwsh, or any absolute path to an executable.

## Create a local session

1. New session → **Local**.
2. Pick a preset (`cmd`, `powershell`, `pwsh`) or browse to a custom path.
3. (Optional) set a starting directory.
4. Save and connect.

The shell runs in a ConPTY just like WSL sessions, so colours and ANSI escapes work normally.

## Why?

For users who want everything in one window — local PowerShell, a WSL distro, and a remote SSH session as sibling tabs.
