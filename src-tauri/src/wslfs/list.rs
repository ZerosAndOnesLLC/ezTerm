//! Directory listing for WSL connections.
//!
//! One `sh` script inside the distro runs two GNU `find`s and prints
//! NUL-separated records, so a listing costs one `wsl.exe` process with no
//! per-entry forks, and filenames containing spaces, newlines or " -> "
//! survive intact (the old `ls -la` parser split on lines and on " -> ").
//!
//! 1. `find -H DIR -mindepth 1 -maxdepth 1 -printf '%y\0%Y\0%m\0%s\0%T@\0%l\0%f\0'`
//!    — per entry: its own type, its target's type (follows links; `N` =
//!    dangling, `L` = loop), permission bits, own size, mtime, link
//!    target, name. `-H` follows DIR itself when it's a link to a folder,
//!    so opening a folder link lists the folder (plain `find DIR` / `ls
//!    -la DIR` would just show the link).
//! 2. `printf '==\0'` — section marker (the first field of a section-1
//!    record is always one character, so this can't be mistaken for one).
//! 3. `find -L DIR … -printf '%s\0%T@\0%f\0'` — the *target's* size and
//!    mtime, keyed by name, for links to files.
//!
//! GNU findutils ships in every mainstream WSL image (Ubuntu, Debian, Kali,
//! openSUSE, Oracle Linux). Busybox-only distros (Alpine) need
//! `apk add findutils`.

use std::collections::HashMap;

use crate::commands::sftp::{LinkResolution, SftpEntry, apply_link_resolution};
use crate::error::Result;

use super::handle::WslFsHandle;

const LIST_SCRIPT: &str = "d=$1; \
find -H \"$d\" -mindepth 1 -maxdepth 1 -printf '%y\\0%Y\\0%m\\0%s\\0%T@\\0%l\\0%f\\0' || exit $?; \
printf '==\\0'; \
find -L \"$d\" -mindepth 1 -maxdepth 1 -printf '%s\\0%T@\\0%f\\0' 2>/dev/null; \
exit 0";

/// One directory listing. `path` must already have been normalised by
/// `sftp::normalise_remote_path`. Returns entries sorted directories-
/// first (links to directories included), name-ascending, matching the
/// SSH SFTP path.
pub async fn list(handle: &WslFsHandle, path: &str) -> Result<Vec<SftpEntry>> {
    // `sh -c SCRIPT sh PATH`: the literal `sh` fills $0, PATH is $1 and is
    // only ever used quoted — never parsed by the shell.
    let stdout = handle
        .wsl_exec(&["sh", "-c", LIST_SCRIPT, "sh", path])
        .await?;
    Ok(sorted(parse_listing(&stdout, path)))
}

fn sorted(mut v: Vec<SftpEntry>) -> Vec<SftpEntry> {
    v.sort_by(|a, b| b.is_dir.cmp(&a.is_dir).then_with(|| a.name.cmp(&b.name)));
    v
}

/// Section 1 record: type, target type, perms, size, mtime, target, name.
const ENTRY_FIELDS: usize = 7;
/// Section 2 record: target size, target mtime, name.
const TARGET_FIELDS: usize = 3;

fn parse_listing(stdout: &str, parent: &str) -> Vec<SftpEntry> {
    let fields: Vec<&str> = stdout.split('\0').collect();
    // The marker can only sit where a record would start (every record's
    // first field is a one-letter type), so a *file* named "==" can't be
    // mistaken for it.
    let marker = (0..fields.len())
        .step_by(ENTRY_FIELDS)
        .find(|&i| fields[i] == "==");
    let (entries, targets) = match marker {
        Some(m) => (&fields[..m], &fields[m + 1..]),
        None => (&fields[..], &[][..]),
    };

    // Target size / mtime by name (from the `find -L` pass).
    let mut target_meta: HashMap<&str, (u64, Option<i64>)> = HashMap::new();
    for rec in targets.chunks(TARGET_FIELDS) {
        if let [size, mtime, name] = rec {
            target_meta.insert(name, (size.parse().unwrap_or(0), parse_mtime(mtime)));
        }
    }

    let mut out = Vec::new();
    let (records, rest) = entries.as_chunks::<ENTRY_FIELDS>();
    for rec in records {
        match parse_record(rec, parent, &target_meta) {
            Some(e) => out.push(e),
            None => tracing::warn!("wsl listing: skipped a malformed record"),
        }
    }
    // A trailing empty field is the terminator after the last NUL; any
    // other remainder means the output was cut short.
    if !(rest.is_empty() || rest == [""]) {
        tracing::warn!(fields = rest.len(), "wsl listing: output ended mid-record");
    }
    out
}

