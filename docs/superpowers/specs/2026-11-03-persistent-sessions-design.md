# Persistent remote sessions (tmux / screen) + auto-reconnect

Date: 2026-11-03
Status: approved for implementation

## Goal

Dropping the SSH link (Wi-Fi blip, laptop sleep, VPN flap) should not cost the
user their work. With the option on, an SSH tab runs its shell inside a remote
`tmux` or `screen` session; when the transport drops ezTerm reconnects on its
own and reattaches, landing the user exactly where they were.

Both features are **per-session options in the connection manager** (session
dialog), off by default.

## Settings (sessions table)

| Column | Type | Default | Meaning |
|---|---|---|---|
| `persistent_shell` | `TEXT NOT NULL` | `'off'` | `'off' \| 'tmux' \| 'screen'` |
| `auto_reconnect` | `INTEGER NOT NULL` | `0` | `0/1` — reconnect automatically when the transport drops |

Both are SSH-only; the validator rejects non-default values on `wsl`/`local`
rows. They are copied by duplicate, backup/restore, and sync like every other
column (old backups without the fields deserialize to the defaults).
`auto_reconnect` is independent of `persistent_shell` (useful without it), but
the dialog turns it on when the user first picks tmux/screen.

## Remote session naming — one per tab

Each tab gets its own remote session: `ezterm-<install_id>-<session_id>-<slot>`.

