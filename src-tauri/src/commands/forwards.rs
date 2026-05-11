//! Tauri commands for SSH port forwarding. Persistent commands hit
//! the DB layer; runtime commands operate on the live `Connection`'s
//! `Forwards` registry. Both surfaces emit `forwards:status:{conn_id}`
//! events on every state transition so the side pane stays live.

use std::sync::Arc;

use serde::Deserialize;
use tauri::{AppHandle, Emitter, State};

use crate::commands::require_unlocked;
use crate::db;
use crate::error::{AppError, Result};
use crate::ssh::forwards::{ForwardKind, ForwardSpec, RuntimeForwardSummary};
use crate::state::AppState;

// ---------- Persistent ----------

#[tauri::command]
pub async fn forward_list(
    state: State<'_, AppState>,
    session_id: i64,
) -> Result<Vec<db::forwards::Forward>> {
    require_unlocked(&state).await?;
    db::forwards::list_for_session(&state.db, session_id).await
}

#[tauri::command]
pub async fn forward_create(
    state: State<'_, AppState>,
    session_id: i64,
    input: db::forwards::ForwardInput,
) -> Result<db::forwards::Forward> {
    require_unlocked(&state).await?;
    db::forwards::create(&state.db, session_id, &input).await
}

#[tauri::command]
pub async fn forward_update(
    state: State<'_, AppState>,
    id: i64,
    input: db::forwards::ForwardInput,
) -> Result<db::forwards::Forward> {
    require_unlocked(&state).await?;
    db::forwards::update(&state.db, id, &input).await
}

#[tauri::command]
pub async fn forward_delete(state: State<'_, AppState>, id: i64) -> Result<()> {
    require_unlocked(&state).await?;
    db::forwards::delete(&state.db, id).await
}

#[tauri::command]
pub async fn forward_reorder(
    state: State<'_, AppState>,
    session_id: i64,
    ids: Vec<i64>,
) -> Result<()> {
    require_unlocked(&state).await?;
    db::forwards::reorder(&state.db, session_id, &ids).await
}

// ---------- Runtime ----------

#[derive(Debug, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum ForwardStartTarget {
    Persistent { id: i64 },
    Ephemeral  { spec: ForwardSpec },
}

#[tauri::command]
pub async fn forward_runtime_list(
    state: State<'_, AppState>,
    connection_id: u64,
) -> Result<Vec<RuntimeForwardSummary>> {
    require_unlocked(&state).await?;
    let conn = state.ssh.get(connection_id).await
        .ok_or(AppError::NotFound)?;
    Ok(conn.forwards.list().await)
}

#[tauri::command]
pub async fn forward_start(
    state: State<'_, AppState>,
    app: AppHandle,
    connection_id: u64,
    target: ForwardStartTarget,
) -> Result<RuntimeForwardSummary> {
    require_unlocked(&state).await?;
    let conn = state.ssh.get(connection_id).await
        .ok_or(AppError::NotFound)?;

    let (spec, persistent_id): (ForwardSpec, Option<i64>) = match target {
        ForwardStartTarget::Persistent { id } => {
            let f = db::forwards::get(&state.db, id).await?;
            (spec_from_db(&f)?, Some(id))
        }
        ForwardStartTarget::Ephemeral { spec } => (spec, None),
    };

    start_inner(connection_id, app, conn.forwards.clone(),
                conn.ssh_handle.clone(), spec, persistent_id).await
}

#[tauri::command]
pub async fn forward_stop(
    state: State<'_, AppState>,
    connection_id: u64,
    runtime_id: u64,
) -> Result<()> {
    require_unlocked(&state).await?;
    let conn = state.ssh.get(connection_id).await
        .ok_or(AppError::NotFound)?;
    if let Some(rf) = conn.forwards.remove(runtime_id).await {
        if let Some(tx) = rf.stop_tx.lock().await.take() {
            let _ = tx.send(());
        }
    }
    Ok(())
}

#[tauri::command]
pub async fn forward_stop_all(
    state: State<'_, AppState>,
    connection_id: u64,
) -> Result<()> {
    require_unlocked(&state).await?;
    let conn = state.ssh.get(connection_id).await
        .ok_or(AppError::NotFound)?;
    conn.forwards.stop_all().await;
    Ok(())
}

// ---------- Internal helpers ----------

pub(crate) fn spec_from_db(f: &db::forwards::Forward) -> Result<ForwardSpec> {
    let kind = match f.kind.as_str() {
        "local"   => ForwardKind::Local,
        "remote"  => ForwardKind::Remote,
        "dynamic" => ForwardKind::Dynamic,
        other     => return Err(AppError::Validation(format!("bad kind {other}"))),
    };
    Ok(ForwardSpec {
        name:      f.name.clone(),
        kind,
        bind_addr: f.bind_addr.clone(),
        bind_port: f.bind_port as u16,
        dest_addr: f.dest_addr.clone(),
        dest_port: f.dest_port as u16,
    })
}

/// Pure runtime entry point — used by both `forward_start` and the
/// auto-start scan in `ssh::connect_impl`. Allocates a runtime id,
/// dispatches to the per-kind runtime, registers the resulting
/// `RuntimeForward` in the connection's registry, and returns its
/// summary. Status transitions emit `forwards:status:{connection_id}`.
pub(crate) async fn start_inner(
    connection_id: u64,
    app: AppHandle,
    forwards: Arc<crate::ssh::forwards::Forwards>,
    handle: Arc<tokio::sync::Mutex<russh::client::Handle<crate::ssh::client::ClientHandler>>>,
    spec: ForwardSpec,
    persistent_id: Option<i64>,
) -> Result<RuntimeForwardSummary> {
    let id = forwards.alloc_id();
    let event = format!("forwards:status:{connection_id}");
    let app_emit = app.clone();
    let on_status: Arc<dyn Fn(RuntimeForwardSummary) + Send + Sync> =
        Arc::new(move |s| {
            let _ = app_emit.emit(&event, &s);
        });

    let rf = match spec.kind {
        ForwardKind::Local => {
            crate::ssh::forwards::local::start(
                handle.clone(), spec.clone(), id, persistent_id, on_status.clone(),
            ).await?
        }
        ForwardKind::Remote => {
            crate::ssh::forwards::remote::start(
                handle.clone(), forwards.dispatch.clone(),
                spec.clone(), id, persistent_id, on_status.clone(),
            ).await?
        }
        ForwardKind::Dynamic => {
            crate::ssh::forwards::dynamic::start(
                handle.clone(), spec.clone(), id, persistent_id, on_status.clone(),
            ).await?
        }
    };
    forwards.insert(rf.clone()).await;
    Ok(rf.summary())
}
