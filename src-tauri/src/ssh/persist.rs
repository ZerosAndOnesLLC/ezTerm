//! Persistent remote sessions: run the SSH tab's shell inside a remote
//! `tmux` / `screen` session so a dropped link (or a closed tab) leaves the
//! work running, and reconnecting reattaches to it.
//!
//! Every command string built here is a fixed template plus a session name
//! assembled from a validated hex install id and two integers — no
//! user-supplied text ever reaches the remote command line. Commands are
//! wrapped in `sh -c '…'` and contain no `'`, `!` or `\\` so they parse the
//! same under bash, zsh, dash, fish and csh/tcsh login shells (sshd hands
//! exec requests to the user's shell).
//!
//! See docs/superpowers/specs/2026-11-03-persistent-sessions-design.md.

use std::time::Duration;

use rand::{TryRng, rngs::SysRng};
use russh::ChannelMsg;
use russh::client::Handle;
use sqlx::SqlitePool;

use crate::db;
use crate::error::{AppError, Result};
use crate::log_redacted;
use crate::ssh::client::ClientHandler;

/// Highest per-tab slot accepted from the frontend. Slots are the lowest
/// free integer per saved session, so 99 open tabs of one session is
/// already far past any real use.
pub const MAX_SLOT: u32 = 99;

/// Settings key holding this install's random id. The `local.` prefix keeps
/// it out of backups / sync (see `db::settings::is_local_only`) so a
/// restored or synced profile on another machine mints its own id instead
/// of colliding with this one's remote sessions.
pub const INSTALL_ID_KEY: &str = "local.install_id";
/// Install id length in lowercase hex chars (32 bits of entropy). Collisions
/// only matter between installs that share a remote account; 1 in 4 billion
/// is plenty and keeps the name short in `tmux ls`.
const INSTALL_ID_LEN: usize = 8;

/// The probe runs on every connect / reconnect attempt. It is one quick
/// command, but a reconnect often lands on a server that is just coming
/// back and slow to start a login shell; timing out too early would drop
/// the tab to a plain shell and strand the user's session.
const PROBE_TIMEOUT: Duration = Duration::from_secs(10);
/// Ending a session is user-initiated; allow a slower host more time.
const KILL_TIMEOUT: Duration = Duration::from_secs(10);
/// Cap on captured probe stdout — the probe prints a marker and one id.
const EXEC_OUTPUT_MAX: usize = 4_096;

/// First line the probe prints. Its absence means the probe never ran in a
/// POSIX `sh` (Windows OpenSSH with cmd.exe / PowerShell, a restricted
/// shell, …) so the exit code means nothing and we fall back to a plain
/// shell instead of guessing.
const PROBE_MARKER: &str = "EZTERM-PROBE";

/// Common prefix: append the usual non-default install dirs so a tmux /
/// screen from Homebrew or MacPorts is found even though sshd's exec
/// environment doesn't source login profiles. Appended, never prepended,
/// so the host's own PATH order still wins.
const PATH_PREFIX: &str =
    "PATH=\"$PATH:/usr/local/bin:/opt/homebrew/bin:/opt/local/bin\"; export PATH; ";

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum PersistKind {
    Tmux,
    Screen,
}

impl PersistKind {
    /// Parse the `sessions.persistent_shell` column. `Ok(None)` = off.
    pub fn parse(raw: &str) -> Result<Option<Self>> {
        match raw {
            "off" => Ok(None),
            "tmux" => Ok(Some(Self::Tmux)),
            "screen" => Ok(Some(Self::Screen)),
            _ => Err(AppError::Validation("invalid persistent_shell".into())),
        }
    }

    pub fn tool(self) -> &'static str {
        match self {
            Self::Tmux => "tmux",
            Self::Screen => "screen",
        }
    }
}

fn valid_install_id(id: &str) -> bool {
    id.len() == INSTALL_ID_LEN && id.bytes().all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f'))
}

/// This install's id, minted on first use. Insert-if-absent then read back,
/// so two tabs connecting at once on a fresh profile agree on one id.
pub async fn install_id(pool: &SqlitePool) -> Result<String> {
    if let Some(id) = db::settings::get(pool, INSTALL_ID_KEY).await?
        && valid_install_id(&id)
    {
        return Ok(id);
    }
    let mut buf = [0u8; INSTALL_ID_LEN / 2];
    SysRng
        .try_fill_bytes(&mut buf)
        .map_err(|_| AppError::Crypto)?;
    let fresh: String = buf.iter().map(|b| format!("{b:02x}")).collect();
    // A stored-but-invalid value (hand-edited DB) is replaced outright;
    // otherwise only fill the gap so a concurrent first connect wins.
    match db::settings::get(pool, INSTALL_ID_KEY).await? {
        Some(bad) if !valid_install_id(&bad) => {
            db::settings::set(pool, INSTALL_ID_KEY, &fresh).await?
        }
        _ => db::settings::set_if_absent(pool, INSTALL_ID_KEY, &fresh).await?,
    }
    let id = db::settings::get(pool, INSTALL_ID_KEY)
        .await?
        .unwrap_or_default();
    if valid_install_id(&id) {
        Ok(id)
    } else {
        Err(AppError::Validation("could not store install id".into()))
    }
}