- `install_id` is 8 random hex chars minted once per install and stored
  under the local-only settings key `local.install_id`. `local.*` keys are
  never listed to the webview, exported to backups / sync, restored, or
  writable via `settings_set` — so two installs (two admins on a shared
  account, or one user's laptop + desktop) never attach to or kill each
  other's sessions.

- `slot` is assigned when the tab opens: the lowest integer ≥ 1 not used by
  another open tab of the same saved session. It stays fixed for the tab's
  life, so reconnects reattach to the same remote session.
- Closing tab 1 and opening the session again reuses slot 1 → reattaches to
  the session left running. Same after an app restart.
- The frontend passes `persist_slot` in `ssh_connect` args (validated 1..=99);
  the name is built in Rust from the validated hex id and integers only — no
  user text in the command.

## Connect flow (Rust, `ssh/client.rs`)

After auth, when `persistent_shell != 'off'`:

1. **Probe** on a separate exec channel (no PTY), run *concurrently* with the
   main channel open to save a round trip (4 s timeout). If the main open is
   refused (`MaxSessions 1`) it's retried after the probe's channel closes;
   if the probe is the one refused it reports ProbeFailed → plain shell.
   The probe prints a marker line `EZTERM-PROBE` first; without it (cmd.exe /
   PowerShell login shell, restricted shell) the exit code is ignored and the
   result is ProbeFailed. For screen the id is the last non-empty line after
   the marker, so `.bashrc` noise is ignored; an exit-0 id that doesn't
   validate is ProbeFailed (never "create", which would duplicate the name).
   Fixed commands:
   - tmux: `sh -c 'command -v tmux >/dev/null 2>&1 || exit 127; tmux has-session -t =NAME 2>/dev/null && exit 0; exit 1'`
   - screen: `sh -c 'command -v screen >/dev/null 2>&1 || exit 127; screen -ls 2>/dev/null | grep -q "[.]NAME[[:space:]]" && exit 0; exit 1'`

   Wrapped in `sh -c '…'` with no `!`, `\` or nested `'` so it parses the same
   under bash, zsh, dash, fish and csh login shells. Exit `0` = exists,
   `1` = create, `127` (or anything else) = tool unavailable.
2. **Main channel** (PTY as today), then instead of `request_shell`:
   - exists → `exec`: `tmux attach-session -d -t =NAME` / `screen -d -r PID.NAME`
     (`-d` detaches a stale client still attached from the dead link; screen's
     `-D` is avoided because it also logs that client's SSH session out).
   - create → `exec`: `tmux new-session -s NAME` / `screen -S NAME`, then the
     existing `starting_dir` + `initial_command` keystrokes are written (they
     land in the new shell inside the multiplexer). **Not** written on attach.
   - unavailable → normal `request_shell` + keystrokes as today, and a yellow
     one-line notice is pushed to the output channel — "tmux not found on this
     host" (exit 127) or "could not check for tmux on this host" (timeout,
     refused channel, no marker, odd exit code).
3. The `Connection` registry entry records a `PersistBinding` (target + the
   exact attach id when known: tmux `=NAME`, or screen `PID.NAME` on
   reattach) so "End remote session" usually needs no second probe.
   `ssh_connect` returns `persistent: bool` and the UI only offers "End
   remote session" when it's true.

X11 forwarding and env vars are requested before the exec exactly as before.

## Detecting a dropped link (Rust)

`drive_channel` emits a new `ssh:lost:{id}` when `channel.wait()` returns
`None`. In russh 0.65 a server CHANNEL_CLOSE is forwarded as an explicit
`ChannelMsg::Close` before the sender is dropped, so `None` only happens when
the session / transport itself is gone (keepalive timeout, TCP reset, server
`SSH_MSG_DISCONNECT` — sshd restart or admin kick also reconnects). Exit
status, signal, server Eof/Close and user Close keep emitting `ssh:close`.
The mapping lives in a pure `channel_end()` fn with unit tests. So:

- `exit` in the last tmux window, or detach (`prefix d`) → exit status → plain
  "Disconnected", no auto-reconnect.
- Keepalive timeout / TCP reset → `ssh:lost` → auto-reconnect (if enabled).

Drop detection speed depends on SSH keepalive; the dialog warns when
auto-reconnect is on and keepalive is 0.

## Auto-reconnect (frontend, `terminal.tsx`)

- Triggers: `ssh:lost`, or the output-stall watchdog firing, on a tab whose
  session has `auto_reconnect = 1`.
- Backoff: 1, 2, 4, 8, 16, 30, 30, … seconds with ±25 % jitter (so tabs
  dropped by one blip don't reconnect in lock-step and trip `MaxStartups`);
  gives up after 20 attempts (~8 min) and shows the error card with the last
  real error and the Reconnect button.
- Overlay while waiting: spinner, "Connection lost — reconnecting (attempt n)",
  countdown to the next try, **Cancel** (stops retrying, shows Disconnected)
  and **Retry now**.
- Fatal errors stop the loop and fall through to today's UI: host-key
  untrusted/mismatch (prompt), auth failures (auth-fix overlay), X server
  missing, and the codes `auth_error` (agent errors / timeouts / "too many
  authentication failures" — re-tagged by the backend so we never re-offer
  credentials and trip fail2ban), `vault_locked`, `not_found`, `validation`.
  Everything else (timeout, refused, DNS, network unreachable) is retryable.
- The loop is `lib/reconnect-loop.ts` (`ReconnectLoop`, React-free, unit
  tested with fake timers): timer, Retry now, Cancel, give-up, and a
  generation counter so an in-flight attempt can't re-arm a cancelled loop.
- `runConnect` returns `'ok' | 'fatal' | 'retryable' | 'cancelled'` and bumps
  a connect-sequence ref on entry; every await re-checks it, so an attempt
  superseded by Cancel / manual Reconnect / unmount disconnects whatever it
  opened and touches no UI. Closing the tab or a manual Reconnect cancels.
- The countdown lives in a small `ReconnectCard` component that ticks once a
  second, only while visible and only until the attempt fires.

## End remote session

When the tab's session uses tmux/screen and is connected, the terminal context
menu gains **End remote session** (with confirm). Backend command
`ssh_persist_kill(connection_id)` opens an exec channel on the same connection
and runs `tmux kill-session -t =NAME` / `screen -S NAME -X quit`. The attached
client then exits with a status, and the tab shows "Disconnected" as normal.

Closing a tab only **detaches** — the remote session keeps running.

## UI (session dialog → Advanced, SSH only)

New section **Persistent session**:

- Radio: `Off` / `tmux` / `screen`, with hint: "Runs the shell inside tmux or
  screen on the server. Closing the tab or losing the connection leaves it
  running; reconnecting picks up where you left off. Falls back to a normal
  shell if the tool isn't installed."
- Checkbox: "Reconnect automatically if the connection drops".
- Inline warning when auto-reconnect is on and keepalive is 0.

## Known tradeoffs (documented in README)

- Scrollback lives in tmux/screen; xterm.js scrollback / Find only see what's
  been drawn. Users can enable `set -g mouse on` (tmux) for wheel scrolling.
  ezTerm never edits remote dotfiles.
- Remote sessions accumulate if never ended; "End remote session" or normal
  `exit` cleans up.
- Sessions are per install (see install id), so picking up the same remote
  session from a second machine isn't supported.
- With `MaxSessions 1` on the server the probe can lose the channel race and
  the tab falls back to a plain shell (with a notice).

## Out of scope

Listing/choosing arbitrary existing remote sessions, mirrored (shared) tabs,
pushing a tmux/screen config to the host, auto-reconnect for WSL/local tabs.

## Testing

- Rust unit tests: name builder, probe/attach/create command builders (no
  forbidden characters), validator for new fields.
- Migration via `sqlx migrate run`; `cargo check`, `cargo clippy`, `cargo test`.
- UI: `npm run lint`, `npm test` (slot allocation + backoff schedule unit tests).
- Manual: tmux and screen hosts, host without either, kill network → auto
  reattach; `exit` → no reconnect; End remote session.
