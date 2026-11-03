//! Persistent remote sessions: run the SSH tab's shell inside a remote
//! `tmux` / `screen` session so a dropped link (or a closed tab) leaves the
//! work running, and reconnecting reattaches to it.
//!
//! Every command string built here is a fixed template plus a session name
//! assembled from two integers — no user-supplied text ever reaches the
//! remote command line. Commands are wrapped in `sh -c '…'` and contain no
//! `'`, `!` or `\\` so they parse the same under bash, zsh, dash, fish and
//! csh/tcsh login shells (sshd hands exec requests to the user's shell).
//!
//! See docs/superpowers/specs/2026-11-03-persistent-sessions-design.md.

use std::time::Duration;

use russh::ChannelMsg;
use russh::client::Handle;

use crate::error::{AppError, Result};
use crate::log_redacted;
use crate::ssh::client::ClientHandler;

/// Highest per-tab slot accepted from the frontend. Slots are the lowest
/// free integer per saved session, so 99 open tabs of one session is
/// already far past any real use.
pub const MAX_SLOT: u32 = 99;

/// Probe / kill exec channels are tiny; bound them so a wedged server
/// can't hang the connect.
const EXEC_TIMEOUT: Duration = Duration::from_secs(10);
/// Cap on captured probe stdout — the screen probe prints one short id.
const EXEC_OUTPUT_MAX: usize = 4_096;

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

/// The remote session a tab is bound to.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PersistTarget {
    pub kind: PersistKind,
    /// `ezterm-<session_id>-<slot>` — only `[a-z0-9-]`.
    pub name: String,
}

impl PersistTarget {
    pub fn new(kind: PersistKind, session_id: i64, slot: u32) -> Result<Self> {
        if session_id <= 0 {
            return Err(AppError::Validation("invalid session id".into()));
        }
        if slot == 0 || slot > MAX_SLOT {
            return Err(AppError::Validation("persist_slot out of range".into()));
        }
        Ok(Self {
            kind,
            name: format!("ezterm-{session_id}-{slot}"),
        })
    }
}

/// What the probe found on the host.
#[derive(Debug, PartialEq, Eq)]
pub enum Probe {
    /// Session exists. `attach_id` is the exact target to attach to:
    /// `=NAME` for tmux (exact-match prefix), `PID.NAME` for screen
    /// (screen's `-r NAME` prefix-matches, so `ezterm-5-1` would also hit
    /// `ezterm-5-10`; the full id is unambiguous).
    Exists { attach_id: String },
    /// Tool present, no such session — create it.
    Absent,
    /// Tool missing (or the probe failed) — fall back to a plain shell.
    Unavailable,
}

fn wrap(script: &str) -> String {
    format!("sh -c '{PATH_PREFIX}{script}'")
}

/// Exit 0 = exists (screen also prints `PID.NAME`), 1 = absent,
/// 127 = tool missing.
pub fn probe_command(t: &PersistTarget) -> String {
    let name = &t.name;
    match t.kind {
        PersistKind::Tmux => wrap(&format!(
            "command -v tmux >/dev/null 2>&1 || exit 127; \
             tmux has-session -t ={name} 2>/dev/null && exit 0; exit 1"
        )),
        PersistKind::Screen => wrap(&format!(
            "command -v screen >/dev/null 2>&1 || exit 127; \
             screen -wipe >/dev/null 2>&1; \
             s=$(screen -ls 2>/dev/null | grep -o \"[0-9][0-9]*[.]{name}[[:space:]]\" | head -n 1); \
             [ -n \"$s\" ] && {{ echo $s; exit 0; }}; exit 1"
        )),
    }
}

