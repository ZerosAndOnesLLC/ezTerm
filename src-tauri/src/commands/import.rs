//! Session import commands. Currently MobaXterm only.

use std::collections::{HashMap, HashSet};
use std::path::PathBuf;

use directories::{BaseDirs, UserDirs};
use serde::Serialize;
use sqlx::Sqlite;
use tauri::State;
use tokio::fs;

use crate::commands::require_unlocked;
use crate::error::{AppError, Result};
use crate::import::mobaxterm::{self, ParsedMobaSession};
use crate::state::AppState;
use crate::vault;

/// Cap import file size so a bad pick can't OOM us. A MobaXterm.ini with
/// thousands of sessions is under 1 MB; 10 MB is a generous ceiling.
const MAX_IMPORT_FILE_SIZE: u64 = 10 * 1024 * 1024;

/// Cap imported session count — prevents a crafted file from wedging the UI
/// and keeps the per-commit transaction bounded.
const MAX_IMPORT_SESSIONS: usize = 10_000;

/// Mirror of the credential-command cap. Private keys top out well under
/// this; PEM + comments for RSA-4096 is ~8 KiB in the wild.
const MAX_KEY_FILE_SIZE: u64 = 65_536;

#[derive(Debug, Serialize)]
pub struct MobaImportPreview {
    pub sessions:           Vec<ParsedMobaSession>,
    pub skipped_non_ssh:    usize,
    pub skipped_malformed:  usize,
    /// Folder paths (dotted form e.g. "Customers/Acme") that will need to be
    /// created. Ordered shallowest-first so the UI can list parents above
    /// children. Deduped across all imported sessions.
    pub new_folder_paths:   Vec<Vec<String>>,
    /// Indices (into `sessions`) of rows that would collide with an existing
    /// session at the same target folder path.
    pub duplicate_indices:  Vec<usize>,
}

#[derive(Debug, Serialize, Default)]
pub struct MobaImportResult {
    pub created:            usize,
    pub updated:            usize,
    pub skipped_duplicate:  usize,
    pub created_folders:    usize,
    /// Credential labels created from key files read off disk.
    pub imported_keys:      Vec<String>,
    /// Raw MobaXterm-style key paths we couldn't read (missing, too large,
    /// unreadable). Sessions that reference them still import but arrive
    /// with no credential attached.
    pub missing_keys:       Vec<String>,
}

#[tauri::command]
pub async fn mobaxterm_preview(
    state: State<'_, AppState>,
    path: String,
) -> Result<MobaImportPreview> {
    require_unlocked(&state).await?;

    let meta = fs::metadata(&path).await?;
    if meta.len() > MAX_IMPORT_FILE_SIZE {
        return Err(AppError::Validation(format!(
            "import file too large ({} bytes, max {})",
            meta.len(),
            MAX_IMPORT_FILE_SIZE
        )));
    }
    let text = fs::read_to_string(&path).await?;
    let parsed = mobaxterm::parse(&text);

    if parsed.sessions.len() > MAX_IMPORT_SESSIONS {
        return Err(AppError::Validation(format!(
            "too many sessions in import ({}, max {})",
            parsed.sessions.len(),
            MAX_IMPORT_SESSIONS
        )));
    }

    let folder_map = load_folder_path_map(&state.db).await?;
    let existing_sessions = crate::db::sessions::list(&state.db).await?;

    let new_folder_paths = collect_new_folder_paths(&parsed.sessions, &folder_map);

    let mut duplicate_indices = Vec::new();
    for (i, s) in parsed.sessions.iter().enumerate() {
        let target_folder_id = match resolve_target_folder(&s.folder_path, &folder_map) {
            Some(id) => id,
            None => continue, // folder doesn't exist yet → cannot collide
        };
        let dup = existing_sessions.iter().any(|ex| {
            ex.folder_id == target_folder_id
                && ex.name == s.name
                && ex.host == s.host
                && ex.port == s.port
                && ex.username == s.username
        });
        if dup {
            duplicate_indices.push(i);
        }
    }

    Ok(MobaImportPreview {
        sessions:          parsed.sessions,
        skipped_non_ssh:   parsed.skipped_non_ssh,
        skipped_malformed: parsed.skipped_malformed,
        new_folder_paths,
        duplicate_indices,
    })
}

