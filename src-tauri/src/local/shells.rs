//! Cross-platform local shell detection. Used by the autodetect-seed
//! command on unlock and by the session dialog's shell picker to
//! populate its dropdown with shells that actually exist on the host.
//!
//! Unix and Windows produce the same `DetectedShell` shape, but the
//! `program` field carries different things on each — see the struct
//! comment.

#[derive(Clone, Debug, serde::Serialize)]
pub struct DetectedShell {
    /// User-facing label, also used as the seeded session `name`.
    /// On Unix this is the binary basename (`bash`, `zsh`, `fish`).
    /// On Windows it's the short identifier accepted by
    /// `build_command` (`cmd`, `powershell`, `pwsh`).
    pub display_name: String,
    /// Stored in the session `host` field and handed back to
    /// `build_command` at spawn time. On Unix this is the absolute
    /// shell binary path from `/etc/shells`; on Windows it's the
    /// same short identifier as `display_name`.
    pub program: String,
}

/// Enumerate shells available on this host.
///
/// Unix: parses `/etc/shells`, filters out nologin/false entries and
/// dead paths, dedupes by basename. Falls back to `$SHELL` → `/bin/sh`
/// when `/etc/shells` is missing or unreadable.
///
/// Windows: returns `cmd` and `powershell` (effectively always
/// present on Win10/11), plus `pwsh` when it resolves on `PATH`.
pub fn detect_local_shells() -> Vec<DetectedShell> {
    #[cfg(unix)]
    { detect_unix_shells() }
    #[cfg(windows)]
    { detect_windows_shells() }
    #[cfg(not(any(unix, windows)))]
    { Vec::new() }
}

#[cfg(unix)]
const UNIX_NOLOGIN: &[&str] = &[
    "/sbin/nologin",
    "/usr/sbin/nologin",
    "/bin/false",
    "/usr/bin/false",
];

#[cfg(unix)]
fn detect_unix_shells() -> Vec<DetectedShell> {
    let parsed = std::fs::read_to_string("/etc/shells")
        .map(|t| parse_etc_shells(&t))
        .unwrap_or_default();

    let mut out: Vec<DetectedShell> = Vec::new();
    let mut seen: std::collections::HashSet<String> = std::collections::HashSet::new();
    for path in parsed {
        if !std::path::Path::new(&path).exists() {
            continue;
        }
        let name = basename(&path);
        if name.is_empty() || !seen.insert(name.clone()) {
            continue;
        }
        out.push(DetectedShell { display_name: name, program: path });
    }

    if out.is_empty() {
        // /etc/shells missing or empty after filtering — fall back so
        // the user still gets *something* in the Local Shells folder.
        let candidate = std::env::var("SHELL")
            .ok()
            .filter(|s| !s.trim().is_empty() && std::path::Path::new(s).exists())
            .unwrap_or_else(|| "/bin/sh".to_string());
        let name = basename(&candidate);
        if !name.is_empty() {
            out.push(DetectedShell { display_name: name, program: candidate });
        }
    }
    out
}

#[cfg(unix)]
fn parse_etc_shells(text: &str) -> Vec<String> {
    text.lines()
        .map(|line| line.split('#').next().unwrap_or("").trim().to_string())
        .filter(|line| !line.is_empty())
        .filter(|line| !UNIX_NOLOGIN.iter().any(|skip| line == skip))
        .collect()
}

fn basename(path: &str) -> String {
    std::path::Path::new(path)
        .file_name()
        .map(|s| s.to_string_lossy().into_owned())
        .unwrap_or_default()
}

#[cfg(windows)]
fn detect_windows_shells() -> Vec<DetectedShell> {
    // cmd.exe and powershell.exe ship with every modern Windows install,
    // so we assume them. pwsh.exe (PowerShell 7+) is a separate install
    // and only shows up if the user put it on PATH.
    let mut out = vec![
        DetectedShell { display_name: "cmd".into(),        program: "cmd".into() },
        DetectedShell { display_name: "powershell".into(), program: "powershell".into() },
    ];
    if windows_has_pwsh() {
        out.push(DetectedShell { display_name: "pwsh".into(), program: "pwsh".into() });
    }
    out
}

#[cfg(windows)]
fn windows_has_pwsh() -> bool {
    let Some(path) = std::env::var_os("PATH") else { return false; };
    std::env::split_paths(&path).any(|dir| dir.join("pwsh.exe").exists())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[cfg(unix)]
    #[test]
    fn etc_shells_strips_comments_and_blanks() {
        let sample = "\
# /etc/shells: valid login shells
/bin/sh
/bin/bash # default

/bin/zsh
";
        let parsed = parse_etc_shells(sample);
        assert_eq!(parsed, vec!["/bin/sh", "/bin/bash", "/bin/zsh"]);
    }

    #[cfg(unix)]
    #[test]
    fn etc_shells_filters_nologin() {
        let sample = "/bin/sh\n/sbin/nologin\n/usr/sbin/nologin\n/usr/bin/false\n/bin/false\n/bin/bash\n";
        let parsed = parse_etc_shells(sample);
        assert_eq!(parsed, vec!["/bin/sh", "/bin/bash"]);
    }

    #[test]
    fn basename_extracts_final_component() {
        assert_eq!(basename("/bin/bash"), "bash");
        assert_eq!(basename("/usr/local/bin/fish"), "fish");
        assert_eq!(basename(""), "");
    }
}