/// The remote session a tab is bound to.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PersistTarget {
    pub kind: PersistKind,
    /// `ezterm-<install_id>-<session_id>-<slot>` — only `[a-z0-9-]`.
    pub name: String,
}

impl PersistTarget {
    pub fn new(kind: PersistKind, install_id: &str, session_id: i64, slot: u32) -> Result<Self> {
        if !valid_install_id(install_id) {
            return Err(AppError::Validation("invalid install id".into()));
        }
        if session_id <= 0 {
            return Err(AppError::Validation("invalid session id".into()));
        }
        if slot == 0 || slot > MAX_SLOT {
            return Err(AppError::Validation(format!(
                "too many tabs open for this session (persistent sessions allow {MAX_SLOT})"
            )));
        }
        Ok(Self {
            kind,
            name: format!("ezterm-{install_id}-{session_id}-{slot}"),
        })
    }
}

/// Why the tool couldn't be used — drives the wording of the notice.
#[derive(Debug, PartialEq, Eq)]
pub enum Unavailable {
    /// Probe ran in sh and reported the tool isn't on PATH.
    Missing,
    /// No probe marker: the login shell never ran `sh` (Windows OpenSSH
    /// with cmd.exe / PowerShell, a restricted or ForceCommand shell).
    NoPosixShell,
    /// The server refused a second session channel (`MaxSessions 1`).
    ChannelRefused,
    /// The tool is there but can't work: screen's socket directory is
    /// missing, has the wrong mode or owner.
    ToolError,
    /// The probe itself didn't complete: timed out, exited oddly, or gave
    /// output we couldn't trust. Possibly transient (a loaded server).
    ProbeFailed,
}

impl Unavailable {
    /// Stable code for the frontend (`ConnectResult.persist_unavailable`).
    pub fn code(&self) -> &'static str {
        match self {
            Self::Missing => "missing",
            Self::NoPosixShell => "no_posix_shell",
            Self::ChannelRefused => "channel_refused",
            Self::ToolError => "tool_error",
            Self::ProbeFailed => "probe_failed",
        }
    }
}

/// What the probe found on the host.
#[derive(Debug, PartialEq, Eq)]
pub enum Probe {
    /// Session exists. `attach_id` is the exact target to attach to:
    /// `=NAME` on tmux >= 2.1 (exact-match prefix), plain `NAME` on older
    /// tmux (the probe already proved an exact-name session exists, and
    /// tmux prefers an exact match), `PID.NAME` for screen (screen's
    /// `-r NAME` prefix-matches; the full id is unambiguous).
    Exists { attach_id: String, caps: Caps },
    /// Tool present, no such session — create it.
    Absent { caps: Caps },
    /// Fall back to a plain shell.
    Unavailable(Unavailable),
}

/// What the remote tmux supports. Screen ignores it.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Caps {
    /// `=NAME` exact-match session targets (tmux 2.1+).
    pub exact_target: bool,
    /// `new-session -A` attach-or-create (tmux 1.8+).
    pub new_or_attach: bool,
}

impl Caps {
    /// Assumed when the version can't be read: modern tmux.
    const MODERN: Caps = Caps {
        exact_target: true,
        new_or_attach: true,
    };

    /// From `tmux -V` output: "tmux 3.6", "tmux 1.8", "tmux next-3.7",
    /// "tmux 3.3a", "tmux master". Anything unparseable is MODERN.
    fn from_tmux_version(line: &str) -> Caps {
        let v = line.trim().trim_start_matches("tmux").trim();
        let v = v.trim_start_matches("next-");
        let mut parts = v.split('.');
        let major = parts.next().and_then(|m| m.parse::<u32>().ok());
        let minor = parts.next().map(|m| {
            m.chars()
                .take_while(char::is_ascii_digit)
                .collect::<String>()
                .parse::<u32>()
                .unwrap_or(0)
        });
        match (major, minor) {
            (Some(major), Some(minor)) => Caps {
                exact_target: (major, minor) >= (2, 1),
                new_or_attach: (major, minor) >= (1, 8),
            },
            _ => Caps::MODERN,
        }
    }
}

fn wrap(script: &str) -> String {
    format!("sh -c '{PATH_PREFIX}{script}'")
}

