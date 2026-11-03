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

/// The probe runs on every connect / reconnect attempt and is one
/// `has-session` / `screen -ls`, so keep the bound tight.
const PROBE_TIMEOUT: Duration = Duration::from_secs(4);
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
            return Err(AppError::Validation("persist_slot out of range".into()));
        }
        Ok(Self {
            kind,
            name: format!("ezterm-{install_id}-{session_id}-{slot}"),
        })
    }

    /// Exact attach target when it can be derived without asking the
    /// host: always for tmux (`=NAME` is an exact match), never for
    /// screen (needs the `PID.` prefix from `screen -ls`).
    pub fn static_attach_id(&self) -> Option<String> {
        match self.kind {
            PersistKind::Tmux => Some(format!("={}", self.name)),
            PersistKind::Screen => None,
        }
    }
}

/// A live tab's binding to its remote session, kept on the registry entry
/// so "End remote session" doesn't have to probe again.
#[derive(Clone, Debug)]
pub struct PersistBinding {
    pub target: PersistTarget,
    /// Exact id from connect time — tmux `=NAME`, or screen `PID.NAME`
    /// when we attached to an existing one. `None` for a screen session
    /// we just created (its PID isn't known until listed).
    pub attach_id: Option<String>,
}

/// Why the tool couldn't be used — drives the wording of the notice.
#[derive(Debug, PartialEq, Eq)]
pub enum Unavailable {
    /// Probe ran in sh and reported the tool isn't on PATH.
    Missing,
    /// Probe didn't run cleanly: timeout, channel refused (MaxSessions),
    /// no POSIX sh, or an unexpected exit code.
    ProbeFailed,
}

/// What the probe found on the host.
#[derive(Debug, PartialEq, Eq)]
pub enum Probe {
    /// Session exists. `attach_id` is the exact target to attach to:
    /// `=NAME` for tmux (exact-match prefix), `PID.NAME` for screen
    /// (screen's `-r NAME` prefix-matches; the full id is unambiguous).
    Exists { attach_id: String },
    /// Tool present, no such session — create it.
    Absent,
    /// Fall back to a plain shell.
    Unavailable(Unavailable),
}

fn wrap(script: &str) -> String {
    format!("sh -c '{PATH_PREFIX}{script}'")
}

/// Prints `PROBE_MARKER` first, then exits 0 = exists (screen also prints
/// `PID.NAME` on the last line), 1 = absent, 127 = tool missing.
pub fn probe_command(t: &PersistTarget) -> String {
    let name = &t.name;
    match t.kind {
        PersistKind::Tmux => wrap(&format!(
            "echo {PROBE_MARKER}; \
             command -v tmux >/dev/null 2>&1 || exit 127; \
             tmux has-session -t ={name} 2>/dev/null && exit 0; exit 1"
        )),
        PersistKind::Screen => wrap(&format!(
            "echo {PROBE_MARKER}; \
             command -v screen >/dev/null 2>&1 || exit 127; \
             screen -wipe >/dev/null 2>&1; \
             s=$(screen -ls 2>/dev/null | grep -o \"[0-9][0-9]*[.]{name}[[:space:]]\" | head -n 1); \
             [ -n \"$s\" ] && {{ echo $s; exit 0; }}; exit 1"
        )),
    }
}

/// Reattach, detaching any stale client left over from the dead link.
/// Plain detach (`-d`) on both tools — screen's `-D` would also log the
/// other client's whole SSH session out.
pub fn attach_command(t: &PersistTarget, attach_id: &str) -> String {
    match t.kind {
        PersistKind::Tmux => wrap(&format!("exec tmux attach-session -d -t {attach_id}")),
        PersistKind::Screen => wrap(&format!("exec screen -d -r {attach_id}")),
    }
}

pub fn create_command(t: &PersistTarget) -> String {
    let name = &t.name;
    match t.kind {
        PersistKind::Tmux => wrap(&format!("exec tmux new-session -s {name}")),
        PersistKind::Screen => wrap(&format!("exec screen -S {name}")),
    }
}

