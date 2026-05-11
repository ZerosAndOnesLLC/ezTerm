use tauri::{AppHandle, State};

use crate::commands::require_unlocked;
use crate::error::Result;
use crate::local;
use crate::state::AppState;

#[derive(serde::Serialize)]
pub struct LocalConnectResult {
    pub connection_id: u64,
}

#[tauri::command]
pub async fn local_connect(
    state: State<'_, AppState>,
    app: AppHandle,
    session_id: i64,
    cols: u16,
    rows: u16,
) -> Result<LocalConnectResult> {
    require_unlocked(&state).await?;
    let out = local::spawn_from_session(&state, app, session_id, cols, rows).await?;
    Ok(LocalConnectResult {
        connection_id: out.connection_id,
    })
}

#[tauri::command]
pub async fn local_write(
    state: State<'_, AppState>,
    connection_id: u64,
    bytes: Vec<u8>,
) -> Result<()> {
    state.local.write(connection_id, bytes).await;
    Ok(())
}

#[tauri::command]
pub async fn local_resize(
    state: State<'_, AppState>,
    connection_id: u64,
    cols: u16,
    rows: u16,
) -> Result<()> {
    state.local.resize(connection_id, cols, rows).await;
    Ok(())
}

#[tauri::command]
pub async fn local_disconnect(state: State<'_, AppState>, connection_id: u64) -> Result<()> {
    state.local.close(connection_id).await;
    Ok(())
}

/// Signals the backend that the frontend has finished installing its
/// `ssh:data:<id>` listener and the reader thread can start emitting.
/// Idempotent — called exactly once per connect, but repeat calls are
/// harmless no-ops. See `crate::local` module docs for the race this
/// prevents.
#[tauri::command]
pub async fn local_ready(state: State<'_, AppState>, connection_id: u64) -> Result<()> {
    state.local.unlock_reader(connection_id).await;
    Ok(())
}

/// Returns the list of installed WSL distros (trimmed, in registered order).
/// Empty when WSL is not installed or the command fails.
#[tauri::command]
pub async fn wsl_list_distros(state: State<'_, AppState>) -> Result<Vec<String>> {
    require_unlocked(&state).await?;
    Ok(tokio::task::spawn_blocking(detect_wsl_distros_blocking)
        .await
        .unwrap_or_default())
}

/// Serializes concurrent autodetect calls. React 18 strict-mode in the
/// dev build can fire two mount effects back-to-back before the first
/// one's promise resolves; without this lock both calls race into a
/// "find WSL folder → create if missing" sequence and we end up with
/// two duplicate folders.
static AUTODETECT_LOCK: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

/// Invoked from the frontend once per vault unlock. If WSL is installed,
/// creates (or reuses) a single root-level "WSL" folder and adds one
/// session per detected distro.
///
/// Also consolidates pre-existing duplicates: if multiple root-level
/// "WSL" folders exist (leftover from an earlier race before this lock
/// was added), all sessions are moved into the lowest-id folder and the
/// extra folders are deleted.
#[tauri::command]
pub async fn wsl_autodetect_seed(state: State<'_, AppState>) -> Result<usize> {
    require_unlocked(&state).await?;
    let _guard = AUTODETECT_LOCK.lock().await;

    let distros = tokio::task::spawn_blocking(detect_wsl_distros_blocking)
        .await
        .unwrap_or_default();
    if distros.is_empty() {
        return Ok(0);
    }

    // Resolve (or consolidate) the root-level "WSL" folder.
    let folders = crate::db::folders::list(&state.db).await?;
    let wsl_folders: Vec<_> = folders
        .iter()
        .filter(|f| f.parent_id.is_none() && f.name == "WSL")
        .collect();
    let folder = match wsl_folders.as_slice() {
        [] => crate::db::folders::create(&state.db, None, "WSL").await?,
        [only] => (*only).clone(),
        many => {
            // Pick lowest-id as canonical. Move sessions in others into it,
            // then delete the duplicates.
            let mut sorted = many.to_vec();
            sorted.sort_by_key(|f| f.id);
            let canonical = sorted[0].clone();
            for dup in sorted.iter().skip(1) {
                sqlx::query("UPDATE sessions SET folder_id = ? WHERE folder_id = ?")
                    .bind(canonical.id)
                    .bind(dup.id)
                    .execute(&state.db)
                    .await?;
                crate::db::folders::delete(&state.db, dup.id).await?;
            }
            canonical
        }
    };

    // Add sessions for distros that don't already exist in the canonical
    // folder (matched by name).
    let existing = crate::db::sessions::list(&state.db).await?;
    let mut created = 0usize;
    for distro in &distros {
        let already = existing.iter().any(|s| {
            s.folder_id == Some(folder.id) && s.name == distro.as_str()
        });
        if already {
            continue;
        }
        let input = crate::db::sessions::SessionInput {
            folder_id: Some(folder.id),
            name: distro.clone(),
            host: distro.clone(),
            port: 22,
            username: String::new(),
            auth_type: "agent".into(),
            credential_id: None,
            key_passphrase_credential_id: None,
            color: Some("#34d399".into()),
            initial_command: None,
            scrollback_lines: 5000,
            font_size: 13,
            font_family: String::new(),
            cursor_style: "block".into(),
            compression: 0,
            keepalive_secs: 0,
            connect_timeout_secs: 15,
            env: Vec::new(),
            session_kind: "wsl".into(),
            forward_x11: 0,
            starting_dir: None,
        };
        crate::db::sessions::create(&state.db, &input).await?;
        created += 1;
    }

    Ok(created)
}