/// Prints `PROBE_MARKER` first. tmux: then its `-V` line; exit 0 = a
/// session with exactly this name exists (`list-sessions | grep -x` works
/// on every tmux, unlike `has-session -t =NAME`), 1 = absent, 127 = tool
/// missing. screen: exit 0 + `PID.NAME` on the last line = exists, 1 =
/// absent, 3 = `screen -ls` itself errored (socket directory missing or
/// wrong mode), 127 = missing.
pub fn probe_command(t: &PersistTarget) -> String {
    let name = &t.name;
    match t.kind {
        PersistKind::Tmux => wrap(&format!(
            "echo {PROBE_MARKER}; \
             command -v tmux >/dev/null 2>&1 || exit 127; \
             tmux -V 2>/dev/null; \
             {} && exit 0; exit 1",
            tmux_exact_exists(name)
        )),
        PersistKind::Screen => wrap(&format!(
            "echo {PROBE_MARKER}; \
             command -v screen >/dev/null 2>&1 || exit 127; \
             screen -wipe >/dev/null 2>&1; \
             o=$(screen -ls 2>&1); \
             case \"$o\" in *\"No Sockets found\"*) exit 1;; \
             *\"Cannot \"*|*\"ermission denied\"*|*\"must have mode\"*|*\"not the owner\"*|*\"is not a directory\"*) exit 3;; esac; \
             s=$(echo \"$o\" | grep -o \"[0-9][0-9]*[.]{name}[[:space:]]\" | head -n 1); \
             [ -n \"$s\" ] && {{ echo $s; exit 0; }}; exit 1"
        )),
    }
}

/// Reattach, detaching any stale client left over from the dead link
/// (plain `-d` on both tools — screen's `-D` would also log the other
/// client's whole SSH session out).
///
/// If the session vanished between the probe and here, the attach fails
/// at once with status 1 and the script creates it instead of the tab
/// closing with a bare "exit 1". The fallback is limited to *exactly* that:
/// status 1 within a few seconds of starting. A normal exit or detach is
/// 0; a client killed by a signal is 128+n; a tmux server that dies (or
/// `kill-server`) later in a long session also exits 1 but well past the
/// window — all of those end the tab and report as usual.
///
/// On tmux without `=` targets the plain name could prefix-match another
/// tab's session (`…-5-1` → `…-5-10`) if ours vanished after the probe, so
/// the exact-name check is repeated right before attaching.
pub fn attach_command(t: &PersistTarget, attach_id: &str, caps: Caps) -> String {
    let name = &t.name;
    let create = match t.kind {
        PersistKind::Tmux => tmux_create(name, caps),
        PersistKind::Screen => format!("screen -S {name}"),
    };
    let attach = match t.kind {
        PersistKind::Tmux => format!("tmux attach-session -d -t {attach_id}"),
        PersistKind::Screen => format!("screen -d -r {attach_id}"),
    };
    let recheck = if t.kind == PersistKind::Tmux && !caps.exact_target {
        format!("{} || exec {create}; ", tmux_exact_exists(name))
    } else {
        String::new()
    };
    wrap(&format!(
        "{recheck}s=$(date +%s); {attach}; r=$?; \
         [ $r -eq 1 ] && [ $(( $(date +%s) - s )) -lt {ATTACH_FAIL_WINDOW_SECS} ] && exec {create}; \
         exit $r"
    ))
}

/// Seconds within which an attach exiting 1 is read as "session not found"
/// (see `attach_command`).
const ATTACH_FAIL_WINDOW_SECS: u32 = 3;

/// `list-sessions | grep -x`: an exact-name test that works on every tmux.
fn tmux_exact_exists(name: &str) -> String {
    format!("tmux list-sessions -F \"#S\" 2>/dev/null | grep -qx {name}")
}

pub fn create_command(t: &PersistTarget, caps: Caps) -> String {
    let name = &t.name;
    match t.kind {
        PersistKind::Tmux => wrap(&format!("exec {}", tmux_create(name, caps))),
        PersistKind::Screen => wrap(&format!("exec screen -S {name}")),
    }
}

/// `new-session -A` attaches if a same-named session appeared since the
/// probe (another connect racing this one) instead of failing with
/// "duplicate session".
fn tmux_create(name: &str, caps: Caps) -> String {
    if caps.new_or_attach {
        format!("tmux new-session -A -s {name}")
    } else {
        format!("tmux new-session -s {name}")
    }
}

/// On tmux without `=` targets, re-check the exact name in the same script
/// so a session that vanished since the probe can't be confused with a
/// prefix-matching neighbour (`kill-session -t …-5-1` ending `…-5-10`).
fn kill_command(t: &PersistTarget, attach_id: &str, caps: Caps) -> String {
    match t.kind {
        PersistKind::Tmux if caps.exact_target => {
            wrap(&format!("tmux kill-session -t {attach_id}"))
        }
        PersistKind::Tmux => wrap(&format!(
            "{} || exit 0; tmux kill-session -t {attach_id}",
            tmux_exact_exists(&t.name)
        )),
        PersistKind::Screen => wrap(&format!("screen -S {attach_id} -X quit")),
    }
}

