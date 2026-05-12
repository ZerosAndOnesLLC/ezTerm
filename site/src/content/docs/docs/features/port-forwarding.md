---
title: Port forwarding
description: Local, remote, and dynamic (SOCKS5) forwards.
sidebar:
  order: 6
---

ezTerm supports all three SSH port-forward kinds — same semantics as the OpenSSH command-line flags.

| Kind | Flag | What it does |
|---|---|---|
| **Local** | `-L` | Client port → remote-reachable destination. |
| **Remote** | `-R` | Remote port → client-reachable destination. |
| **Dynamic** | `-D` | Local SOCKS5 proxy that tunnels through the server. |

## Persistent vs ad-hoc

- **Persistent** forwards are saved on the session and auto-start when you connect.
- **Ad-hoc** forwards are added to a running tab from the Forwards side-pane and die with the connection.

Both kinds flow through the same runtime and look identical in the UI.

## Add a forward

1. On a running SSH tab, open the **Forwards side-pane** (toolbar icon).
2. Click **+ Add forward**.
3. Pick the kind, set bind address/port and destination address/port.
4. Save.

Or pre-configure persistent forwards in the session edit dialog's **Forwards** tab.

## Caveats

- The dynamic forward implements **SOCKS5 with no auth, CONNECT only**. `BIND` and `UDP ASSOCIATE` are out of scope.
- Privileged ports (`<1024`) are allowed in the UI; the OS enforces. Bind failure surfaces in the pane with elevation guidance.
- Two tabs binding the same local port → second tab gets a friendly `EADDRINUSE` error.
- Editing a running forward = stop + restart.

## Default bind address

Defaults to `127.0.0.1`. Non-loopback values are allowed but trigger a yellow "LAN-reachable" warning so you don't accidentally expose a tunnel to your whole network.