fn kill_command(t: &PersistTarget, attach_id: &str) -> String {
    match t.kind {
        PersistKind::Tmux => wrap(&format!("tmux kill-session -t {attach_id}")),
        PersistKind::Screen => wrap(&format!("screen -S {attach_id} -X quit")),
    }
}

/// Turn the probe's `(exit status, stdout)` into a decision. The marker
/// must be present; for screen the id is the last non-empty line after it,
/// so anything a noisy `.bashrc` prints first is ignored. An exit-0 probe
/// whose id doesn't validate is `ProbeFailed`, never `Absent` — creating
/// would leave a second same-named screen session behind.
fn interpret_probe(t: &PersistTarget, status: Option<u32>, stdout: &str) -> Probe {
    let mut lines = stdout.lines().map(str::trim);
    if !lines.any(|l| l == PROBE_MARKER) {
        return Probe::Unavailable(Unavailable::ProbeFailed);
    }
    let last = lines.rfind(|l| !l.is_empty()).unwrap_or("");
    match status {
        Some(0) => match parse_attach_id(t, last) {
            Some(attach_id) => Probe::Exists { attach_id },
            None => Probe::Unavailable(Unavailable::ProbeFailed),
        },
        Some(1) => Probe::Absent,
        Some(127) => Probe::Unavailable(Unavailable::Missing),
        _ => Probe::Unavailable(Unavailable::ProbeFailed),
    }
}

/// Validate a probe line into an attach id. Anything that isn't exactly
/// what we expect is rejected rather than spliced into a command line.
fn parse_attach_id(t: &PersistTarget, line: &str) -> Option<String> {
    if let Some(id) = t.static_attach_id() {
        return Some(id);
    }
    let id = line.trim();
    let (pid, name) = id.split_once('.')?;
    let pid_ok = !pid.is_empty() && pid.bytes().all(|b| b.is_ascii_digit());
    (pid_ok && name == t.name).then(|| id.to_string())
}

/// Run `command` on a fresh exec channel (no PTY) and return
/// `(exit_status, stdout)`. `None` status = channel ended without one.
async fn run_exec(
    handle: &Handle<ClientHandler>,
    command: &str,
    limit: Duration,
) -> Result<(Option<u32>, String)> {
    let fut = async {
        let mut ch = handle
            .channel_open_session()
            .await
            .map_err(|e| AppError::Ssh(e.to_string()))?;
        ch.exec(true, command)
            .await
            .map_err(|e| AppError::Ssh(e.to_string()))?;
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
        Ok((status, String::from_utf8_lossy(&out).into_owned()))
    };
    tokio::time::timeout(limit, fut)
        .await
        .map_err(|_| AppError::Ssh("remote command timed out".into()))?
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
                let why = format!("{reason:?}");
                log_redacted!(info, "ssh.persist.unavailable", tool = %tool, reason = %why, status = code);
            }
            found
        }
        Err(e) => {
            // `log_redacted!` only accepts bare idents after `%`.
            let err = e;
            log_redacted!(warn, "ssh.persist.probe_failed", tool = %tool, error = %err);
            Probe::Unavailable(Unavailable::ProbeFailed)
        }
    }
}