#[tauri::command]
pub async fn mobaxterm_commit(
    state: State<'_, AppState>,
    sessions: Vec<ParsedMobaSession>,
    duplicate_strategy: String,
) -> Result<MobaImportResult> {
    require_unlocked(&state).await?;

    if sessions.len() > MAX_IMPORT_SESSIONS {
        return Err(AppError::Validation("too many sessions".into()));
    }
    if !matches!(duplicate_strategy.as_str(), "skip" | "overwrite" | "rename") {
        return Err(AppError::Validation("invalid duplicate_strategy".into()));
    }

    let mut tx = state.db.begin().await?;

    // Rebuild the folder path → id map inside the transaction so it stays in
    // sync with any folders we create mid-loop. We then mutate it as we go.
    let rows: Vec<(i64, Option<i64>, String)> =
        sqlx::query_as("SELECT id, parent_id, name FROM folders")
            .fetch_all(&mut *tx)
            .await?;
    let mut folder_map = build_folder_path_map(&rows);

    let mut result = MobaImportResult::default();

    // Read + vault-encrypt any key files that the sessions reference. Done
    // up-front so every session can share the same credential when multiple
    // rows point at the same key. Files we can't read are noted as
    // `missing_keys` — those sessions still get imported with auth='key'
    // but credential_id stays NULL until the user attaches one.
    let key_map = import_key_files(&mut tx, &state, &sessions, &mut result).await?;

    for s in &sessions {
        let folder_id = ensure_folder_path(
            &mut tx,
            &mut folder_map,
            &s.folder_path,
            &mut result.created_folders,
        )
        .await?;

        let imported_cred = s
            .private_key_path
            .as_deref()
            .and_then(|p| key_map.get(p))
            .copied();

        let existing: Option<(i64, String)> = sqlx::query_as(
            "SELECT id, auth_type FROM sessions \
             WHERE folder_id IS ? AND name = ? AND host = ? AND port = ? AND username = ? \
             LIMIT 1",
        )
        .bind(folder_id)
        .bind(&s.name)
        .bind(&s.host)
        .bind(s.port)
        .bind(&s.username)
        .fetch_optional(&mut *tx)
        .await?;

        match (existing, duplicate_strategy.as_str()) {
            (Some(_), "skip") => result.skipped_duplicate += 1,
            (Some((id, old_auth)), "overwrite") => {
                // Refresh the fields MobaXterm supplies. Auth kind unchanged:
                // keep any user-attached credential, but fill the slot from
                // this import if it was NULL (handles re-import after a
                // pre-fix run where key rows landed with no credential).
                // Auth kind flipped: existing credential is the wrong kind,
                // so clear and use the freshly-imported one when available.
                if old_auth == s.auth_type {
                    sqlx::query(
                        "UPDATE sessions SET host = ?, port = ?, username = ?, \
                         auth_type = ?, \
                         credential_id = COALESCE(credential_id, ?) \
                         WHERE id = ?",
                    )
                    .bind(&s.host)
                    .bind(s.port)
                    .bind(&s.username)
                    .bind(&s.auth_type)
                    .bind(imported_cred)
                    .bind(id)
                    .execute(&mut *tx)
                    .await?;
                } else {
                    sqlx::query(
                        "UPDATE sessions SET host = ?, port = ?, username = ?, \
                         auth_type = ?, credential_id = ?, \
                         key_passphrase_credential_id = NULL WHERE id = ?",
                    )
                    .bind(&s.host)
                    .bind(s.port)
                    .bind(&s.username)
                    .bind(&s.auth_type)
                    .bind(imported_cred)
                    .bind(id)
                    .execute(&mut *tx)
                    .await?;
                }
                result.updated += 1;
            }
            (existing, _) => {
                let final_name = if existing.is_some() {
                    find_unique_name(&mut tx, folder_id, &s.name).await?
                } else {
                    s.name.clone()
                };
                insert_imported_session(
                    &mut tx,
                    folder_id,
                    &final_name,
                    s,
                    imported_cred,
                )
                .await?;
                result.created += 1;
            }
        }
    }

    tx.commit().await?;
    Ok(result)
}

// ---------- helpers -----------------------------------------------------

fn resolve_target_folder(
    path: &[String],
    map: &HashMap<Vec<String>, i64>,
) -> Option<Option<i64>> {
    if path.is_empty() {
        return Some(None);
    }
    map.get(path).copied().map(Some)
}

fn collect_new_folder_paths(
    parsed: &[ParsedMobaSession],
    existing: &HashMap<Vec<String>, i64>,
) -> Vec<Vec<String>> {
    let mut seen: HashSet<Vec<String>> = HashSet::new();
    let mut result: Vec<Vec<String>> = Vec::new();
    for s in parsed {
        for i in 1..=s.folder_path.len() {
            let prefix: Vec<String> = s.folder_path[..i].to_vec();
            if existing.contains_key(&prefix) {
                continue;
            }
            if seen.insert(prefix.clone()) {
                result.push(prefix);
            }
        }
    }
    result.sort_by_key(|p| p.len());
    result
}