/// Reattach, kicking any stale client left over from the dead link.
pub fn attach_command(t: &PersistTarget, attach_id: &str) -> String {
    match t.kind {
        PersistKind::Tmux => wrap(&format!("exec tmux attach-session -d -t {attach_id}")),
        PersistKind::Screen => wrap(&format!("exec screen -D -r {attach_id}")),
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

/// Validate the probe's stdout into an attach id. Anything that isn't
/// exactly what we expect is treated as "absent" rather than spliced into
/// a command line.
fn parse_attach_id(t: &PersistTarget, stdout: &str) -> Option<String> {
    match t.kind {
        PersistKind::Tmux => Some(format!("={}", t.name)),
        PersistKind::Screen => {
            let id = stdout.trim();
            let (pid, name) = id.split_once('.')?;
            let pid_ok = !pid.is_empty() && pid.bytes().all(|b| b.is_ascii_digit());
            (pid_ok && name == t.name).then(|| id.to_string())
        }
    }
}

/// Run `command` on a fresh exec channel (no PTY) and return
/// `(exit_status, stdout)`. `None` status = channel ended without one.
async fn run_exec(handle: &Handle<ClientHandler>, command: &str) -> Result<(Option<u32>, String)> {
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
    tokio::time::timeout(EXEC_TIMEOUT, fut)
        .await
        .map_err(|_| AppError::Ssh("remote command timed out".into()))?
}

/// Find out whether the target session exists. Never fails the connect:
/// any error degrades to `Unavailable` (plain shell + notice).
pub async fn probe(handle: &Handle<ClientHandler>, t: &PersistTarget) -> Probe {
    match run_exec(handle, &probe_command(t)).await {
        Ok((Some(0), stdout)) => match parse_attach_id(t, &stdout) {
            Some(attach_id) => Probe::Exists { attach_id },
            None => Probe::Absent,
        },
        Ok((Some(1), _)) => Probe::Absent,
        Ok((status, _)) => {
            let tool = t.kind.tool();
            let code = status.map_or(-1, i64::from);
            log_redacted!(info, "ssh.persist.unavailable", tool = %tool, status = code);
            Probe::Unavailable
        }
        Err(e) => {
            let tool = t.kind.tool();
            let err = e;
            log_redacted!(warn, "ssh.persist.probe_failed", tool = %tool, error = %err);
            Probe::Unavailable
        }
    }
}

/// End the remote session (tab context menu → "End remote session").
/// The attached client then exits and the tab's channel closes normally.
pub async fn kill(handle: &Handle<ClientHandler>, t: &PersistTarget) -> Result<()> {
    let attach_id = match probe(handle, t).await {
        Probe::Exists { attach_id } => attach_id,
        // Already gone — nothing to end.
        Probe::Absent => return Ok(()),
        Probe::Unavailable => {
            return Err(AppError::Ssh(format!(
                "{} is not available on this host",
                t.kind.tool()
            )));
        }
    };
    match run_exec(handle, &kill_command(t, &attach_id)).await? {
        (Some(0), _) => Ok(()),
        (status, _) => Err(AppError::Ssh(format!(
            "could not end remote session (exit {})",
            status.map_or(-1, i64::from)
        ))),
    }
}

/// One-line notice shown in the terminal when the tool is missing.
pub fn unavailable_notice(kind: PersistKind) -> Vec<u8> {
    format!(
        "\x1b[33mezTerm: {} not found on this host - using a normal shell (session will not persist).\x1b[0m\r\n",
        kind.tool()
    )
    .into_bytes()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn t(kind: PersistKind) -> PersistTarget {
        PersistTarget::new(kind, 5, 1).unwrap()
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
    fn name_is_built_from_ints_and_bounded() {
        assert_eq!(t(PersistKind::Tmux).name, "ezterm-5-1");
        assert!(PersistTarget::new(PersistKind::Tmux, 5, 0).is_err());
        assert!(PersistTarget::new(PersistKind::Tmux, 5, MAX_SLOT + 1).is_err());
        assert!(PersistTarget::new(PersistKind::Tmux, 0, 1).is_err());
        assert!(PersistTarget::new(PersistKind::Tmux, -3, 1).is_err());
    }

    /// Every command must survive being parsed by bash, fish and csh as
    /// one single-quoted `sh -c` argument: no nested `'`, no `!` (csh
    /// history), no `\\` or `\'` (fish single-quote escapes).
    #[test]
    fn commands_are_shell_portable() {
        for kind in [PersistKind::Tmux, PersistKind::Screen] {
            let tg = t(kind);
            let id = match kind {
                PersistKind::Tmux => "=ezterm-5-1",
                PersistKind::Screen => "123.ezterm-5-1",
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
    fn tmux_uses_exact_match_target() {
        let tg = t(PersistKind::Tmux);
        assert!(probe_command(&tg).contains("has-session -t =ezterm-5-1 "));
        assert_eq!(parse_attach_id(&tg, "").as_deref(), Some("=ezterm-5-1"));
        assert!(attach_command(&tg, "=ezterm-5-1").contains("attach-session -d -t =ezterm-5-1"));
    }

    #[test]
    fn screen_attach_id_is_validated() {
        let tg = t(PersistKind::Screen);
        assert_eq!(
            parse_attach_id(&tg, "4242.ezterm-5-1\t\n").as_deref(),
            Some("4242.ezterm-5-1")
        );
        // Prefix collision, foreign name, junk, injection attempts.
        assert_eq!(parse_attach_id(&tg, "4242.ezterm-5-10"), None);
        assert_eq!(parse_attach_id(&tg, "4242.other"), None);
        assert_eq!(parse_attach_id(&tg, ".ezterm-5-1"), None);
        assert_eq!(parse_attach_id(&tg, "12;rm.ezterm-5-1"), None);
        assert_eq!(parse_attach_id(&tg, ""), None);
    }
}
