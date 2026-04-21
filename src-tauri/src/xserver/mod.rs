//! VcXsrv (GPLv2, free) lifecycle manager.
//!
//! ezTerm does not bundle an X server; it delegates to VcXsrv on Windows
//! and manages its lifecycle per-display with reference counting. The
//! first SSH session that opts into X11 forwarding brings VcXsrv up on
//! `:0`; subsequent sessions share the same display; the server exits
//! when the last forwarding session disconnects.
//!
//! v1 runs VcXsrv with `-ac` (access control off) and accepts any cookie
//! on the forwarded channel. xauth MIT-MAGIC-COOKIE-1 negotiation is a
//! follow-up — `-ac` is fine for loopback since VcXsrv only listens on
//! localhost TCP 6000+display.

use std::collections::HashMap;
use std::path::PathBuf;
use std::process::{Child, Command};

use tokio::sync::Mutex;

use crate::error::{AppError, Result};

/// Default X11 display number. VcXsrv listens on TCP 127.0.0.1:6000.
pub const DEFAULT_DISPLAY: u8 = 0;

/// Where to look for vcxsrv.exe **as a system install**. Checked after
/// the bundled copy next to the ezTerm binary (see `detect_install_path`).
const VCXSRV_CANDIDATES: &[&str] = &[
    r"C:\Program Files\VcXsrv\vcxsrv.exe",
    r"C:\Program Files (x86)\VcXsrv\vcxsrv.exe",
];

/// Relative path under the ezTerm binary's directory where the release
/// tarball places VcXsrv. Set during the CI package step.
const BUNDLED_VCXSRV_REL: &str = "vcxsrv/vcxsrv.exe";

pub struct XServerManager {
    displays: Mutex<HashMap<u8, DisplayEntry>>,
}

struct DisplayEntry {
    child: Child,
    refs: usize,
}

#[derive(Clone, Debug, serde::Serialize)]
pub struct XServerStatus {
    pub installed: bool,
    pub install_path: Option<String>,
    pub running_displays: Vec<u8>,
}

impl Default for XServerManager {
    fn default() -> Self {
        Self::new()
    }
}

impl XServerManager {
    pub fn new() -> Self {
        Self {
            displays: Mutex::new(HashMap::new()),
        }
    }

    /// Return the VcXsrv install path if we can find it. Priority:
    /// 1. `vcxsrv/vcxsrv.exe` next to the ezTerm binary — the copy the
    ///    Windows release tarball ships. Lets "extract and run" work
    ///    without a separate VcXsrv install.
    /// 2. `C:\Program Files\VcXsrv\` and the x86 variant — user's own
    ///    system install (useful for dev builds / `cargo run`).
    pub fn detect_install_path() -> Option<PathBuf> {
        if let Ok(exe) = std::env::current_exe() {
            if let Some(dir) = exe.parent() {
                let bundled = dir.join(BUNDLED_VCXSRV_REL);
                if bundled.exists() {
                    return Some(bundled);
                }
            }
        }
        for candidate in VCXSRV_CANDIDATES {
            let p = PathBuf::from(candidate);
            if p.exists() {
                return Some(p);
            }
        }
        None
    }

    pub async fn status(&self) -> XServerStatus {
        let path = Self::detect_install_path();
        let displays = self.displays.lock().await;
        let mut running: Vec<u8> = displays.keys().copied().collect();
        running.sort_unstable();
        XServerStatus {
            installed: path.is_some(),
            install_path: path.map(|p| p.to_string_lossy().into_owned()),
            running_displays: running,
        }
    }

    /// Ref-count + start. Fails if VcXsrv isn't installed.
    pub async fn acquire(&self, display: u8) -> Result<()> {
        let mut displays = self.displays.lock().await;
        if let Some(entry) = displays.get_mut(&display) {
            entry.refs += 1;
            return Ok(());
        }
        let path = Self::detect_install_path().ok_or_else(|| {
            AppError::Validation(
                "VcXsrv is not installed — download from sourceforge.net/projects/vcxsrv/".into(),
            )
        })?;
        let child = Command::new(&path)
            .args([
                // Display number goes first, unprefixed with "--" etc.
                &format!(":{display}"),
                // Access control off — any forwarded X11 client can connect.
                // We're only listening on loopback so this is safe-ish.
                "-ac",
                // Each X window becomes a native Windows window.
                "-multiwindow",
                // Bridge clipboard both ways.
                "-clipboard",
                // Run quietly — no splash / reminder.
                "-silent-dup-error",
            ])
            .spawn()
            .map_err(|e| AppError::Ssh(format!("vcxsrv spawn: {e}")))?;
        displays.insert(display, DisplayEntry { child, refs: 1 });
        Ok(())
    }

    /// Decrement refcount for `display`. When it hits zero the child is
    /// killed. No-op if the display wasn't tracked.
    pub async fn release(&self, display: u8) {
        let mut displays = self.displays.lock().await;
        let should_stop = match displays.get_mut(&display) {
            Some(entry) => {
                entry.refs = entry.refs.saturating_sub(1);
                entry.refs == 0
            }
            None => false,
        };
        if should_stop {
            if let Some(mut entry) = displays.remove(&display) {
                let _ = entry.child.kill();
                let _ = entry.child.wait();
            }
        }
    }
}

/// Generate an MIT-MAGIC-COOKIE-1 value (32 hex chars = 128 bits).
/// VcXsrv with `-ac` ignores the cookie; we still send a real one so the
/// SSH wire protocol is well-formed and so future cookie-enforcing
/// upgrades don't require a client-side change.
pub fn generate_cookie() -> String {
    use rand::RngCore;
    let mut buf = [0u8; 16];
    rand::rngs::OsRng.fill_bytes(&mut buf);
    buf.iter().map(|b| format!("{b:02x}")).collect()
}
