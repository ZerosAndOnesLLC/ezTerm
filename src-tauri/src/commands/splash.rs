//! Splash-window lifecycle.
//!
//! The app launches with two windows declared in `tauri.conf.json`:
//!
//! - `splash` — borderless 500×500, `alwaysOnTop`, shows `splash.html`
//!   which just renders the ezTerm logo. Starts visible.
//! - `main`  — the real app, starts with `visible: false` so the user
//!   never sees an empty webview while Next.js hydrates.
//!
//! The frontend calls `ui_ready` from its first effect once React is
//! past first paint. We floor the splash's visible duration so it
//! doesn't just flash on machines where startup is cache-warm, then
//! close it and reveal the main window. Idempotent — subsequent calls
//! (e.g. from a hot-reload) are no-ops because `get_webview_window`
//! returns `None` after the splash closes.
use std::time::Duration;

use tauri::{AppHandle, Manager, State};

use crate::error::Result;
use crate::state::AppState;

/// How long the splash stays visible at minimum, counted from
/// `AppState::started_at`. ~2 s lets the logo register as a branded
/// splash on fast hardware without feeling sluggish.
const SPLASH_MIN_VISIBLE: Duration = Duration::from_millis(2000);

#[tauri::command]
pub async fn ui_ready(state: State<'_, AppState>, app: AppHandle) -> Result<()> {
    let elapsed = state.started_at.elapsed();
    if elapsed < SPLASH_MIN_VISIBLE {
        tokio::time::sleep(SPLASH_MIN_VISIBLE - elapsed).await;
    }
    if let Some(splash) = app.get_webview_window("splash") {
        let _ = splash.close();
    }
    if let Some(main) = app.get_webview_window("main") {
        let _ = main.show();
        let _ = main.set_focus();
    }
    Ok(())
}
