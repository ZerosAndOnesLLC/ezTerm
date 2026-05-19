//! Directory listing for WSL connections. Shells out to GNU `ls -la
//! --time-style=+%s` inside the distro and parses the symbolic-mode
//! lines back into the `SftpEntry` shape the frontend already consumes
//! for SSH SFTP listings.
//!
//! Why not `find -printf` / `stat -c …`? `ls -la` is by far the most
//! widely deployed (GNU coreutils ships in every mainstream WSL distro
//! image — Ubuntu, Debian, Kali, openSUSE, Oracle Linux, …). It does
//! mean Alpine/busybox-only distros need `apk add coreutils` first;
//! that's a knowingly-narrow v1 scope.

use crate::commands::sftp::SftpEntry;
use crate::error::Result;

use super::handle::WslFsHandle;

/// One directory listing. `path` must already have been normalised by
/// `sftp::normalise_remote_path`. Returns entries sorted directories-
/// first, name-ascending, matching the SSH SFTP path.
pub async fn list(handle: &WslFsHandle, path: &str) -> Result<Vec<SftpEntry>> {
    // `--time-style=+%s` forces numeric unix-epoch mtime. `-a` includes
    // dotfiles. `-l` long format. We do NOT pass `-A` because we want
    // the parser to know `.` and `..` exist and silently drop them.
    // `--` so a path beginning with `-` isn't taken as a flag.
    let stdout = handle
        .wsl_exec(&["ls", "-la", "--time-style=+%s", "--", path])
        .await?;
    let entries = parse_ls_output(&stdout, path);
    Ok(sorted(entries))
}

fn sorted(mut v: Vec<SftpEntry>) -> Vec<SftpEntry> {
    v.sort_by(|a, b| b.is_dir.cmp(&a.is_dir).then_with(|| a.name.cmp(&b.name)));
    v
}

fn parse_ls_output(stdout: &str, parent: &str) -> Vec<SftpEntry> {
    let mut out = Vec::new();
    for line in stdout.lines() {
        // Skip the leading `total N` line and any blank lines.
        if line.is_empty() || line.starts_with("total ") {
            continue;
        }
        if let Some(entry) = parse_ls_line(line, parent) {
            // Filter the same entries `russh-sftp::ReadDir` filters so
            // the UI doesn't have to special-case them.
            if entry.name == "." || entry.name == ".." {
                continue;
            }
            out.push(entry);
        }
    }
    out
}

fn parse_ls_line(line: &str, parent: &str) -> Option<SftpEntry> {
    // Standard `ls -la` line:
    //   mode  links  owner  group  size  mtime  name [-> target]
    //
    // Columns are whitespace-aligned (size is right-padded), so a
    // simple `splitn` would create empty intermediate tokens and
    // misalign the fields. We chew one token at a time off the front
    // of the line and keep the remainder *as-is* for the name so
    // multiple consecutive spaces inside a filename survive.
    let (mode_str, rest1)  = next_token(line)?;
    let (_links,   rest2)  = next_token(rest1)?;
    let (_owner,   rest3)  = next_token(rest2)?;
    let (_group,   rest4)  = next_token(rest3)?;
    let (size_str, rest5)  = next_token(rest4)?;
    let (mtime_str, rest6) = next_token(rest5)?;
    let rest = rest6.trim_start_matches(|c: char| c == ' ' || c == '\t');
    if rest.is_empty() {
        return None;
    }

    if mode_str.len() != 10 {
        return None;
    }

    let mode = parse_mode_str(mode_str);
    let is_dir = mode_str.starts_with('d');
    let is_symlink = mode_str.starts_with('l');
    let size: u64 = size_str.parse().ok()?;
    let mtime_unix: i64 = mtime_str.parse().ok()?;

    // Strip ` -> target` for symlinks so the displayed name matches
    // the source side only. We could capture the target for a future
    // tooltip, but the existing SftpEntry shape has no field for it.
    let name = if is_symlink {
        match rest.split_once(" -> ") {
            Some((n, _t)) => n.to_string(),
            None          => rest.to_string(),
        }
    } else {
        rest.to_string()
    };

    let full_path = join_remote(parent, &name);

    Some(SftpEntry {
        name,
        full_path,
        is_dir,
        is_symlink,
        size,
        mtime_unix,
        mode,
    })
}

