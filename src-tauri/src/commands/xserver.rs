use tauri::State;

use crate::commands::require_unlocked;
use crate::error::{AppError, Result};
use crate::packaging;
use crate::state::AppState;
use crate::xserver::{self, XServerStatus};

#[tauri::command]
pub async fn xserver_status(state: State<'_, AppState>) -> Result<XServerStatus> {
    require_unlocked(&state).await?;
    Ok(state.xserver.status().await)
}

/// Download + silent-install VcXsrv into the user's per-user data dir.
/// Returns the absolute path to the installed `vcxsrv.exe` on success.
/// Triggered by the "Install VcXsrv" button in the `XServerMissingDialog`
/// when a session enables X11 forwarding but no VcXsrv is available.
#[tauri::command]
pub async fn xserver_install(state: State<'_, AppState>) -> Result<String> {
    require_unlocked(&state).await?;
    // The Store package always carries VcXsrv, and Store policy bars
    // downloading and running executables from outside the package.
    if packaging::install_channel().store_managed() {
        return Err(AppError::Validation(
            "VcXsrv ships inside the Microsoft Store package; reinstall ezTerm from the Store to restore it".into(),
        ));
    }
    let path = xserver::install_vcxsrv().await?;
    Ok(path.to_string_lossy().into_owned())
}