/// Same race-protection pattern as `AUTODETECT_LOCK` above, scoped to
/// the cross-platform Local Shells autodetect-seed flow.
static LOCAL_SHELLS_AUTODETECT_LOCK: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

/// Invoked from the frontend once per vault unlock on every platform.
/// Detects local shells (Unix: `/etc/shells`; Windows: cmd / powershell
/// / pwsh-if-present), creates (or reuses) a single root-level
/// "Local Shells" folder, and adds one session per detected shell not
/// already in that folder. Idempotent across re-runs.
///
/// Returns the number of newly inserted sessions; 0 means either
/// nothing was detectable on this host or every shell was already
/// seeded.
#[tauri::command]
pub async fn local_shells_autodetect_seed(state: State<'_, AppState>) -> Result<usize> {
    require_unlocked(&state).await?;
    let _guard = LOCAL_SHELLS_AUTODETECT_LOCK.lock().await;

    let shells = tokio::task::spawn_blocking(crate::local::shells::detect_local_shells)
        .await
        .unwrap_or_default();
    if shells.is_empty() {
        return Ok(0);
    }

    // Resolve (or consolidate) the root-level "Local Shells" folder —
    // same dedupe pattern as the WSL flow.
    let folders = crate::db::folders::list(&state.db).await?;
    let local_folders: Vec<_> = folders
        .iter()
        .filter(|f| f.parent_id.is_none() && f.name == "Local Shells")
        .collect();
    let folder = match local_folders.as_slice() {
        [] => crate::db::folders::create(&state.db, None, "Local Shells").await?,
        [only] => (*only).clone(),
        many => {
            let mut sorted = many.to_vec();
            sorted.sort_by_key(|f| f.id);
            let canonical = sorted[0].clone();
            for dup in sorted.iter().skip(1) {
                sqlx::query("UPDATE sessions SET folder_id = ? WHERE folder_id = ?")
                    .bind(canonical.id)
                    .bind(dup.id)
                    .execute(&state.db)
                    .await?;
                crate::db::folders::delete(&state.db, dup.id).await?;
            }
            canonical
        }
    };

    let existing = crate::db::sessions::list(&state.db).await?;
    let mut created = 0usize;
    for shell in &shells {
        let already = existing.iter().any(|s| {
            s.folder_id == Some(folder.id) && s.name == shell.display_name
        });
        if already {
            continue;
        }
        let input = crate::db::sessions::SessionInput {
            folder_id: Some(folder.id),
            name: shell.display_name.clone(),
            host: shell.program.clone(),
            port: 0,
            username: String::new(),
            auth_type: "agent".into(),
            credential_id: None,
            key_passphrase_credential_id: None,
            color: Some("#34d399".into()),
            initial_command: None,
            scrollback_lines: 5000,
            font_size: 13,
            font_family: String::new(),
            cursor_style: "block".into(),
            compression: 0,
            keepalive_secs: 0,
            connect_timeout_secs: 15,
            env: Vec::new(),
            session_kind: "local".into(),
            forward_x11: 0,
            starting_dir: None,
        };
        crate::db::sessions::create(&state.db, &input).await?;
        created += 1;
    }

    Ok(created)
}

