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
   main channel open to save a round trip. One 10 s deadline covers open +
   exec + read, and a timed-out channel is closed explicitly (bounded to 1 s).
   If the main open is refused (`MaxSessions 1`) it's retried after the
   probe's channel closes; if the probe is the one refused, the reason is
   `channel_refused`.
   The probe prints a marker line `EZTERM-PROBE` first. Without it (cmd.exe /
   PowerShell login shell, restricted or ForceCommand shell) the exit code is
   ignored and the reason is `no_posix_shell`. Everything after the marker is
   ours, so `.bashrc` noise before it is ignored. Fixed commands:
   - tmux: `echo EZTERM-PROBE; command -v tmux || exit 127; tmux -V; tmux list-sessions -F "#S" | grep -qx NAME && exit 0; exit 1`.
     `list-sessions | grep -x` is an exact-name test on every tmux version; `has-session -t =NAME` needs 2.1+. `tmux -V` sets `Caps`: `exact_target` (2.1+) and `new_or_attach` (`new-session -A`, 1.8+).
   - screen: `echo EZTERM-PROBE; command -v screen || exit 127; screen -wipe; o=$(screen -ls 2>&1)`, then
     `No Sockets found` → 1, socket-directory errors (`Cannot `, `Permission denied`, `must have mode`, `not the owner`, `is not a directory`) → 3, otherwise
     `grep -o "[0-9][0-9]*[.]NAME[[:space:]]"` → print `PID.NAME`, exit 0, or exit 1.

   Wrapped in `sh -c '…'` with no `!`, `\` or nested `'` so it parses the same
   under bash, zsh, dash, fish and csh login shells.

   Outcomes: `0` = exists (attach id `=NAME` on tmux 2.1+, plain `NAME` on
   older tmux, validated `PID.NAME` on screen; an exit-0 screen id that
   doesn't validate is `probe_failed`, never "create", which would duplicate
   the name). `1` = absent → create. `3` = `tool_error`. `127` = `missing`.
   Anything else, or a timeout = `probe_failed`.
2. **Main channel** (PTY as today), then instead of `request_shell`:
   - exists → `exec` a script:
     `s=$(date +%s); tmux attach-session -d -t ID; r=$?; [ $r -eq 1 ] && [ elapsed -lt 3 ] && exec <create>; exit $r`
     (screen: `screen -d -r PID.NAME` in the same shape). `-d` detaches a
     stale client still attached from the dead link; screen's `-D` is avoided
     because it also logs that client's SSH session out. The fallback creates
     the session only if the attach failed fast with status 1 (the session
     vanished since the probe). A normal exit or detach (0), a signal
     (128+n) or a tmux server dying later in the session (1, but past the
     window) ends the tab as usual. On tmux without `=` targets, the script
     first repeats the exact-name check so a vanished session can't be
     confused with a prefix-matching neighbour (`…-5-1` vs `…-5-10`).
   - create → `exec tmux new-session -A -s NAME` (plain `new-session -s` on
     tmux < 1.8) / `exec screen -S NAME`. Then the existing `starting_dir` +
     `initial_command` keystrokes are written; they land in the new shell
     inside the multiplexer. **Not** written on attach.
   - unavailable → normal `request_shell` + keystrokes as today, and a yellow
     one-line notice is pushed to the output channel, worded per reason
     (`missing`, `no_posix_shell`, `channel_refused`, `tool_error`,
     `probe_failed`).
3. The `Connection` registry entry records the `PersistTarget` for "End
   remote session". `ssh_connect` returns `persistent: bool` and
   `persist_unavailable: <reason> | null`. The UI only offers "End remote
   session" when `persistent` is true, and only retries a reattach that came
   back without persistence when the reason is `probe_failed`.

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
and always re-probes for the current exact id first, then runs
`tmux kill-session -t =NAME` (on tmux < 2.1, `grep -qx NAME || exit 0; tmux
kill-session -t NAME`, so a vanished session can't take a prefix neighbour
with it) / `screen -S PID.NAME -X quit`. The attached client then exits with
a status, and the tab shows "Disconnected" as normal.

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