fn parse_record(
    rec: &[&str; ENTRY_FIELDS],
    parent: &str,
    target_meta: &HashMap<&str, (u64, Option<i64>)>,
) -> Option<SftpEntry> {
    let [own, target_type, perms, size, mtime, link, name] = rec;
    if name.is_empty() || *name == "." || *name == ".." || name.contains('/') {
        return None;
    }
    let own = own.chars().next()?;
    let perm_bits = u32::from_str_radix(perms, 8).ok()? & 0o7777;
    let mut e = SftpEntry {
        name: name.to_string(),
        full_path: join_remote(parent, name),
        is_dir: own == 'd',
        is_symlink: own == 'l',
        size: size.parse().ok()?,
        mtime_unix: parse_mtime(mtime).unwrap_or(0),
        mode: type_bits(own) | perm_bits,
        link_target: None,
        link_broken: false,
        link_unresolved: false,
        is_special: is_special_type(own),
    };
    if e.is_symlink {
        let target = (!link.is_empty()).then(|| link.to_string());
        let (tsize, tmtime) = target_meta.get(name).copied().unwrap_or((e.size, None));
        let res = match target_type.chars().next() {
            Some('d') => LinkResolution::Dir { mtime: tmtime },
            Some('N') | Some('L') => LinkResolution::Broken,
            Some('f') => LinkResolution::File {
                size: tsize,
                mtime: tmtime,
                special: false,
            },
            Some(t) if is_special_type(t) => LinkResolution::File {
                size: tsize,
                mtime: tmtime,
                special: true,
            },
            _ => LinkResolution::Unresolved,
        };
        apply_link_resolution(&mut e, res, target);
    }
    Some(e)
}

fn parse_mtime(s: &str) -> Option<i64> {
    s.parse::<f64>().ok().map(|f| f as i64)
}

/// `find %y` letter → `st_mode` file-type bits (what the SFTP path reports).
fn type_bits(t: char) -> u32 {
    match t {
        'd' => 0o040000,
        'f' => 0o100000,
        'l' => 0o120000,
        'p' => 0o010000,
        's' => 0o140000,
        'c' => 0o020000,
        'b' => 0o060000,
        _ => 0,
    }
}