async fn load_folder_path_map(
    pool: &sqlx::SqlitePool,
) -> Result<HashMap<Vec<String>, i64>> {
    let rows: Vec<(i64, Option<i64>, String)> =
        sqlx::query_as("SELECT id, parent_id, name FROM folders")
            .fetch_all(pool)
            .await?;
    Ok(build_folder_path_map(&rows))
}

fn build_folder_path_map(
    rows: &[(i64, Option<i64>, String)],
) -> HashMap<Vec<String>, i64> {
    let mut children: HashMap<Option<i64>, Vec<&(i64, Option<i64>, String)>> = HashMap::new();
    for row in rows {
        children.entry(row.1).or_default().push(row);
    }
    let mut out: HashMap<Vec<String>, i64> = HashMap::new();
    let mut stack: Vec<(Option<i64>, Vec<String>)> = vec![(None, Vec::new())];
    while let Some((parent, prefix)) = stack.pop() {
        if let Some(kids) = children.get(&parent) {
            for row in kids {
                let mut path = prefix.clone();
                path.push(row.2.clone());
                out.insert(path.clone(), row.0);
                stack.push((Some(row.0), path));
            }
        }
    }
    out
}

async fn ensure_folder_path(
    tx: &mut sqlx::Transaction<'_, Sqlite>,
    map: &mut HashMap<Vec<String>, i64>,
    path: &[String],
    created_count: &mut usize,
) -> Result<Option<i64>> {
    if path.is_empty() {
        return Ok(None);
    }
    let mut parent: Option<i64> = None;
    for i in 1..=path.len() {
        let prefix: Vec<String> = path[..i].to_vec();
        if let Some(&id) = map.get(&prefix) {
            parent = Some(id);
            continue;
        }
        let name = &prefix[i - 1];
        let id = sqlx::query("INSERT INTO folders (parent_id, name) VALUES (?, ?)")
            .bind(parent)
            .bind(name)
            .execute(&mut **tx)
            .await?
            .last_insert_rowid();
        map.insert(prefix, id);
        *created_count += 1;
        parent = Some(id);
    }
    Ok(parent)
}

async fn find_unique_name(
    tx: &mut sqlx::Transaction<'_, Sqlite>,
    folder_id: Option<i64>,
    base: &str,
) -> Result<String> {
    let mut candidate = format!("{base} (imported)");
    let mut n = 2;
    loop {
        let exists: Option<(i64,)> = sqlx::query_as(
            "SELECT id FROM sessions WHERE folder_id IS ? AND name = ? LIMIT 1",
        )
        .bind(folder_id)
        .bind(&candidate)
        .fetch_optional(&mut **tx)
        .await?;
        if exists.is_none() {
            return Ok(candidate);
        }
        candidate = format!("{base} (imported {n})");
        n += 1;
    }
}

async fn insert_imported_session(
    tx: &mut sqlx::Transaction<'_, Sqlite>,
    folder_id: Option<i64>,
    name: &str,
    s: &ParsedMobaSession,
    credential_id: Option<i64>,
) -> Result<()> {
    // Defaults match the UI's new-session defaults (see session-dialog.tsx).
    // `credential_id` is attached when a referenced key file was read into
    // the vault; otherwise the session lands with no credential and the
    // user attaches one later from the session dialog. WSL rows force a
    // green-tinted dot so they stand out in the tree.
    let color: Option<&str> = if s.session_kind == "wsl" { Some("#34d399") } else { None };
    sqlx::query(
        "INSERT INTO sessions (folder_id, name, host, port, username, auth_type, \
         credential_id, key_passphrase_credential_id, color, \
         initial_command, scrollback_lines, font_size, cursor_style, \
         compression, keepalive_secs, connect_timeout_secs, session_kind) \
         VALUES (?, ?, ?, ?, ?, ?, ?, NULL, ?, NULL, 5000, 13, 'block', 0, 0, 15, ?)",
    )
    .bind(folder_id)
    .bind(name)
    .bind(&s.host)
    .bind(s.port)
    .bind(&s.username)
    .bind(&s.auth_type)
    .bind(credential_id)
    .bind(color)
    .bind(&s.session_kind)
    .execute(&mut **tx)
    .await?;
    Ok(())
}

/// Resolve a MobaXterm key-file reference to a real filesystem path.
///
/// Handles the common placeholders MobaXterm sprinkles into `.mxtsessions`
/// exports — `_MyDocuments_`, `_HomeDir_`, `_AppDataDir_` — plus plain
/// absolute Windows paths. Returns `None` for anything we can't resolve so
/// the caller can report the raw string as "missing".
fn resolve_moba_path(raw: &str) -> Option<PathBuf> {
    if let Some(rest) = raw.strip_prefix("_MyDocuments_\\") {
        let docs = UserDirs::new()?.document_dir()?.to_path_buf();
        return Some(docs.join(rest));
    }
    if let Some(rest) = raw.strip_prefix("_HomeDir_\\") {
        let home = BaseDirs::new()?.home_dir().to_path_buf();
        return Some(home.join(rest));
    }
    if let Some(rest) = raw.strip_prefix("_AppDataDir_\\") {
        let data = BaseDirs::new()?.data_dir().to_path_buf();
        return Some(data.join(rest));
    }
    let p = PathBuf::from(raw);
    if p.is_absolute() {
        Some(p)
    } else {
        None
    }
}

