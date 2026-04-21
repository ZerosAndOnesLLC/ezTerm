//! Backup / restore Tauri commands.
//!
//! Export gate: master-password reauth (defeats "unlocked-laptop walkup"
//! exfiltration) + separate backup passphrase wrapping the archive.
//!
//! Restore flow: parse envelope → preview (counts + minimal metadata for
//! the selection UI) → commit (selective, rename-on-conflict).

use std::collections::HashMap;

use base64::{engine::general_purpose::STANDARD as B64, Engine};
use chrono::Utc;
use serde::{Deserialize, Serialize};
use tauri::State;
use tokio::fs;
use zeroize::Zeroize;

use crate::backup::{self, Bundle, CredentialEntry, SessionEntry, SettingEntry};
use crate::commands::require_unlocked;
use crate::db;
use crate::error::{AppError, Result};
use crate::state::AppState;
use crate::vault;

/// Cap the backup file we'll read on restore. A normal export weighs in
/// under 1 MB even with hundreds of sessions and RSA-4096 keys. 50 MB
/// leaves wide headroom without letting a crafted file OOM us.
const MAX_BACKUP_FILE_SIZE: u64 = 50 * 1024 * 1024;

#[derive(Debug, Serialize, Default)]
pub struct BackupSummary {
    pub folders:      usize,
    pub sessions:     usize,
    pub credentials:  usize,
    pub known_hosts:  usize,
    pub settings:     usize,
}

#[derive(Debug, Serialize)]
pub struct BackupPreview {
    pub created_at:    String,
    pub app_version:   String,
    pub folders:       Vec<db::folders::Folder>,
    pub sessions:      Vec<SessionPreview>,
    pub credentials:   Vec<CredentialPreview>,
    pub known_hosts:   Vec<KnownHostPreview>,
    pub setting_count: usize,
}

#[derive(Debug, Serialize)]
pub struct SessionPreview {
    pub id:           i64,
    pub folder_id:    Option<i64>,
    pub name:         String,
    pub host:         String,
    pub port:         i64,
    pub username:     String,
    pub session_kind: String,
    pub auth_type:    String,
    /// Present when the session references a credential in the same backup.
    /// The selection UI uses this to warn when a session is selected but
    /// its credential isn't.
    pub credential_id: Option<i64>,
}

#[derive(Debug, Serialize)]
pub struct CredentialPreview {
    pub id:    i64,
    pub kind:  String,
    pub label: String,
}

#[derive(Debug, Serialize)]
pub struct KnownHostPreview {
    pub host: String,
    pub port: i64,
    pub fingerprint_sha256: String,
}

#[derive(Debug, Deserialize, Default)]
pub struct SelectionSpec {
    #[serde(default)]
    pub folder_ids:       Vec<i64>,
    #[serde(default)]
    pub session_ids:      Vec<i64>,
    #[serde(default)]
    pub credential_ids:   Vec<i64>,
    #[serde(default)]
    pub known_hosts:      Vec<(String, i64)>,
    #[serde(default)]
    pub include_settings: bool,
}

#[derive(Debug, Serialize, Default)]
pub struct RestoreSummary {
    pub folders_created:      usize,
    pub sessions_created:     usize,
    pub credentials_created:  usize,
    pub known_hosts_upserted: usize,
    pub settings_applied:     usize,
    /// Names that were renamed to avoid a collision (label / folder /
    /// session name). Populated so the UI can show "imported as:" list.
    pub renamed:              Vec<String>,
}

// ===== export ============================================================

#[tauri::command]
pub async fn backup_create(
    state: State<'_, AppState>,
    path: String,
    master_password: String,
    passphrase: String,
) -> Result<BackupSummary> {
    let mut master = master_password;
    let mut pass = passphrase;
    let out = backup_create_inner(&state, &path, &master, &pass).await;
    master.zeroize();
    pass.zeroize();
    out
}