/// FIFO, socket, character or block device.
fn is_special_type(t: char) -> bool {
    matches!(t, 'p' | 's' | 'c' | 'b')
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

#[cfg(test)]
mod tests {
    use super::*;

    fn rec(fields: &[&str]) -> String {
        let mut s = String::new();
        for f in fields {
            s.push_str(f);
            s.push('\0');
        }
        s
    }

    #[test]
    fn parses_entries_links_and_target_metadata() {
        let mut out = String::new();
        out += &rec(&["f", "f", "644", "42", "1700000100.5", "", "file.txt"]);
        out += &rec(&["d", "d", "1777", "4096", "1700000300", "", "sticky-dir"]);
        out += &rec(&["l", "d", "777", "7", "1700000400", "releases/42", "current"]);
        out += &rec(&["l", "f", "777", "8", "1700000400", "file.txt", "readme"]);
        out += &rec(&["l", "N", "777", "5", "1700000400", "/gone", "dangling"]);
        out += &rec(&["l", "L", "777", "4", "1700000400", "loop", "loop"]);
        out += &rec(&["p", "p", "644", "0", "1700000500", "", "fifo"]);
        out += &rec(&["l", "p", "777", "4", "1700000500", "fifo", "to-fifo"]);
        out += "==\0";
        out += &rec(&["42", "1700000100.5", "file.txt"]);
        out += &rec(&["4096", "1700009999", "current"]);
        out += &rec(&["42", "1700000100.5", "readme"]);
        let list = parse_listing(&out, "/home/ron");
        let by = |n: &str| list.iter().find(|e| e.name == n).unwrap();

        let f = by("file.txt");
        assert!(!f.is_dir && !f.is_symlink && !f.is_special);
        assert_eq!((f.size, f.mtime_unix), (42, 1700000100));
        assert_eq!(f.mode, 0o100644);
        assert_eq!(f.full_path, "/home/ron/file.txt");

        let d = by("sticky-dir");
        assert!(d.is_dir);
        assert_eq!(d.mode & 0o1000, 0o1000);

        let cur = by("current");
        assert!(cur.is_symlink && cur.is_dir && !cur.link_broken);
        assert_eq!(cur.link_target.as_deref(), Some("releases/42"));
        assert_eq!(cur.mtime_unix, 1700009999, "target mtime");
        assert_eq!(cur.mode, 0o120777, "link keeps its own mode");

        let readme = by("readme");
        assert!(readme.is_symlink && !readme.is_dir);
        assert_eq!(readme.size, 42, "target size, not the link's");

        assert!(by("dangling").link_broken);
        assert!(by("loop").link_broken);
        assert!(by("fifo").is_special);
        let tf = by("to-fifo");
        assert!(tf.is_symlink && tf.is_special && !tf.link_broken);
    }

    #[test]
    fn names_with_newlines_and_arrows_survive() {
        let mut out = String::new();
        out += &rec(&["f", "f", "644", "1", "1", "", "new\nline"]);
        out += &rec(&["l", "f", "777", "6", "1", "x -> y", "we -> ird"]);
        out += "==\0";
        let list = parse_listing(&out, "/t");
        assert_eq!(list.len(), 2);
        let l = list.iter().find(|e| e.is_symlink).unwrap();
        assert_eq!(l.name, "we -> ird");
        assert_eq!(l.link_target.as_deref(), Some("x -> y"));
        assert_eq!(l.full_path, "/t/we -> ird");
        assert!(list.iter().any(|e| e.name == "new\nline"));
    }

    #[test]
    fn a_file_named_like_the_marker_is_just_a_file() {
        let mut out = String::new();
        out += &rec(&["f", "f", "644", "1", "1", "", "=="]);
        out += "==\0";
        out += &rec(&["1", "1", "=="]);
        let list = parse_listing(&out, "/t");
        assert_eq!(list.len(), 1);
        assert_eq!(list[0].name, "==");
    }

    #[test]
    fn malformed_records_are_skipped_not_misaligned() {
        let mut out = String::new();
        out += &rec(&["f", "f", "644", "notanumber", "1", "", "bad"]);
        out += &rec(&["f", "f", "644", "3", "1", "", "good"]);
        out += &rec(&["f", "f", "644", "3", "1", "", "a/b"]);
        out += "==\0";
        let list = parse_listing(&out, "/t");
        assert_eq!(
            list.iter().map(|e| e.name.as_str()).collect::<Vec<_>>(),
            ["good"]
        );
    }

    #[test]
    fn join_remote_handles_root() {
        assert_eq!(join_remote("/", "etc"), "/etc");
        assert_eq!(join_remote("/home/ron", "x"), "/home/ron/x");
        assert_eq!(join_remote("/home/ron/", "x"), "/home/ron/x");
    }

    /// The real script, run by `sh` + the local `find` against real files
    /// and links — including listing *through* a folder link.
    #[cfg(unix)]
    #[test]
    fn list_script_against_real_tree() {
        let ci = std::env::var_os("CI").is_some();
        let dir = tempfile::tempdir().unwrap();
        let d = dir.path();
        std::fs::create_dir(d.join("real dir")).unwrap();
        std::fs::write(d.join("real dir").join("inside.txt"), b"in").unwrap();
        std::fs::write(d.join("file.txt"), b"hello").unwrap();
        std::os::unix::fs::symlink("real dir", d.join("to-dir")).unwrap();
        std::os::unix::fs::symlink("file.txt", d.join("we -> ird")).unwrap();
        std::os::unix::fs::symlink("/nonexistent/x", d.join("dangling")).unwrap();
        std::fs::write(d.join("new\nline"), b"x").unwrap();
        let run = |p: &str| {
            std::process::Command::new("sh")
                .args(["-c", LIST_SCRIPT, "sh", p])
                .output()
        };
        let path = d.to_string_lossy().into_owned();
        let out = match run(&path) {
            Ok(o) if o.status.success() => o,
            other => {
                assert!(!ci, "sh/find unavailable in CI: {other:?}");
                return;
            }
        };
        let list = parse_listing(&String::from_utf8_lossy(&out.stdout), &path);
        let by = |n: &str| {
            list.iter()
                .find(|e| e.name == n)
                .unwrap_or_else(|| panic!("{n} missing: {list:?}"))
        };
        let td = by("to-dir");
        assert!(td.is_symlink && td.is_dir);
        let l = by("we -> ird");
        assert!(l.is_symlink && !l.is_dir && !l.link_broken);
        assert_eq!(l.size, 5);
        assert_eq!(l.link_target.as_deref(), Some("file.txt"));
        assert!(by("dangling").link_broken);
        by("new\nline");
        // Opening the folder link lists the folder's contents.
        let inner = run(&format!("{path}/to-dir")).unwrap();
        let inner = parse_listing(
            &String::from_utf8_lossy(&inner.stdout),
            &format!("{path}/to-dir"),
        );
        assert_eq!(
            inner.iter().map(|e| e.name.as_str()).collect::<Vec<_>>(),
            ["inside.txt"]
        );
    }
}
