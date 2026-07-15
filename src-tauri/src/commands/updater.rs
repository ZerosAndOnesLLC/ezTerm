use serde::Serialize;
use tauri::{AppHandle, Emitter, State};
use tauri_plugin_updater::UpdaterExt;

use crate::error::{AppError, Result};
use crate::state::AppState;

/// GitHub repo the updater channels resolve against. Kept in one place so the
/// stable endpoint and the pre-release API query can't drift apart.
const REPO: &str = "ZerosAndOnesLLC/ezTerm";

/// Stable channel: GitHub resolves `/releases/latest/` to the newest release
/// that is NOT a pre-release, so this always tracks the public build. Mirrors
/// the endpoint baked into `tauri.conf.json`.
fn stable_manifest_url() -> String {
    format!("https://github.com/{REPO}/releases/latest/download/latest.json")
}

/// Metadata about an available update, returned to the UI so it can render the
/// version diff and release notes before the user commits to installing.
/// Field names are snake_case to match the rest of the command layer.
#[derive(Serialize)]
pub struct UpdateInfo {
    current_version: String,
    version: String,
    /// RFC3339 publish date pulled from the manifest, when present.
    date: Option<String>,
    /// Release notes (the manifest's `notes` field).
    body: Option<String>,
    /// True when this update came from the pre-release channel — lets the UI
    /// badge it distinctly from a normal stable update.
    pre_release: bool,
}

/// Download progress, emitted on the `updater:progress` event during
/// `updater_download_install`.
#[derive(Clone, Serialize)]
struct ProgressPayload {
    /// `"progress"` for each chunk, `"finished"` once the install completes.
    event: &'static str,
    downloaded: u64,
    total: Option<u64>,
}

/// Resolve the pre-release channel's manifest URL by asking the GitHub API for
/// the newest non-draft release (pre-release OR stable, whichever is newer —
/// standard beta-channel behavior) and pointing at that release's
/// `latest.json` asset. Drafts are excluded because their assets aren't
/// publicly downloadable without an auth token.
async fn prerelease_manifest_url() -> Result<String> {
    let api = format!("https://api.github.com/repos/{REPO}/releases?per_page=20");
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(30))
        .build()
        .map_err(|e| AppError::Updater(format!("http client: {e}")))?;
    // GitHub requires a User-Agent on every API request.
    let body = client
        .get(&api)
        .header(reqwest::header::USER_AGENT, "ezTerm-updater")
        .header(reqwest::header::ACCEPT, "application/vnd.github+json")
        .send()
        .await
        .map_err(|e| AppError::Updater(format!("github releases: {e}")))?
        .error_for_status()
        .map_err(|e| AppError::Updater(format!("github releases: {e}")))?
        .text()
        .await
        .map_err(|e| AppError::Updater(format!("github releases: {e}")))?;

    let releases: serde_json::Value = serde_json::from_str(&body)
        .map_err(|e| AppError::Updater(format!("parse releases: {e}")))?;
    let arr = releases
        .as_array()
        .ok_or_else(|| AppError::Updater("unexpected releases response".into()))?;

    // The API returns releases newest-first; take the first that isn't a
    // draft. That's the newest publicly installable build of either kind.
    let tag = arr
        .iter()
        .find(|r| !r.get("draft").and_then(|d| d.as_bool()).unwrap_or(false))
        .and_then(|r| r.get("tag_name").and_then(|t| t.as_str()))
        .ok_or_else(|| AppError::Updater("no installable release found".into()))?;

    Ok(format!(
        "https://github.com/{REPO}/releases/download/{tag}/latest.json"
    ))
}

/// Check for an update on the requested channel. `pre_release` selects the
/// beta channel (newest release including pre-releases); false uses the stable
/// channel. The resulting `Update`, if any, is stashed in `AppState` so
/// `updater_download_install` can act on the exact release the user reviewed.
///
/// Not gated on `require_unlocked`: the updater surfaces on the unlock screen
/// too, and it exposes no vault data.
#[tauri::command]
pub async fn updater_check(
    app: AppHandle,
    state: State<'_, AppState>,
    pre_release: bool,
) -> Result<Option<UpdateInfo>> {
    let endpoint = if pre_release {
        prerelease_manifest_url().await?
    } else {
        stable_manifest_url()
    };
    let url = reqwest::Url::parse(&endpoint)
        .map_err(|e| AppError::Updater(format!("bad endpoint: {e}")))?;

    let updater = app
        .updater_builder()
        .endpoints(vec![url])
        .map_err(|e| AppError::Updater(e.to_string()))?
        .build()
        .map_err(|e| AppError::Updater(e.to_string()))?;

    let found = updater
        .check()
        .await
        .map_err(|e| AppError::Updater(e.to_string()))?;

    let info = found.as_ref().map(|u| UpdateInfo {
        current_version: u.current_version.clone(),
        version: u.version.clone(),
        // Prefer the manifest's original `pub_date` string to avoid pulling
        // in `time` formatting; fall back to the parsed date's display.
        date: u
            .raw_json
            .get("pub_date")
            .and_then(|d| d.as_str())
            .map(str::to_string)
            .or_else(|| u.date.map(|d| d.to_string())),
        body: u.body.clone(),
        pre_release,
    });

    *state.pending_update.lock().await = found;
    Ok(info)
}

/// Download and install the update discovered by the most recent
/// `updater_check`, emitting `updater:progress` events as bytes arrive. On
/// success the caller is expected to relaunch (via `plugin-process`). Errors
/// if no check has run or the last check found nothing.
#[tauri::command]
pub async fn updater_download_install(app: AppHandle, state: State<'_, AppState>) -> Result<()> {
    let update = state
        .pending_update
        .lock()
        .await
        .take()
        .ok_or_else(|| AppError::Updater("no update pending — run a check first".into()))?;

    let app_progress = app.clone();
    let mut downloaded: u64 = 0;
    update
        .download_and_install(
            move |chunk, total| {
                downloaded += chunk as u64;
                let _ = app_progress.emit(
                    "updater:progress",
                    ProgressPayload {
                        event: "progress",
                        downloaded,
                        total,
                    },
                );
            },
            move || {
                let _ = app.emit(
                    "updater:progress",
                    ProgressPayload {
                        event: "finished",
                        downloaded: 0,
                        total: None,
                    },
                );
            },
        )
        .await
        .map_err(|e| AppError::Updater(e.to_string()))?;

    Ok(())
}