/// Turn the probe's `(exit status, stdout)` into a decision. The marker
/// must be present; everything after it is ours (a noisy `.bashrc` prints
/// before it). An exit-0 probe whose screen id doesn't validate is
/// `ProbeFailed`, never `Absent` — creating would leave a second
/// same-named session behind.
fn interpret_probe(t: &PersistTarget, status: Option<u32>, stdout: &str) -> Probe {
    let mut lines = stdout.lines().map(str::trim);
    if !lines.any(|l| l == PROBE_MARKER) {
        return Probe::Unavailable(Unavailable::NoPosixShell);
    }
    let ours: Vec<&str> = lines.filter(|l| !l.is_empty()).collect();
    let caps = match t.kind {
        PersistKind::Tmux => ours
            .iter()
            .find(|l| l.starts_with("tmux "))
            .map_or(Caps::MODERN, |l| Caps::from_tmux_version(l)),
        PersistKind::Screen => Caps::MODERN,
    };
    match status {
        Some(0) => match parse_attach_id(t, ours.last().copied().unwrap_or(""), caps) {
            Some(attach_id) => Probe::Exists { attach_id, caps },
            None => Probe::Unavailable(Unavailable::ProbeFailed),
        },
        Some(1) => Probe::Absent { caps },
        Some(3) => Probe::Unavailable(Unavailable::ToolError),
        Some(127) => Probe::Unavailable(Unavailable::Missing),
        _ => Probe::Unavailable(Unavailable::ProbeFailed),
    }
}

/// Validate a probe line into an attach id. Anything that isn't exactly
/// what we expect is rejected rather than spliced into a command line.
fn parse_attach_id(t: &PersistTarget, line: &str, caps: Caps) -> Option<String> {
    match t.kind {
        PersistKind::Tmux if caps.exact_target => Some(format!("={}", t.name)),
        PersistKind::Tmux => Some(t.name.clone()),
        PersistKind::Screen => {
            let id = line.trim();
            let (pid, name) = id.split_once('.')?;
            let pid_ok = !pid.is_empty() && pid.bytes().all(|b| b.is_ascii_digit());
            (pid_ok && name == t.name).then(|| id.to_string())
        }
    }
}

/// Why an exec channel run failed.
#[derive(Debug)]
enum ExecError {
    /// The server refused the session channel (`MaxSessions`).
    Refused(String),
    /// The whole run (open + exec + read) passed its deadline.
    TimedOut,
    /// The channel opened but exec / read failed.
    Other(String),
}

impl From<ExecError> for AppError {
    fn from(e: ExecError) -> Self {
        match e {
            ExecError::Refused(m) | ExecError::Other(m) => AppError::Ssh(m),
            ExecError::TimedOut => AppError::Ssh("remote command timed out".into()),
        }
    }
}

/// How long to wait for a CLOSE we send after giving up on a channel.
const CLOSE_TIMEOUT: Duration = Duration::from_secs(1);

/// Run `command` on a fresh exec channel (no PTY) and return
/// `(exit_status, stdout)`. `None` status = channel ended without one.
/// One deadline covers open + exec + read. On timeout or error the channel
/// is closed explicitly (bounded): russh's `Channel` sends no CLOSE on
/// drop, so an abandoned probe would keep its session slot on the server
/// and break the `MaxSessions 1` retry in `connect_impl`.
async fn run_exec(
    handle: &Handle<ClientHandler>,
    command: &str,
    limit: Duration,
) -> std::result::Result<(Option<u32>, String), ExecError> {
    let deadline = tokio::time::Instant::now() + limit;
    let mut ch = tokio::time::timeout_at(deadline, handle.channel_open_session())
        .await
        .map_err(|_| ExecError::TimedOut)?
        .map_err(|e| ExecError::Refused(e.to_string()))?;
    let run = tokio::time::timeout_at(deadline, async {
        ch.exec(true, command)
            .await
            .map_err(|e| ExecError::Other(e.to_string()))?;
        let mut out: Vec<u8> = Vec::new();
        let mut status = None;
        while let Some(msg) = ch.wait().await {
            match msg {
                ChannelMsg::Data { data } => {
                    let room = EXEC_OUTPUT_MAX.saturating_sub(out.len());
                    out.extend_from_slice(&data[..data.len().min(room)]);
                }
                ChannelMsg::ExitStatus { exit_status } => status = Some(exit_status),
                ChannelMsg::Close => break,
                _ => {}
            }
        }
        Ok::<_, ExecError>((status, String::from_utf8_lossy(&out).into_owned()))
    })
    .await;
    let failed = match run {
        Ok(Ok(v)) => return Ok(v),
        Ok(Err(e)) => e,
        Err(_) => ExecError::TimedOut,
    };
    let _ = tokio::time::timeout(CLOSE_TIMEOUT, ch.close()).await;
    Err(failed)
}