async fn backup_create_inner(
    state: &State<'_, AppState>,
    path: &str,
    master_password: &str,
    passphrase: &str,
) -> Result<BackupSummary> {
    require_unlocked(state).await?;

    // Reauth gate — the vault being unlocked isn't sufficient because the
    // user may have walked away from a signed-in session. Re-deriving and
    // comparing against the verifier is the same work as an unlock but
    // without touching any state.
    if !vault::verify_password(&state.db, master_password).await? {
        return Err(AppError::BadPassword);
    }

    // Load every data type. Credentials are collected with their ciphertext
    // + nonce so we can decrypt in-memory and pack plaintexts into the
    // passphrase-wrapped bundle.
    let folders = db::folders::list(&state.db).await?;
    let sessions_raw = db::sessions::list(&state.db).await?;
    let mut sessions: Vec<SessionEntry> = Vec::with_capacity(sessions_raw.len());
    for s in sessions_raw {
        let env = db::sessions::env_get(&state.db, s.id).await?;
        sessions.push(SessionEntry { session: s, env });
    }

    let cred_metas = db::credentials::list(&state.db).await?;
    let mut credentials: Vec<CredentialEntry> = Vec::with_capacity(cred_metas.len());
    for meta in cred_metas {
        let row = db::credentials::get(&state.db, meta.id).await?;
        let pt = {
            let vs = state.vault.read().await;
            vault::decrypt_with(&vs, &row.nonce, &row.ciphertext)?
        };
        credentials.push(CredentialEntry {
            id:        meta.id,
            kind:      meta.kind,
            label:     meta.label,
            secret_b64: B64.encode(&pt),
        });
    }

    let known_hosts = db::known_hosts::list(&state.db).await?;
    let settings = db::settings::list_all(&state.db).await?;
    let settings_entries: Vec<SettingEntry> = settings
        .into_iter()
        .map(|(key, value)| SettingEntry { key, value })
        .collect();

    let summary = BackupSummary {
        folders:     folders.len(),
        sessions:    sessions.len(),
        credentials: credentials.len(),
        known_hosts: known_hosts.len(),
        settings:    settings_entries.len(),
    };

    let bundle = Bundle {
        version:     backup::BACKUP_VERSION,
        created_at:  Utc::now().to_rfc3339(),
        app_version: env!("CARGO_PKG_VERSION").to_string(),
        folders,
        sessions,
        credentials,
        known_hosts,
        settings: settings_entries,
    };

    let wrapped = backup::encrypt_bundle(&bundle, passphrase)?;
    fs::write(path, wrapped).await?;
    Ok(summary)
}

// ===== preview (read + decrypt + summarise) ==============================

#[tauri::command]
pub async fn backup_preview(
    state: State<'_, AppState>,
    path: String,
    passphrase: String,
) -> Result<BackupPreview> {
    let mut pass = passphrase;
    let out = backup_preview_inner(&state, &path, &pass).await;
    pass.zeroize();
    out
}

async fn backup_preview_inner(
    state: &State<'_, AppState>,
    path: &str,
    passphrase: &str,
) -> Result<BackupPreview> {
    require_unlocked(state).await?;

    let meta = fs::metadata(path).await?;
    if meta.len() > MAX_BACKUP_FILE_SIZE {
        return Err(AppError::Validation("backup file too large".into()));
    }
    let bytes = fs::read(path).await?;
    let bundle = backup::decrypt_bundle(&bytes, passphrase)?;

    Ok(BackupPreview {
        created_at:    bundle.created_at,
        app_version:   bundle.app_version,
        folders:       bundle.folders,
        sessions: bundle
            .sessions
            .iter()
            .map(|e| SessionPreview {
                id:           e.session.id,
                folder_id:    e.session.folder_id,
                name:         e.session.name.clone(),
                host:         e.session.host.clone(),
                port:         e.session.port,
                username:     e.session.username.clone(),
                session_kind: e.session.session_kind.clone(),
                auth_type:    e.session.auth_type.clone(),
                credential_id: e.session.credential_id,
            })
            .collect(),
        credentials: bundle
            .credentials
            .iter()
            .map(|c| CredentialPreview {
                id:    c.id,
                kind:  c.kind.clone(),
                label: c.label.clone(),
            })
            .collect(),
        known_hosts: bundle
            .known_hosts
            .iter()
            .map(|k| KnownHostPreview {
                host: k.host.clone(),
                port: k.port,
                fingerprint_sha256: k.fingerprint_sha256.clone(),
            })
            .collect(),
        setting_count: bundle.settings.len(),
    })
}