/// End the remote session (tab context menu → "End remote session").
/// Uses the id recorded at connect time when there is one; probes only for
/// a screen session we created (PID unknown) or if the recorded id has gone
/// stale. The attached client then exits and the tab closes normally.
pub async fn kill(handle: &Handle<ClientHandler>, b: &PersistBinding) -> Result<()> {
    let t = &b.target;
    if let Some(id) = &b.attach_id
        && let (Some(0), _) = run_exec(handle, &kill_command(t, id), KILL_TIMEOUT).await?
    {
        return Ok(());
    }
    let attach_id = match probe(handle, t).await {
        Probe::Exists { attach_id } => attach_id,
        // Already gone — nothing to end.
        Probe::Absent => return Ok(()),
        Probe::Unavailable(_) => {
            return Err(AppError::Ssh(format!(
                "could not reach {} on this host",
                t.kind.tool()
            )));
        }
    };
    match run_exec(handle, &kill_command(t, &attach_id), KILL_TIMEOUT).await? {
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
            for cmd in [
                probe_command(&tg),
                attach_command(&tg, id),
                create_command(&tg),
                kill_command(&tg, id),
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

    #[test]
    fn attach_detaches_without_logging_out() {
        assert!(attach_command(&t(PersistKind::Tmux), "=x").contains("attach-session -d -t =x"));
        let s = attach_command(&t(PersistKind::Screen), "1.x");
        assert!(s.contains("screen -d -r 1.x"));
        assert!(!s.contains(" -D "));
    }

    #[test]
    fn tmux_probe_interpretation() {
        let tg = t(PersistKind::Tmux);
        assert!(probe_command(&tg).contains("has-session -t =ezterm-0a1b2c3d-5-1 "));
        let ok = format!("{PROBE_MARKER}\n");
        assert_eq!(
            interpret_probe(&tg, Some(0), &ok),
            Probe::Exists {
                attach_id: "=ezterm-0a1b2c3d-5-1".into()
            }
        );
        assert_eq!(interpret_probe(&tg, Some(1), &ok), Probe::Absent);
        assert_eq!(
            interpret_probe(&tg, Some(127), &ok),
            Probe::Unavailable(Unavailable::Missing)
        );
        assert_eq!(
            interpret_probe(&tg, Some(2), &ok),
            Probe::Unavailable(Unavailable::ProbeFailed)
        );
        assert_eq!(
            interpret_probe(&tg, None, &ok),
            Probe::Unavailable(Unavailable::ProbeFailed)
        );
    }

    /// cmd.exe / PowerShell never run `sh`, so no marker: exit 1 from
    /// "'sh' is not recognized" must not be read as "absent → create".
    #[test]
    fn missing_marker_is_probe_failure() {
        let tg = t(PersistKind::Tmux);
        let cmd_exe = "'sh' is not recognized as an internal or external command\r\n";
        assert_eq!(
            interpret_probe(&tg, Some(1), cmd_exe),
            Probe::Unavailable(Unavailable::ProbeFailed)
        );
        assert_eq!(
            interpret_probe(&tg, Some(0), ""),
            Probe::Unavailable(Unavailable::ProbeFailed)
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
                attach_id: "4242.ezterm-0a1b2c3d-5-1".into()
            }
        );
        // Exit 0 with an id that doesn't validate → failure, not create.
        let junk = format!("{PROBE_MARKER}\n4242.ezterm-0a1b2c3d-5-10\n");
        assert_eq!(
            interpret_probe(&tg, Some(0), &junk),
            Probe::Unavailable(Unavailable::ProbeFailed)
        );
    }

    /// The grep in the screen probe, run against real `screen -ls` output
    /// (tab-separated, attached + detached + a prefix-colliding name).
    #[test]
    fn screen_ls_grep_matches_only_exact_name() {
        let tg = t(PersistKind::Screen);
        let cmd = probe_command(&tg);
        let start = cmd.find("grep -o \"").unwrap() + "grep -o \"".len();
        let pattern = &cmd[start..start + cmd[start..].find('"').unwrap()];
        let ls = "There are screens on:\n\
                  \t9001.ezterm-0a1b2c3d-5-10\t(11/03/26 16:18:52)\t(Detached)\n\
                  \t4242.ezterm-0a1b2c3d-5-1\t(11/03/26 16:18:53)\t(Attached)\n\
                  2 Sockets in /run/screen/S-me.\n";
        let out = std::process::Command::new("grep")
            .args(["-o", pattern])
            .stdin(std::process::Stdio::piped())
            .stdout(std::process::Stdio::piped())
            .spawn()
            .and_then(|mut c| {
                use std::io::Write;
                c.stdin.take().unwrap().write_all(ls.as_bytes())?;
                c.wait_with_output()
            });
        // grep isn't on every Windows CI runner; the pattern is still
        // covered by the string checks above there.
        let Ok(out) = out else { return };
        let got = String::from_utf8_lossy(&out.stdout);
        assert_eq!(got.trim(), "4242.ezterm-0a1b2c3d-5-1");
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
}