/// Find out whether the target session exists. Never fails the connect:
/// any error degrades to `Unavailable` (plain shell + notice).
pub async fn probe(handle: &Handle<ClientHandler>, t: &PersistTarget) -> Probe {
    let tool = t.kind.tool();
    match run_exec(handle, &probe_command(t), PROBE_TIMEOUT).await {
        Ok((status, stdout)) => {
            let found = interpret_probe(t, status, &stdout);
            if let Probe::Unavailable(reason) = &found {
                let code = status.map_or(-1, i64::from);
                let why = reason.code();
                log_redacted!(info, "ssh.persist.unavailable", tool = %tool, reason = %why, status = code);
            }
            found
        }
        Err(e) => {
            let reason = match &e {
                ExecError::Refused(_) => Unavailable::ChannelRefused,
                ExecError::TimedOut | ExecError::Other(_) => Unavailable::ProbeFailed,
            };
            // `log_redacted!` only accepts bare idents after `%`.
            let err = format!("{e:?}");
            log_redacted!(warn, "ssh.persist.probe_failed", tool = %tool, error = %err);
            Probe::Unavailable(reason)
        }
    }
}

/// End the remote session (tab context menu → "End remote session").
/// Always probes first for the exact current id: a remembered id could be
/// stale, and on tmux without `=` targets a stale plain name would
/// prefix-match a *different* tab's session (the kill script re-checks the
/// exact name too). The attached client then exits and the tab closes
/// normally.
pub async fn kill(handle: &Handle<ClientHandler>, t: &PersistTarget) -> Result<()> {
    let (attach_id, caps) = match probe(handle, t).await {
        Probe::Exists { attach_id, caps } => (attach_id, caps),
        // Already gone — nothing to end.
        Probe::Absent { .. } => return Ok(()),
        Probe::Unavailable(_) => {
            return Err(AppError::Ssh(format!(
                "could not reach {} on this host",
                t.kind.tool()
            )));
        }
    };
    match run_exec(handle, &kill_command(t, &attach_id, caps), KILL_TIMEOUT).await? {
        (Some(0), _) => Ok(()),
        (status, _) => Err(AppError::Ssh(format!(
            "could not end remote session (exit {})",
            status.map_or(-1, i64::from)
        ))),
    }
}

/// One-line notice shown in the terminal when falling back to a plain shell.
pub fn unavailable_notice(kind: PersistKind, why: &Unavailable) -> Vec<u8> {
    let tool = kind.tool();
    let msg = match why {
        Unavailable::Missing => format!("{tool} not found on this host"),
        Unavailable::NoPosixShell => format!("this host's login shell can't run {tool}"),
        Unavailable::ChannelRefused => {
            format!("server allows only one session channel, could not check for {tool}")
        }
        Unavailable::ToolError => format!("{tool} on this host can't start sessions"),
        Unavailable::ProbeFailed => format!("could not check for {tool} on this host"),
    };
    format!("\x1b[33mezTerm: {msg} - using a normal shell (session will not persist).\x1b[0m\r\n")
        .into_bytes()
}

#[cfg(test)]
mod tests {
    use super::*;

    const IID: &str = "0a1b2c3d";

    fn t(kind: PersistKind) -> PersistTarget {
        PersistTarget::new(kind, IID, 5, 1).unwrap()
    }

    #[test]
    fn parse_kinds() {
        assert_eq!(PersistKind::parse("off").unwrap(), None);
        assert_eq!(PersistKind::parse("tmux").unwrap(), Some(PersistKind::Tmux));
        assert_eq!(
            PersistKind::parse("screen").unwrap(),
            Some(PersistKind::Screen)
        );
        assert!(PersistKind::parse("zellij").is_err());
        assert!(PersistKind::parse("").is_err());
    }

    #[test]
    fn name_is_built_from_validated_parts() {
        assert_eq!(t(PersistKind::Tmux).name, "ezterm-0a1b2c3d-5-1");
        assert!(PersistTarget::new(PersistKind::Tmux, IID, 5, 0).is_err());
        assert!(PersistTarget::new(PersistKind::Tmux, IID, 5, MAX_SLOT + 1).is_err());
        assert!(PersistTarget::new(PersistKind::Tmux, IID, 0, 1).is_err());
        assert!(PersistTarget::new(PersistKind::Tmux, IID, -3, 1).is_err());
        for bad in [
            "",
            "0A1B2C3D",
            "0a1b2c3",
            "0a1b2c3d4",
            "0a1b2c3;",
            "0a1b 2c3",
        ] {
            assert!(
                PersistTarget::new(PersistKind::Tmux, bad, 5, 1).is_err(),
                "{bad:?}"
            );
        }
    }

