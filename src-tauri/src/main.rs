#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod commands;
mod db;
mod error;
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
    let app_state = AppState::new(pool);

    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .manage(app_state)
        .invoke_handler(tauri::generate_handler![
            commands::folders::folder_list,
            commands::folders::folder_create,
            commands::folders::folder_rename,
            commands::folders::folder_delete,
            commands::folders::folder_move,
        ])
        .run(tauri::generate_context!())
        .expect("error while running ezTerm");
}

fn resolve_db_path() -> std::path::PathBuf {
    let dirs = directories::ProjectDirs::from("com", "ZerosAndOnes", "ezTerm")
        .expect("failed to resolve platform data directory");
    dirs.data_local_dir().join("ezterm.sqlite")
}
