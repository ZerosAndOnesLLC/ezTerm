//! Splash-window lifecycle.
//!
//! The app launches with two windows declared in `tauri.conf.json`:
//!
//! - `splash` — borderless 500×500, `alwaysOnTop`, shows `splash.html`
//!   which just renders the ezTerm logo. Starts visible.
//! - `main`  — the real app, starts visible (behind the always-on-top
//!   splash). It MUST start visible: when the main window is created
//!   hidden, WebView2's drag-source machinery never fully initialises
//!   on Windows, which breaks HTML5 `dragstart` in the sessions
//!   sidebar (used for re-ordering and moving between folders).
//!   (See tauri#14643 / wry#1639; the wry 0.54 fix covered drop-target
//!   init but not drag-source.) The splash covers the main window
//!   during Next.js hydration so users still see a branded splash
//!   rather than an empty webview.
//!
//! Drag-OUT of remote SFTP files to Windows Explorer is not
//! supported in this app (and cannot be supported from any current
//! WebView2 host): host-side `DoDragDrop` returns E_FAIL once
//! WebView2 has loaded, and HTML5 `dragstart` → OS drag conversion
//! is silently dropped by Chromium under WebView2. Right-click →
//! Download… in the SFTP pane is the supported download UX.
//!
//! The frontend calls `ui_ready` from its first effect once React is
//! past first paint. We floor the splash's visible duration so it
//! doesn't just flash on machines where startup is cache-warm, then
//! close it and focus the main window. Idempotent — subsequent calls
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
