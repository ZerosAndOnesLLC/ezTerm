use std::path::Path;

use serde::Serialize;
use tauri::{AppHandle, Emitter};
use tokio::io::{AsyncReadExt, AsyncWriteExt};

use super::session::SftpHandle;
use crate::error::{AppError, Result};

/// Chunk size for streaming transfers. 32 KiB is a compromise: large enough to
/// amortise syscall / SFTP packet overhead, small enough to let the UI see
/// progress events at a reasonable cadence on slow links.
const CHUNK: usize = 32 * 1024;

/// Progress event payload emitted to the frontend on the `sftp:transfer:{id}`
/// channel. A transfer emits one event per chunk plus a final event with
/// `done = true` (or with `error = Some(..)` if the transfer failed).
#[derive(Serialize, Clone)]
pub struct TransferProgress {
    pub transfer_id: u64,
    pub bytes_sent: u64,
    pub total_bytes: u64,
    pub done: bool,
    pub error: Option<String>,
}

/// Stream a local file to a remote path, emitting `TransferProgress` events.
///
/// Holds the SFTP session lock for the full duration of the transfer — SFTP
/// operations on a single session are not safely interleaved, and the common
/// case is one transfer at a time. Concurrent uploads would require per-file
/// sessions, which is a post-v0.3 concern.
pub async fn upload(
    app: &AppHandle,
    handle: &SftpHandle,
    transfer_id: u64,
    local_path: &Path,
    remote_path: &str,
) -> Result<()> {
    let mut local = tokio::fs::File::open(local_path).await?;
    let total = local.metadata().await?.len();

    let remote_path = remote_path.to_owned();
    let event = format!("sftp:transfer:{transfer_id}");
    let app_cloned = app.clone();

    let result: Result<()> = handle
        .with_session(
            async move |s: &mut russh_sftp::client::SftpSession| -> Result<()> {
                let mut w = s
                    .create(&remote_path)
                    .await
                    .map_err(|e| AppError::Sftp(format!("open remote: {e}")))?;
                let mut sent: u64 = 0;
                let mut buf = vec![0u8; CHUNK];
                loop {
                    let n = local.read(&mut buf).await?;
                    if n == 0 {
                        break;
                    }
                    w.write_all(&buf[..n])
                        .await
                        .map_err(|e| AppError::Sftp(format!("write: {e}")))?;
                    sent += n as u64;
                    let _ = app_cloned.emit(
                        &event,
                        TransferProgress {
                            transfer_id,
                            bytes_sent: sent,
                            total_bytes: total,
                            done: false,
                            error: None,
                        },
                    );
                }
                w.shutdown()
                    .await
                    .map_err(|e| AppError::Sftp(format!("close: {e}")))?;
                let _ = app_cloned.emit(
                    &event,
                    TransferProgress {
                        transfer_id,
                        bytes_sent: sent,
                        total_bytes: total,
                        done: true,
                        error: None,
                    },
                );
                Ok(())
            },
        )
        .await;

    if let Err(e) = &result {
        let _ = app.emit(
            &format!("sftp:transfer:{transfer_id}"),
            TransferProgress {
                transfer_id,
                bytes_sent: 0,
                total_bytes: total,
                done: true,
                error: Some(e.to_string()),
            },
        );
    }

    result
}

/// Stream a remote file to a local path, emitting `TransferProgress` events.
pub async fn download(
    app: &AppHandle,
    handle: &SftpHandle,
    transfer_id: u64,
    remote_path: &str,
    local_path: &Path,
) -> Result<()> {
    let remote_path = remote_path.to_owned();
    let event = format!("sftp:transfer:{transfer_id}");
    let app_cloned = app.clone();

    let mut local = tokio::fs::File::create(local_path).await?;

    let result: Result<()> = handle
        .with_session(
            async move |s: &mut russh_sftp::client::SftpSession| -> Result<()> {
                let meta = s
                    .metadata(&remote_path)
                    .await
                    .map_err(|e| AppError::Sftp(format!("stat: {e}")))?;
                let total = meta.size.unwrap_or(0);

                let mut r = s
                    .open(&remote_path)
                    .await
                    .map_err(|e| AppError::Sftp(format!("open: {e}")))?;
                let mut received: u64 = 0;
                let mut buf = vec![0u8; CHUNK];
                loop {
                    let n = r.read(&mut buf).await.map_err(|e| {
                        AppError::Sftp(format!("read: {e}"))
                    })?;
                    if n == 0 {
                        break;
                    }
                    local.write_all(&buf[..n]).await?;
                    received += n as u64;
                    let _ = app_cloned.emit(
                        &event,
                        TransferProgress {
                            transfer_id,
                            bytes_sent: received,
                            total_bytes: total,
                            done: false,
                            error: None,
                        },
                    );
                }
                local.flush().await?;
                let _ = app_cloned.emit(
                    &event,
                    TransferProgress {
                        transfer_id,
                        bytes_sent: received,
                        total_bytes: total,
                        done: true,
                        error: None,
                    },
                );
                Ok(())
            },
        )
        .await;

    if let Err(e) = &result {
        let _ = app.emit(
            &format!("sftp:transfer:{transfer_id}"),
            TransferProgress {
                transfer_id,
                bytes_sent: 0,
                total_bytes: 0,
                done: true,
                error: Some(e.to_string()),
            },
        );
    }

    result
}
