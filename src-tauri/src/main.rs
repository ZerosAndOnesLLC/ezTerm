#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod commands;
mod db;
mod error;
mod log_redacted;
mod sftp;
mod ssh;
mod state;
mod vault;

use state::AppState;

#[tokio::main]
async fn main() {
    tracing_subscriber::fmt()
        .with_env_filter(tracing_subscriber::EnvFilter::from_default_env())
        .init();

    let db_path = resolve_db_path();
    let pool = db::init_pool(&db_path).await.expect("init db");
    let initialized = vault::is_initialized(&pool).await.expect("vault check");
    let initial_state = if initialized {
        vault::VaultState::Locked
    } else {
        vault::VaultState::Uninitialized
    };
    let app_state = AppState::new(pool);
    *app_state.vault.write().await = initial_state;

    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .manage(app_state)
        .invoke_handler(tauri::generate_handler![
            commands::folders::folder_list,
            commands::folders::folder_create,
            commands::folders::folder_rename,
            commands::folders::folder_delete,
            commands::folders::folder_move,
            commands::credentials::credential_list,
            commands::credentials::credential_create,
            commands::credentials::credential_delete,
            commands::sessions::session_list,
            commands::sessions::session_get,
            commands::sessions::session_create,
            commands::sessions::session_update,
            commands::sessions::session_delete,
            commands::sessions::session_duplicate,
            commands::settings::settings_get,
            commands::settings::settings_set,
            commands::vault::vault_status,
            commands::vault::vault_init,
            commands::vault::vault_unlock,
            commands::vault::vault_lock,
            commands::ssh::ssh_connect,
            commands::ssh::ssh_write,
            commands::ssh::ssh_resize,
            commands::ssh::ssh_disconnect,
            commands::ssh::known_host_list,
            commands::ssh::known_host_remove,
        ])
        .run(tauri::generate_context!())
        .expect("error while running ezTerm");
}

fn resolve_db_path() -> std::path::PathBuf {
    let dirs = directories::ProjectDirs::from("com", "ZerosAndOnes", "ezTerm")
        .expect("failed to resolve platform data directory");
    dirs.data_local_dir().join("ezterm.sqlite")
}
