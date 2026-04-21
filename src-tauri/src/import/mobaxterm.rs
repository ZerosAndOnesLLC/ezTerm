//! MobaXterm `.mxtsessions` / `MobaXterm.ini` bookmark parser.
//!
//! MobaXterm stores saved sessions under `[Bookmarks]` and `[Bookmarks_N]`
//! INI sections. Each section has two special headers — `SubRep=<Folder\Sub>`
//! (folder path, backslash-separated) and `ImgNum=<n>` (folder icon) — and
//! then one line per session where the INI **key is the session name** and
//! the value encodes the connection:
//!
//! ```text
//! <Name>=#<ImgNum>#<Type>%<Host>%<Port>%<Username>%<…many fields…>
//! ```
//!
//! We only keep SSH rows (`Type == 0`) and extract `name`, `host`, `port`,
//! `username`, plus the folder path. Everything else (color scheme, font,
//! key-file reference, compression) is dropped — those fields encode
//! MobaXterm-specific terminal state that doesn't round-trip cleanly.
//!
//! The parser is pure text-in / structs-out; no DB or filesystem access.

use serde::{Deserialize, Serialize};

/// Session type codes in MobaXterm's bookmark format.
const SESSION_TYPE_SSH: &str = "0";
const SESSION_TYPE_WSL: &str = "14";

/// Zero-based index of the private-key-path slot in the `%`-separated SSH
/// descriptor (after host/port/user/…). When non-empty MobaXterm will use
/// key auth; when empty it falls back to password auth. MobaXterm never
/// exports the actual secret, so ezTerm stores only the auth *type* and
/// leaves the credential slot blank for the user to wire up.
const SSH_KEY_FIELD_INDEX: usize = 13;

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
pub struct ParsedMobaSession {
    /// Folder path from `SubRep`, split on `\`. Empty = root.
    pub folder_path: Vec<String>,
    pub name:     String,
    /// ezTerm session kind: `"ssh"` or `"wsl"`. Other MobaXterm types
    /// (RDP, VNC, Serial, …) are skipped during parse, not reported here.
    pub session_kind: String,
    /// For ssh: remote hostname. For wsl: distro name (empty = default).
    pub host:     String,
    /// For ssh: TCP port. For wsl: unused (stored as 22 for schema
    /// compatibility; validator ignores it).
    pub port:     i64,
    /// For ssh: remote username. For wsl: optional WSL user (empty = distro
    /// default).
    pub username: String,
    /// SSH-only: `"key"` if the row referenced a private-key file, else
    /// `"password"`. For wsl this is always `"agent"` (meaning "no
    /// credential") and `private_key_path` is None.
    pub auth_type: String,
    /// SSH-only: raw key-file path from the source row (MobaXterm-style
    /// placeholders or absolute Windows path). None for password or wsl.
    pub private_key_path: Option<String>,
}

#[derive(Clone, Debug, Serialize, Deserialize, Default)]
pub struct ParseResult {
    pub sessions: Vec<ParsedMobaSession>,
    /// Count of recognised bookmark rows we skipped because they weren't SSH.
    pub skipped_non_ssh: usize,
    /// Count of rows that matched the SSH type but had unparsable host/port.
    pub skipped_malformed: usize,
}

pub fn parse(input: &str) -> ParseResult {
    let mut out = ParseResult::default();
    let mut current_folder: Vec<String> = Vec::new();
    let mut in_bookmarks = false;

    for raw_line in input.lines() {
        let line = strip_bom(raw_line).trim_end_matches('\r').trim();
        if line.is_empty() || line.starts_with(';') {
            continue;
        }
        if let Some(section) = line.strip_prefix('[').and_then(|s| s.strip_suffix(']')) {
            in_bookmarks = section == "Bookmarks" || section.starts_with("Bookmarks_");
            current_folder.clear();
            continue;
        }
        if !in_bookmarks {
            continue;
        }

        // Split on first '=' into key / rest.
        let (key, rest) = match line.split_once('=') {
            Some(kv) => kv,
            None => continue,
        };
        let key = key.trim();

        if key.eq_ignore_ascii_case("SubRep") {
            current_folder = split_subrep(rest);
            continue;
        }
        if key.eq_ignore_ascii_case("ImgNum") {
            continue;
        }

        // Everything else in a bookmarks section is a session row: the INI
        // key is the literal session name and the value is the connection
        // descriptor. Reject empty names defensively.
        if key.is_empty() {
            continue;
        }

        match parse_session_line(key, rest, &current_folder) {
            Ok(Some(session)) => out.sessions.push(session),
            Ok(None) => out.skipped_non_ssh += 1,
            Err(()) => out.skipped_malformed += 1,
        }
    }

    out
}

fn strip_bom(s: &str) -> &str {
    s.strip_prefix('\u{feff}').unwrap_or(s)
}

fn split_subrep(value: &str) -> Vec<String> {
    value
        .trim()
        .split('\\')
        .filter_map(|s| {
            let t = s.trim();
            if t.is_empty() { None } else { Some(t.to_string()) }
        })
        .collect()
}

