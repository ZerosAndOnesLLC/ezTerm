#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

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
        .run(tauri::generate_context!())
        .expect("error while running ezTerm");
}

fn resolve_db_path() -> std::path::PathBuf {
    let base = directories::ProjectDirs::from("com", "ZerosAndOnes", "ezTerm")
        .map(|d| d.data_local_dir().to_path_buf())
        .unwrap_or_else(|| std::path::PathBuf::from("./"));
    base.join("ezterm.sqlite")
}