/// Returns the list of detected local shells without touching the DB.
/// Used by the session dialog to populate its shell-picker dropdown.
#[tauri::command]
pub async fn list_local_shells(
    state: State<'_, AppState>,
) -> Result<Vec<crate::local::shells::DetectedShell>> {
    require_unlocked(&state).await?;
    Ok(
        tokio::task::spawn_blocking(crate::local::shells::detect_local_shells)
            .await
            .unwrap_or_default(),
    )
}

/// Returns the current build target as a stable string the frontend
/// can switch on. Cheaper than pulling in `tauri-plugin-os` for a
/// single OS branch.
#[tauri::command]
pub fn platform() -> &'static str {
    if cfg!(target_os = "windows") {
        "windows"
    } else if cfg!(target_os = "macos") {
        "macos"
    } else if cfg!(target_os = "linux") {
        "linux"
    } else {
        "other"
    }
}

/// Distro names WSL registers for internal use (Docker Desktop,
/// Rancher, Podman Desktop, etc.). Users don't want these showing up
/// as shell tabs — they're not meant to be interacted with directly
/// and `wsl.exe -d docker-desktop` typically errors or drops into a
/// stripped-down busybox environment.
const WSL_INTERNAL_DISTROS: &[&str] = &[
    "docker-desktop",
    "docker-desktop-data",
    "rancher-desktop",
    "rancher-desktop-data",
    "podman-machine-default",
];

fn is_internal_distro(name: &str) -> bool {
    let n = name.trim().to_ascii_lowercase();
    WSL_INTERNAL_DISTROS.iter().any(|skip| n == *skip)
}

fn detect_wsl_distros_blocking() -> Vec<String> {
    // `wsl.exe -l --quiet` prints one distro per line; on Windows it emits
    // the output as UTF-16LE. We decode defensively so a rogue byte doesn't
    // bubble up as a Rust error — if the exe is missing or WSL isn't
    // installed we just return an empty list.
    let output = match std::process::Command::new("wsl.exe")
        .args(["-l", "--quiet"])
        .output()
    {
        Ok(o) => o,
        Err(e) => {
            eprintln!("[wsl-autodetect] wsl.exe spawn failed: {e}");
            return Vec::new();
        }
    };
    if !output.status.success() {
        eprintln!(
            "[wsl-autodetect] wsl.exe exit {:?} stderr={}",
            output.status.code(),
            String::from_utf8_lossy(&output.stderr)
        );
        return Vec::new();
    }
    let text = decode_wsl_output(&output.stdout);
    let distros: Vec<String> = text
        .lines()
        .map(|l| l.trim().trim_matches('\0').to_string())
        .filter(|l| !l.is_empty())
        .filter(|l| !is_internal_distro(l))
        .collect();
    eprintln!("[wsl-autodetect] detected {} distros: {:?}", distros.len(), distros);
    distros
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn internal_distros_are_filtered() {
        assert!(is_internal_distro("docker-desktop"));
        assert!(is_internal_distro("Docker-Desktop")); // case-insensitive
        assert!(is_internal_distro("docker-desktop-data"));
        assert!(is_internal_distro("rancher-desktop"));
        assert!(is_internal_distro("podman-machine-default"));
        assert!(!is_internal_distro("Ubuntu-24.04"));
        assert!(!is_internal_distro("Debian"));
        assert!(!is_internal_distro("my-custom-docker-distro"));
    }
}

fn decode_wsl_output(bytes: &[u8]) -> String {
    // wsl.exe output is UTF-16LE on Windows. Decode pairs of bytes into
    // u16 code units and then into a String via char::decode_utf16.
    if bytes.len() >= 2 && bytes.len() % 2 == 0 {
        let u16s: Vec<u16> = bytes
            .chunks_exact(2)
            .map(|c| u16::from_le_bytes([c[0], c[1]]))
            .collect();
        return char::decode_utf16(u16s)
            .filter_map(|r| r.ok())
            .collect();
    }
    String::from_utf8_lossy(bytes).into_owned()
}