    #[tokio::test]
    async fn install_id_is_minted_once_and_local_only() {
        let p = sqlx::sqlite::SqlitePoolOptions::new()
            .max_connections(1)
            .connect("sqlite::memory:")
            .await
            .unwrap();
        crate::db::init_pool_from_pool(&p).await.unwrap();
        let a = install_id(&p).await.unwrap();
        assert!(valid_install_id(&a));
        assert_eq!(install_id(&p).await.unwrap(), a);
        // Excluded from list_all → never exported to backups / sync.
        let all = crate::db::settings::list_all(&p).await.unwrap();
        assert!(all.iter().all(|(k, _)| k != INSTALL_ID_KEY));
        // A corrupted value is replaced, not used.
        crate::db::settings::set(&p, INSTALL_ID_KEY, "bad;id")
            .await
            .unwrap();
        let b = install_id(&p).await.unwrap();
        assert!(valid_install_id(&b));
    }

    const M: Caps = Caps::MODERN;
    const OLD: Caps = Caps {
        exact_target: false,
        new_or_attach: true,
    };
    const ANCIENT: Caps = Caps {
        exact_target: false,
        new_or_attach: false,
    };

    /// Every command must survive being parsed by bash, fish and csh as
    /// one single-quoted `sh -c` argument: no nested `'`, no `!` (csh
    /// history), no `\\` or `\'` (fish single-quote escapes).
    #[test]
    fn commands_are_shell_portable() {
        for kind in [PersistKind::Tmux, PersistKind::Screen] {
            let tg = t(kind);
            let id = match kind {
                PersistKind::Tmux => "=ezterm-0a1b2c3d-5-1",
                PersistKind::Screen => "123.ezterm-0a1b2c3d-5-1",
            };
            for caps in [M, OLD, ANCIENT] {
                for cmd in [
                    probe_command(&tg),
                    attach_command(&tg, id, caps),
                    create_command(&tg, caps),
                    kill_command(&tg, id, caps),
                ] {
                    let inner = cmd
                        .strip_prefix("sh -c '")
                        .and_then(|c| c.strip_suffix('\''))
                        .unwrap_or_else(|| panic!("not wrapped: {cmd}"));
                    assert!(!inner.contains('\''), "nested quote: {cmd}");
                    assert!(!inner.contains('!'), "bang: {cmd}");
                    assert!(!inner.contains('\\'), "backslash: {cmd}");
                }
            }
        }
    }

    #[test]
    fn tmux_caps_follow_version() {
        assert_eq!(Caps::from_tmux_version("tmux 3.6"), M);
        assert_eq!(Caps::from_tmux_version("tmux 3.3a"), M);
        assert_eq!(Caps::from_tmux_version("tmux next-3.7"), M);
        assert_eq!(Caps::from_tmux_version("tmux 2.1"), M);
        assert_eq!(Caps::from_tmux_version("tmux 2.0"), OLD);
        assert_eq!(Caps::from_tmux_version("tmux 1.8"), OLD);
        assert_eq!(Caps::from_tmux_version("tmux 1.6"), ANCIENT);
        // Unreadable → assume a modern tmux.
        assert_eq!(Caps::from_tmux_version("tmux master"), M);
        assert_eq!(Caps::from_tmux_version(""), M);
    }

    #[test]
    fn attach_detaches_without_logging_out_and_falls_back_only_on_fast_status_1() {
        let tm = attach_command(&t(PersistKind::Tmux), "=x", M);
        assert!(tm.contains("tmux attach-session -d -t =x; r=$?;"));
        assert!(tm.contains(
            "[ $r -eq 1 ] && [ $(( $(date +%s) - s )) -lt 3 ] && exec tmux new-session -A -s ezterm-0a1b2c3d-5-1; exit $r"
        ));
        // Modern tmux: no pre-check needed (= target is exact).
        assert!(!tm.contains("list-sessions"));
        let sc = attach_command(&t(PersistKind::Screen), "1.x", M);
        assert!(sc.contains("screen -d -r 1.x; r=$?;"));
        assert!(sc.contains("exec screen -S ezterm-0a1b2c3d-5-1; exit $r"));
        assert!(!sc.contains(" -D "));
        // Old tmux: exact-name re-check right before attaching; < 1.8 has no -A.
        let old = attach_command(&t(PersistKind::Tmux), "ezterm-0a1b2c3d-5-1", ANCIENT);
        assert!(old.contains(
            "grep -qx ezterm-0a1b2c3d-5-1 || exec tmux new-session -s ezterm-0a1b2c3d-5-1; "
        ));
    }