/// Parse a single session row.
///
/// `name` is the raw INI key (session name); `value` is everything after the
/// first `=` and starts with `#<ImgNum>#<Type>%<fields>…`.
///
/// Returns `Ok(Some(..))` for SSH (type 0) and WSL (type 14), `Ok(None)`
/// for other protocols (RDP, VNC, Serial, …), `Err(())` if the row claims
/// to be one of our supported types but lacks required fields.
fn parse_session_line(
    name: &str,
    value: &str,
    folder: &[String],
) -> Result<Option<ParsedMobaSession>, ()> {
    let name = name.trim().to_string();
    if name.is_empty() {
        return Err(());
    }

    let (header, rest) = value.split_once('%').ok_or(())?;
    let session_type = header
        .trim_start_matches('#')
        .rsplit('#')
        .next()
        .unwrap_or("")
        .trim();

    let fields: Vec<&str> = rest.split('%').collect();

    match session_type {
        SESSION_TYPE_SSH => parse_ssh_row(name, &fields, folder),
        SESSION_TYPE_WSL => parse_wsl_row(name, &fields, folder),
        _ => Ok(None),
    }
}

fn parse_ssh_row(
    name: String,
    fields: &[&str],
    folder: &[String],
) -> Result<Option<ParsedMobaSession>, ()> {
    let host = fields.first().copied().unwrap_or("").trim().to_string();
    let port_str = fields.get(1).copied().unwrap_or("").trim();
    let username = fields.get(2).copied().unwrap_or("").trim().to_string();

    if host.is_empty() || username.is_empty() {
        return Err(());
    }
    let port: i64 = port_str.parse().unwrap_or(22);
    if !(1..=65535).contains(&port) {
        return Err(());
    }

    let key_field = fields
        .get(SSH_KEY_FIELD_INDEX)
        .map(|s| s.trim())
        .unwrap_or("");
    let (auth_type, private_key_path) = if key_field.is_empty() {
        ("password", None)
    } else {
        ("key", Some(key_field.to_string()))
    };

    Ok(Some(ParsedMobaSession {
        folder_path: folder.to_vec(),
        name,
        session_kind: "ssh".into(),
        host,
        port,
        username,
        auth_type: auth_type.into(),
        private_key_path,
    }))
}