/// Pull one whitespace-delimited token off the front of `s`. Returns
/// the token and the remainder (still includes the separator + any
/// later tokens). `None` if `s` contains no non-whitespace bytes.
fn next_token(s: &str) -> Option<(&str, &str)> {
    let s = s.trim_start_matches(|c: char| c == ' ' || c == '\t');
    if s.is_empty() {
        return None;
    }
    match s.find(|c: char| c == ' ' || c == '\t') {
        Some(i) => Some((&s[..i], &s[i..])),
        None    => Some((s, "")),
    }
}

fn join_remote(parent: &str, name: &str) -> String {
    if parent == "/" {
        format!("/{name}")
    } else if parent.ends_with('/') {
        format!("{parent}{name}")
    } else {
        format!("{parent}/{name}")
    }
}

/// Translate the 10-character symbolic mode string (`drwxr-xr-x` etc.)
/// into the standard POSIX mode word, including the high-nibble file-
/// type bits. Matches what russh-sftp returns in `FileAttributes.permissions`
/// so the frontend's mode column doesn't need a kind-aware branch.
fn parse_mode_str(s: &str) -> u32 {
    let b = s.as_bytes();
    let mut mode: u32 = match b[0] {
        b'd' => 0o040000, // S_IFDIR
        b'l' => 0o120000, // S_IFLNK
        b'-' => 0o100000, // S_IFREG
        b'c' => 0o020000, // S_IFCHR
        b'b' => 0o060000, // S_IFBLK
        b'p' => 0o010000, // S_IFIFO
        b's' => 0o140000, // S_IFSOCK
        _    => 0,
    };
    if b[1] == b'r' { mode |= 0o400; }
    if b[2] == b'w' { mode |= 0o200; }
    match b[3] {
        b'x' =>  mode |= 0o100,
        b's' => {mode |= 0o100 | 0o4000;}
        b'S' =>  mode |= 0o4000,
        _    => {}
    }
    if b[4] == b'r' { mode |= 0o040; }
    if b[5] == b'w' { mode |= 0o020; }
    match b[6] {
        b'x' =>  mode |= 0o010,
        b's' => {mode |= 0o010 | 0o2000;}
        b'S' =>  mode |= 0o2000,
        _    => {}
    }
    if b[7] == b'r' { mode |= 0o004; }
    if b[8] == b'w' { mode |= 0o002; }
    match b[9] {
        b'x' =>  mode |= 0o001,
        b't' => {mode |= 0o001 | 0o1000;}
        b'T' =>  mode |= 0o1000,
        _    => {}
    }
    mode
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_basic_listing() {
        let sample = "\
total 12
drwxr-xr-x 3 ron ron 4096 1700000000 .
drwxr-xr-x 5 ron ron 4096 1699999999 ..
-rw-r--r-- 1 ron ron   42 1700000100 file.txt
lrwxrwxrwx 1 ron ron   10 1700000200 link -> /etc/hostname
drwxrwxrwt 1 ron ron 4096 1700000300 sticky-dir
";
        let entries = parse_ls_output(sample, "/home/ron");
        // `.` and `..` filtered out.
        assert_eq!(entries.len(), 3);

        let f = entries.iter().find(|e| e.name == "file.txt").unwrap();
        assert_eq!(f.size, 42);
        assert_eq!(f.mtime_unix, 1700000100);
        assert!(!f.is_dir);
        assert!(!f.is_symlink);
        assert_eq!(f.mode & 0o777, 0o644);
        assert_eq!(f.mode & 0o170000, 0o100000);
        assert_eq!(f.full_path, "/home/ron/file.txt");

        let l = entries.iter().find(|e| e.name == "link").unwrap();
        assert!(l.is_symlink);
        assert_eq!(l.mode & 0o170000, 0o120000);

        let d = entries.iter().find(|e| e.name == "sticky-dir").unwrap();
        assert!(d.is_dir);
        assert_eq!(d.mode & 0o1000, 0o1000); // sticky bit set
    }

    #[test]
    fn join_remote_handles_root() {
        assert_eq!(join_remote("/", "etc"), "/etc");
        assert_eq!(join_remote("/home/ron", "x"), "/home/ron/x");
        assert_eq!(join_remote("/home/ron/", "x"), "/home/ron/x");
    }

    #[test]
    fn parses_setuid_setgid() {
        // `-rwsr-xr-x` — setuid bit + owner-exec.
        let line = "-rwsr-xr-x 1 root root 12345 1700000000 mount";
        let e = parse_ls_line(line, "/usr/bin").unwrap();
        assert_eq!(e.mode & 0o4000, 0o4000);
        assert_eq!(e.mode & 0o100, 0o100);
    }
}