    #[test]
    fn kill_rechecks_exact_name_on_old_tmux() {
        let tg = t(PersistKind::Tmux);
        assert!(
            kill_command(&tg, "=ezterm-0a1b2c3d-5-1", M)
                .ends_with("tmux kill-session -t =ezterm-0a1b2c3d-5-1'")
        );
        let old = kill_command(&tg, "ezterm-0a1b2c3d-5-1", OLD);
        assert!(old.contains(
            "grep -qx ezterm-0a1b2c3d-5-1 || exit 0; tmux kill-session -t ezterm-0a1b2c3d-5-1"
        ));
    }

    #[test]
    fn unavailable_codes_are_stable() {
        let all = [
            (Unavailable::Missing, "missing"),
            (Unavailable::NoPosixShell, "no_posix_shell"),
            (Unavailable::ChannelRefused, "channel_refused"),
            (Unavailable::ToolError, "tool_error"),
            (Unavailable::ProbeFailed, "probe_failed"),
        ];
        for (u, c) in all {
            assert_eq!(u.code(), c);
        }
    }

    #[test]
    fn create_attaches_if_a_racing_session_exists() {
        assert!(
            create_command(&t(PersistKind::Tmux), M)
                .contains("exec tmux new-session -A -s ezterm-0a1b2c3d-5-1")
        );
        assert!(
            create_command(&t(PersistKind::Tmux), ANCIENT)
                .contains("exec tmux new-session -s ezterm-0a1b2c3d-5-1")
        );
    }

    #[test]
    fn tmux_probe_uses_exact_name_listing() {
        let cmd = probe_command(&t(PersistKind::Tmux));
        assert!(
            cmd.contains(
                "tmux list-sessions -F \"#S\" 2>/dev/null | grep -qx ezterm-0a1b2c3d-5-1 "
            )
        );
        assert!(!cmd.contains("has-session"));
    }

    #[test]
    fn tmux_probe_interpretation() {
        let tg = t(PersistKind::Tmux);
        let modern = format!("{PROBE_MARKER}\ntmux 3.6\n");
        assert_eq!(
            interpret_probe(&tg, Some(0), &modern),
            Probe::Exists {
                attach_id: "=ezterm-0a1b2c3d-5-1".into(),
                caps: M
            }
        );
        // tmux 1.9: no `=` targets, plain exact name instead.
        let old = format!("{PROBE_MARKER}\ntmux 1.9\n");
        assert_eq!(
            interpret_probe(&tg, Some(0), &old),
            Probe::Exists {
                attach_id: "ezterm-0a1b2c3d-5-1".into(),
                caps: OLD
            }
        );
        assert_eq!(
            interpret_probe(&tg, Some(1), &modern),
            Probe::Absent { caps: M }
        );
        assert_eq!(
            interpret_probe(&tg, Some(127), &modern),
            Probe::Unavailable(Unavailable::Missing)
        );
        for bad in [Some(2), None] {
            assert_eq!(
                interpret_probe(&tg, bad, &modern),
                Probe::Unavailable(Unavailable::ProbeFailed)
            );
        }
    }

    /// cmd.exe / PowerShell never run `sh`, so no marker: exit 1 from
    /// "'sh' is not recognized" must not be read as "absent → create".
    #[test]
    fn missing_marker_is_probe_failure() {
        let tg = t(PersistKind::Tmux);
        let cmd_exe = "'sh' is not recognized as an internal or external command\r\n";
        assert_eq!(
            interpret_probe(&tg, Some(1), cmd_exe),
            Probe::Unavailable(Unavailable::NoPosixShell)
        );
        assert_eq!(
            interpret_probe(&tg, Some(0), ""),
            Probe::Unavailable(Unavailable::NoPosixShell)
        );
    }

    #[test]
    fn screen_probe_takes_last_line_after_marker() {
        let tg = t(PersistKind::Screen);
        // A chatty .bashrc before and blank lines after.
        let out =
            format!("Welcome!\nlast login: x\n{PROBE_MARKER}\n4242.ezterm-0a1b2c3d-5-1\t\n\n");
        assert_eq!(
            interpret_probe(&tg, Some(0), &out),
            Probe::Exists {
                attach_id: "4242.ezterm-0a1b2c3d-5-1".into(),
                caps: M
            }
        );
        // Exit 0 with an id that doesn't validate → failure, not create.
        let junk = format!("{PROBE_MARKER}\n4242.ezterm-0a1b2c3d-5-10\n");
        assert_eq!(
            interpret_probe(&tg, Some(0), &junk),
            Probe::Unavailable(Unavailable::ProbeFailed)
        );
        // `screen -ls` itself failed (socket dir unusable) → not "absent".
        let ok = format!("{PROBE_MARKER}\n");
        assert_eq!(
            interpret_probe(&tg, Some(3), &ok),
            Probe::Unavailable(Unavailable::ToolError)
        );
    }