/// Read each unique key file referenced by the imported sessions, encrypt
/// with the vault, and insert as `private_key` credentials. Returns a map
/// from the raw MobaXterm path string to the inserted credential id so the
/// caller can attach credentials as sessions are inserted/updated.
async fn import_key_files(
    tx: &mut sqlx::Transaction<'_, Sqlite>,
    state: &AppState,
    sessions: &[ParsedMobaSession],
    result: &mut MobaImportResult,
) -> Result<HashMap<String, i64>> {
    let mut map: HashMap<String, i64> = HashMap::new();
    let mut seen: HashSet<&str> = HashSet::new();

    for s in sessions {
        let Some(raw) = s.private_key_path.as_deref() else { continue };
        if !seen.insert(raw) {
            continue; // dedupe across sessions that share the same key file
        }

        let Some(path) = resolve_moba_path(raw) else {
            result.missing_keys.push(raw.to_string());
            continue;
        };

        let meta = match fs::metadata(&path).await {
            Ok(m) => m,
            Err(_) => {
                result.missing_keys.push(raw.to_string());
                continue;
            }
        };
        if meta.len() > MAX_KEY_FILE_SIZE {
            result.missing_keys.push(raw.to_string());
            continue;
        }

        let bytes = match fs::read(&path).await {
            Ok(b) => b,
            Err(_) => {
                result.missing_keys.push(raw.to_string());
                continue;
            }
        };

        let label = path
            .file_stem()
            .and_then(|s| s.to_str())
            .filter(|s| !s.is_empty())
            .unwrap_or("imported-key")
            .to_string();

        let (nonce, ct) = {
            let vault_state = state.vault.read().await;
            vault::encrypt_with(&vault_state, &bytes)?
        };

        let cred_id = sqlx::query(
            "INSERT INTO credentials (kind, label, nonce, ciphertext) \
             VALUES ('private_key', ?, ?, ?)",
        )
        .bind(&label)
        .bind(&nonce)
        .bind(&ct)
        .execute(&mut **tx)
        .await?
        .last_insert_rowid();

        map.insert(raw.to_string(), cred_id);
        result.imported_keys.push(label);
    }

    Ok(map)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn collect_new_folder_paths_dedupes_and_orders_by_depth() {
        fn s(path: Vec<String>, name: &str) -> ParsedMobaSession {
            ParsedMobaSession {
                folder_path: path,
                name: name.into(),
                session_kind: "ssh".into(),
                host: "h".into(),
                port: 22,
                username: "u".into(),
                auth_type: "password".into(),
                private_key_path: None,
            }
        }
        let parsed = vec![
            s(vec!["A".into(), "B".into(), "C".into()], "s1"),
            s(vec!["A".into(), "B".into()], "s2"),
            s(vec!["A".into(), "D".into()], "s3"),
        ];
        let mut existing = HashMap::new();
        existing.insert(vec!["A".into()], 1_i64);

        let paths = collect_new_folder_paths(&parsed, &existing);
        // Existing "A" is excluded; the remaining four are deduped.
        assert_eq!(paths.len(), 3);
        // Depth-sorted: length 2 entries come before length 3.
        assert!(paths[0].len() <= paths[1].len());
        assert!(paths[1].len() <= paths[2].len());
        assert!(paths.contains(&vec!["A".into(), "B".into()]));
        assert!(paths.contains(&vec!["A".into(), "D".into()]));
        assert!(paths.contains(&vec!["A".into(), "B".into(), "C".into()]));
    }

    #[test]
    fn resolve_target_folder_empty_is_root() {
        let map: HashMap<Vec<String>, i64> = HashMap::new();
        assert_eq!(resolve_target_folder(&[], &map), Some(None));
    }

    #[test]
    fn build_folder_path_map_handles_nesting() {
        // a → b → c
        let rows = vec![
            (1_i64, None, "a".into()),
            (2_i64, Some(1), "b".into()),
            (3_i64, Some(2), "c".into()),
        ];
        let map = build_folder_path_map(&rows);
        assert_eq!(map.get(&vec!["a".into()]), Some(&1));
        assert_eq!(map.get(&vec!["a".into(), "b".into()]), Some(&2));
        assert_eq!(map.get(&vec!["a".into(), "b".into(), "c".into()]), Some(&3));
    }
}