/// WSL row layout (from the real MobaXterm `.mxtsessions` format):
/// `<Name>=#<Img>#14%<Distro>%%<ShellHint>%%<WslUser>%<…>%…`
/// We care about fields[0] (distro) and fields[4] (wsl user). Everything
/// else is MobaXterm terminal state that doesn't round-trip cleanly.
fn parse_wsl_row(
    name: String,
    fields: &[&str],
    folder: &[String],
) -> Result<Option<ParsedMobaSession>, ()> {
    let distro = fields.first().copied().unwrap_or("").trim().to_string();
    let wsl_user = fields.get(4).copied().unwrap_or("").trim().to_string();
    // An empty distro is legal (falls back to the default distro) but we
    // require SOMETHING identifying — name is enough. No host/user validation
    // needed beyond what we already enforce for the session_kind='wsl' rules.
    Ok(Some(ParsedMobaSession {
        folder_path: folder.to_vec(),
        name,
        session_kind: "wsl".into(),
        host: distro,
        port: 22, // schema default; validator ignores port for wsl.
        username: wsl_user,
        auth_type: "agent".into(),
        private_key_path: None,
    }))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_basic_ssh_with_folder() {
        let ini = "\
[Bookmarks]
SubRep=
ImgNum=42

[Bookmarks_1]
SubRep=Production
ImgNum=41
web-01=#109#0%web01.example.com%22%root%%-1%-1%%%%%0%0%0%%%
db-01=#109#0%db01.example.com%2222%postgres%%-1%-1
";
        let r = parse(ini);
        assert_eq!(r.sessions.len(), 2);
        assert_eq!(r.skipped_non_ssh, 0);
        assert_eq!(r.skipped_malformed, 0);

        assert_eq!(r.sessions[0].folder_path, vec!["Production"]);
        assert_eq!(r.sessions[0].name, "web-01");
        assert_eq!(r.sessions[0].host, "web01.example.com");
        assert_eq!(r.sessions[0].port, 22);
        assert_eq!(r.sessions[0].username, "root");
        // No key file in either row → password auth.
        assert_eq!(r.sessions[0].auth_type, "password");

        assert_eq!(r.sessions[1].port, 2222);
        assert_eq!(r.sessions[1].username, "postgres");
    }

    #[test]
    fn auth_type_reflects_key_file_presence() {
        // First row: field 14 (0-based 13) is a key path → key auth.
        // Second row: same slot empty → password auth.
        let ini = "\
[Bookmarks_1]
SubRep=Prod
with-key=#109#0%h1%22%u1%%-1%-1%%%%%0%0%0%_MyDocuments_\\ssh-keys\\x.pem%%
no-key=#109#0%h2%22%u2%%-1%-1%%%%%0%0%0%%%
";
        let r = parse(ini);
        assert_eq!(r.sessions.len(), 2);
        assert_eq!(r.sessions[0].auth_type, "key");
        assert_eq!(
            r.sessions[0].private_key_path.as_deref(),
            Some("_MyDocuments_\\ssh-keys\\x.pem")
        );
        assert_eq!(r.sessions[1].auth_type, "password");
        assert!(r.sessions[1].private_key_path.is_none());
    }

    #[test]
    fn nested_folders_split_on_backslash() {
        let ini = "\
[Bookmarks_1]
SubRep=Customers\\Acme\\Prod
bastion=#0#0%bastion.acme.com%22%ops%%
";
        let r = parse(ini);
        assert_eq!(r.sessions.len(), 1);
        assert_eq!(
            r.sessions[0].folder_path,
            vec!["Customers", "Acme", "Prod"]
        );
    }

    #[test]
    fn session_names_can_contain_spaces_and_parens() {
        let ini = "\
[Bookmarks_1]
SubRep=Zeros and Ones
Voicd Bastion=#109#0%150.239.212.37%22%ron%%-1%-1
COM6 (USB Serial Port (COM6))=#131#8%2%100960%3%0%0
";
        let r = parse(ini);
        assert_eq!(r.sessions.len(), 1);
        assert_eq!(r.sessions[0].name, "Voicd Bastion");
        assert_eq!(r.sessions[0].host, "150.239.212.37");
        assert_eq!(r.sessions[0].username, "ron");
        assert_eq!(r.sessions[0].folder_path, vec!["Zeros and Ones"]);
        // Serial (type 8) is a non-SSH skip.
        assert_eq!(r.skipped_non_ssh, 1);
    }

    #[test]
    fn non_ssh_types_are_counted_and_skipped() {
        let ini = "\
[Bookmarks_1]
SubRep=
rdp-box=#0#4%rdp.example.com%3389%admin%%
vnc-box=#0#5%vnc.example.com%5900%admin%%
serial-box=#0#8%2%100960%3%0%0%1%2%
ssh-ok=#0#0%ssh.example.com%22%root%%
";
        let r = parse(ini);
        assert_eq!(r.sessions.len(), 1);
        assert_eq!(r.skipped_non_ssh, 3);
        assert_eq!(r.sessions[0].name, "ssh-ok");
        assert_eq!(r.sessions[0].session_kind, "ssh");
    }

    #[test]
    fn wsl_rows_are_imported() {
        // Real MobaXterm WSL rows: type 14, distro in field[0], WSL user in field[4].
        let ini = "\
[Bookmarks_1]
SubRep=Linux
WSL-Ubuntu=#151#14%Ubuntu-24.04%%Interactive shell%%mack%0#MobaFont
WSL-Default=#151#14%%%Interactive shell%%%0
";
        let r = parse(ini);
        assert_eq!(r.sessions.len(), 2);
        assert_eq!(r.sessions[0].session_kind, "wsl");
        assert_eq!(r.sessions[0].host, "Ubuntu-24.04");
        assert_eq!(r.sessions[0].username, "mack");
        assert_eq!(r.sessions[0].auth_type, "agent");
        assert_eq!(r.sessions[0].folder_path, vec!["Linux"]);
        // Default-distro row has empty host — that's legal.
        assert_eq!(r.sessions[1].host, "");
        assert_eq!(r.sessions[1].username, "");
    }

    #[test]
    fn malformed_ssh_row_is_counted() {
        let ini = "\
[Bookmarks_1]
SubRep=
broken=#0#0%%22%%
ok=#0#0%host%22%user%
";
        let r = parse(ini);
        assert_eq!(r.sessions.len(), 1);
        assert_eq!(r.skipped_malformed, 1);
    }

    #[test]
    fn ignores_comments_bom_and_blank_lines() {
        let ini = "\u{feff}\
; a comment
[Bookmarks_1]
SubRep=Lab

; another comment
alpha=#0#0%a.example.com%22%me%%
";
        let r = parse(ini);
        assert_eq!(r.sessions.len(), 1);
        assert_eq!(r.sessions[0].folder_path, vec!["Lab"]);
    }

    #[test]
    fn ignores_non_bookmark_sections() {
        let ini = "\
[Misc]
ignored=#0#0%nope.example.com%22%root%%

[Bookmarks_1]
SubRep=
kept=#0#0%yes.example.com%22%root%%
";
        let r = parse(ini);
        assert_eq!(r.sessions.len(), 1);
        assert_eq!(r.sessions[0].host, "yes.example.com");
    }

    #[test]
    fn invalid_port_is_malformed() {
        let ini = "\
[Bookmarks_1]
SubRep=
bad=#0#0%host%99999%user%%
";
        let r = parse(ini);
        assert_eq!(r.sessions.len(), 0);
        assert_eq!(r.skipped_malformed, 1);
    }

    #[test]
    fn empty_port_defaults_to_22() {
        let ini = "\
[Bookmarks_1]
SubRep=
defaults=#0#0%host%%user%%
";
        let r = parse(ini);
        assert_eq!(r.sessions.len(), 1);
        assert_eq!(r.sessions[0].port, 22);
    }
}