    /// Run the real probe script under `sh` against fake `screen` / `tmux`
    /// binaries, so the shell logic (case patterns, grep, exit codes) is
    /// tested, not just the string. Skipped where `sh` isn't available.
    #[cfg(unix)]
    fn run_probe_with_fake(kind: PersistKind, fake_body: &str) -> Option<(i32, String)> {
        use std::os::unix::fs::PermissionsExt;
        let dir = tempfile::tempdir().ok()?;
        let tool = dir.path().join(kind.tool());
        std::fs::write(&tool, format!("#!/bin/sh\n{fake_body}\n")).ok()?;
        std::fs::set_permissions(&tool, std::fs::Permissions::from_mode(0o755)).ok()?;
        let cmd = probe_command(&t(kind));
        let script = cmd
            .strip_prefix("sh -c '")
            .and_then(|c| c.strip_suffix('\''))?
            .to_string();
        let path = format!("{}:/usr/bin:/bin", dir.path().display());
        let out = std::process::Command::new("sh")
            .args(["-c", &script])
            .env("PATH", path)
            .output()
            .ok()?;
        Some((
            out.status.code().unwrap_or(-1),
            String::from_utf8_lossy(&out.stdout).into_owned(),
        ))
    }

    #[cfg(unix)]
    #[test]
    fn screen_probe_script_against_real_shell() {
        let listing = "There are screens on:\n\
            \t9001.ezterm-0a1b2c3d-5-10\t(11/03/26 16:18:52)\t(Detached)\n\
            \t4242.ezterm-0a1b2c3d-5-1\t(11/03/26 16:18:53)\t(Attached)\n\
            2 Sockets in /run/screen/S-me.";
        let fake = |ls: &str| {
            format!("case \"$1\" in -wipe) exit 0;; -ls) printf \"%s\\n\" \"{ls}\"; exit 1;; esac")
        };
        let Some((code, out)) = run_probe_with_fake(PersistKind::Screen, &fake(listing)) else {
            return;
        };
        assert_eq!(code, 0, "{out}");
        assert_eq!(
            interpret_probe(&t(PersistKind::Screen), Some(0), &out),
            Probe::Exists {
                attach_id: "4242.ezterm-0a1b2c3d-5-1".into(),
                caps: M
            }
        );
        let (code, _) = run_probe_with_fake(
            PersistKind::Screen,
            &fake("No Sockets found in /run/screen/S-me."),
        )
        .unwrap();
        assert_eq!(code, 1);
        for msg in [
            "Directory /run/screen must have mode 777.",
            "Cannot make directory /run/screen: Read-only file system",
            "Cannot access /run/screen: Permission denied",
            "You are not the owner of /run/screen/S-me.",
            "/run/screen/S-me is not a directory.",
        ] {
            let (code, _) = run_probe_with_fake(PersistKind::Screen, &fake(msg)).unwrap();
            assert_eq!(code, 3, "{msg}");
        }
        // Only the prefix-colliding neighbour exists → absent.
        let (code, _) = run_probe_with_fake(
            PersistKind::Screen,
            &fake("There is a screen on:\n\t9001.ezterm-0a1b2c3d-5-10\t(Detached)"),
        )
        .unwrap();
        assert_eq!(code, 1);
    }

    #[cfg(unix)]
    #[test]
    fn tmux_probe_script_against_real_shell() {
        let fake = |sessions: &str| {
            format!(
                "case \"$1\" in -V) echo \"tmux 1.9\";; list-sessions) printf \"%s\\n\" {sessions};; esac"
            )
        };
        let Some((code, out)) = run_probe_with_fake(
            PersistKind::Tmux,
            &fake("ezterm-0a1b2c3d-5-10 ezterm-0a1b2c3d-5-1"),
        ) else {
            return;
        };
        assert_eq!(code, 0);
        assert_eq!(
            interpret_probe(&t(PersistKind::Tmux), Some(0), &out),
            Probe::Exists {
                attach_id: "ezterm-0a1b2c3d-5-1".into(),
                caps: OLD
            }
        );
        // Prefix neighbour only → absent (grep -x is exact).
        let (code, _) =
            run_probe_with_fake(PersistKind::Tmux, &fake("ezterm-0a1b2c3d-5-10")).unwrap();
        assert_eq!(code, 1);
    }

    #[test]
    fn notice_wording_matches_reason() {
        let m = String::from_utf8(unavailable_notice(PersistKind::Tmux, &Unavailable::Missing))
            .unwrap();
        assert!(m.contains("tmux not found"));
        let f = String::from_utf8(unavailable_notice(
            PersistKind::Screen,
            &Unavailable::ProbeFailed,
        ))
        .unwrap();
        assert!(f.contains("could not check for screen"));
    }

    #[test]
    fn slot_limit_message_is_readable() {
        let e = PersistTarget::new(PersistKind::Tmux, IID, 5, MAX_SLOT + 1).unwrap_err();
        assert!(
            e.to_string()
                .contains("too many tabs open for this session")
        );
    }
}