// ===== commit (selective, rename-on-conflict) ============================

#[tauri::command]
pub async fn backup_restore(
    state: State<'_, AppState>,
    path: String,
    passphrase: String,
    selection: SelectionSpec,
) -> Result<RestoreSummary> {
    let mut pass = passphrase;
    let out = backup_restore_inner(&state, &path, &pass, &selection).await;
    pass.zeroize();
    out
}

async fn backup_restore_inner(
    state: &State<'_, AppState>,
    path: &str,
    passphrase: &str,
    selection: &SelectionSpec,
) -> Result<RestoreSummary> {
    require_unlocked(state).await?;

    let meta = fs::metadata(path).await?;
    if meta.len() > MAX_BACKUP_FILE_SIZE {
        return Err(AppError::Validation("backup file too large".into()));
    }
    let bytes = fs::read(path).await?;
    let bundle = backup::decrypt_bundle(&bytes, passphrase)?;

    let mut result = RestoreSummary::default();

    // ---- 1. Credentials ----------------------------------------------------
    //
    // Re-encrypt each selected credential with the current vault key before
    // inserting. Build an old-id → new-id map so sessions can remap their
    // `credential_id` / `key_passphrase_credential_id` references.
    let mut cred_id_map: HashMap<i64, i64> = HashMap::new();
    let existing_labels: Vec<String> = db::credentials::list(&state.db)
        .await?
        .into_iter()
        .map(|c| c.label)
        .collect();
    for entry in &bundle.credentials {
        if !selection.credential_ids.contains(&entry.id) {
            continue;
        }
        let pt = B64
            .decode(&entry.secret_b64)
            .map_err(|_| AppError::Validation("credential plaintext not base64".into()))?;
        let (nonce, ct) = {
            let vs = state.vault.read().await;
            vault::encrypt_with(&vs, &pt)?
        };
        let final_label = unique_name(&entry.label, &existing_labels, &mut result.renamed);
        let new_id = db::credentials::insert(
            &state.db,
            &entry.kind,
            &final_label,
            &nonce,
            &ct,
        )
        .await?;
        cred_id_map.insert(entry.id, new_id);
        result.credentials_created += 1;
    }

    // ---- 2. Folders --------------------------------------------------------
    //
    // Topological insert: parents before children. The backup's parent_id
    // references are source IDs; we translate them as we go. A selected
    // folder whose parent isn't selected lands at root.
    let mut folder_id_map: HashMap<i64, i64> = HashMap::new();
    let mut pending: Vec<&db::folders::Folder> = bundle
        .folders
        .iter()
        .filter(|f| selection.folder_ids.contains(&f.id))
        .collect();
    // Stable topological pass: repeat until nothing moves. Source data
    // should already be well-formed but this tolerates odd inputs.
    let mut safety = pending.len() * 2 + 1;
    while !pending.is_empty() && safety > 0 {
        safety -= 1;
        let mut progressed = false;
        let mut still_pending: Vec<&db::folders::Folder> = Vec::new();
        for f in pending.drain(..) {
            let ready = match f.parent_id {
                None => true,
                Some(pid) => folder_id_map.contains_key(&pid)
                    || !selection.folder_ids.contains(&pid),
            };
            if !ready {
                still_pending.push(f);
                continue;
            }
            let new_parent = f.parent_id.and_then(|p| folder_id_map.get(&p).copied());
            let existing: Vec<String> = db::folders::list(&state.db)
                .await?
                .into_iter()
                .filter(|x| x.parent_id == new_parent)
                .map(|x| x.name)
                .collect();
            let final_name = unique_name(&f.name, &existing, &mut result.renamed);
            let created = db::folders::create(&state.db, new_parent, &final_name).await?;
            folder_id_map.insert(f.id, created.id);
            result.folders_created += 1;
            progressed = true;
        }
        pending = still_pending;
        if !progressed {
            break;
        }
    }

    // ---- 3. Sessions -------------------------------------------------------
    for entry in &bundle.sessions {
        if !selection.session_ids.contains(&entry.session.id) {
            continue;
        }
        let target_folder = entry
            .session
            .folder_id
            .and_then(|fid| folder_id_map.get(&fid).copied());
        let existing: Vec<String> = db::sessions::list(&state.db)
            .await?
            .into_iter()
            .filter(|s| s.folder_id == target_folder)
            .map(|s| s.name)
            .collect();
        let final_name = unique_name(&entry.session.name, &existing, &mut result.renamed);
        let remapped_cred = entry
            .session
            .credential_id
            .and_then(|c| cred_id_map.get(&c).copied());
        let remapped_pass = entry
            .session
            .key_passphrase_credential_id
            .and_then(|c| cred_id_map.get(&c).copied());
        let input = db::sessions::SessionInput {
            folder_id: target_folder,
            name: final_name,
            host: entry.session.host.clone(),
            port: entry.session.port,
            username: entry.session.username.clone(),
            auth_type: entry.session.auth_type.clone(),
            credential_id: remapped_cred,
            key_passphrase_credential_id: remapped_pass,
            color: entry.session.color.clone(),
            initial_command: entry.session.initial_command.clone(),
            scrollback_lines: entry.session.scrollback_lines,
            font_size: entry.session.font_size,
            font_family: entry.session.font_family.clone(),
            cursor_style: entry.session.cursor_style.clone(),
            compression: entry.session.compression,
            keepalive_secs: entry.session.keepalive_secs,
            connect_timeout_secs: entry.session.connect_timeout_secs,
            env: entry.env.clone(),
            session_kind: entry.session.session_kind.clone(),
            forward_x11: entry.session.forward_x11,
        };
        db::sessions::create(&state.db, &input).await?;
        result.sessions_created += 1;
    }

    // ---- 4. Known hosts (upsert — no rename, natural (host,port) key) -----
    for kh in &bundle.known_hosts {
        let key = (kh.host.clone(), kh.port);
        if !selection.known_hosts.contains(&key) {
            continue;
        }
        db::known_hosts::upsert(
            &state.db,
            &kh.host,
            kh.port,
            &kh.key_type,
            &kh.fingerprint,
            &kh.fingerprint_sha256,
        )
        .await?;
        result.known_hosts_upserted += 1;
    }

    // ---- 5. Settings (optional, upsert-by-key) ----------------------------
    if selection.include_settings {
        for s in &bundle.settings {
            db::settings::set(&state.db, &s.key, &s.value).await?;
            result.settings_applied += 1;
        }
    }

    state.sync.trigger();
    Ok(result)
}

/// Append " (N)" suffixes until the candidate doesn't collide. Tracks
/// every rename so the UI can echo "imported as: foo (2)". Case-sensitive
/// compare matches the rest of the app.
fn unique_name(base: &str, existing: &[String], renamed: &mut Vec<String>) -> String {
    if !existing.iter().any(|e| e == base) {
        return base.to_string();
    }
    let mut n = 2;
    loop {
        let candidate = format!("{base} ({n})");
        if !existing.iter().any(|e| e == &candidate) {
            renamed.push(candidate.clone());
            return candidate;
        }
        n += 1;
    }
}