## Hardening (post-v1.14.0 review)

A deep review after release found gaps between the promise ("reconnect without losing anything") and edge-case behaviour. Changes:

- **Login drops are retryable.** russh 0.65 reports a transport that dies mid-auth as a plain auth *failure*, which read as a wrong password. `ClientHandler::disconnected` now records whether the *server* sent SSH_MSG_DISCONNECT. After auth: transport gone with no server disconnect → retryable `Ssh("connection lost during authentication")`. Server disconnect (e.g. "Too many authentication failures") → `AuthError`, which is never retried. Transport up and auth said no → `AuthFailed`.
- **tmux probe works on every version.** `tmux list-sessions -F "#S" | grep -qx NAME` replaces `has-session -t =NAME` (`=` targets need tmux 2.1+). The probe also prints `tmux -V`. On tmux 2.1+ the attach id is `=NAME`; on older tmux it's the plain name (exact matches win once the probe proved one exists). Create uses `new-session -A` on tmux 1.8+, so a racing duplicate attaches instead of failing.
- **Attach falls back to create.** `tmux attach-session -d -t ID || exec tmux new-session -A -s NAME` (screen: `screen -d -r ID || exec screen -S NAME`). If the session vanished between probe and attach, the user gets a fresh session instead of a bare "exit 1".
- **screen socket errors** (`Cannot …`, `Permission denied`, `must have mode`, `not the owner`, `is not a directory`) exit 3 → `tool_error` (plain shell + notice), not "absent → create → fail".
- **Probe timeout is 10 s** (was 4 s), and a timed-out probe channel is closed explicitly. russh sends no CLOSE on drop, so an abandoned probe kept its session slot on the server.
- **End remote session always re-probes** for the current exact id, so a stale plain name can't prefix-match another tab's session.
- **Reattach is verified.** If an auto-reconnect connects but comes back *without* persistence after the previous connection had it, the attempt is dropped and retried ("could not reattach to the remote session").
- **Flapping links still give up.** A link that drops again within 60 s of a successful auto-reconnect continues the attempt count instead of restarting at 1. Turning auto-reconnect off mid-loop stops it at the next attempt.
- **SFTP pane re-opens after reconnect.** The pane tracks which connection it opened SFTP on, and the tab's `connectionId` is cleared on teardown.
- **The X server ref is released on every early return** after it's acquired (`XServerRefGuard`).
- **Exit codes are shown.** OpenSSH sends EOF before exit-status, so the driver now waits up to 2 s after EOF for the status, and "Disconnected (exit 1)" appears again.
- **Too many tabs** (>99 of one session) reads "too many tabs open for this session (persistent sessions allow 99)".

### Second review round

- **Login drop vs refusal is a pure, tested table** (`classify_auth`). A successful login whose link drops right after is a plain drop (`ssh`). A drop mid-login is `auth_lost`, which the UI retries **once**: a second one in a row stops, in case the server's DISCONNECT went unrecorded (russh skips the `disconnected` callback if the socket shutdown errors).
- **Reattach retries only transient failures.** `persist_unavailable` carries the reason, and only `probe_failed` is retried. A host without tmux, without a POSIX shell, limited to one channel, or with a broken screen dir gets the plain shell + notice, as before.
- **The probe has one deadline (10 s total), and the close is bounded (1 s).**
- **The attach fallback is narrowed** to a fast status 1, and old tmux re-checks the exact name before attach / kill.
- **A manual reconnect resets the flap count.** Turning auto-reconnect off cancels a running countdown at once. A give-up keeps the last real error across a flap.
- **Hidden tabs wait to re-open SFTP** until shown.
- **The X server release callback** runs on Tauri's runtime (safe from `Drop`) and is unit-tested.
