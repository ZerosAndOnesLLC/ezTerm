//! Chunked upload/download for WSL connections. Mirrors
//! `sftp/transfer.rs` byte-for-byte on the event side (same
//! `sftp:transfer:{id}` channel + `TransferProgress` payload) so the
//! frontend `TransferStatus` strip doesn't need to know whether the
//! transfer is real SFTP or a Plan 9 copy.
//!
//! Why not `tokio::fs::copy`? It's faster but emits no progress and
//! has no per-chunk cancel point. For the SFTP-pane UX (visible
//! progress bar, error attribution to the failing chunk), we replicate
//! the SSH path's read-loop + emit pattern.

use std::path::Path;
use std::time::{Duration, Instant};

use tauri::{AppHandle, Emitter};
use tokio::io::{AsyncReadExt, AsyncWriteExt};

use crate::error::{AppError, Result};
use crate::sftp::transfer::TransferProgress;

use super::handle::WslFsHandle;

const CHUNK: usize = 32 * 1024;
const PROGRESS_THROTTLE: Duration = Duration::from_millis(100);

pub async fn upload(
    app: &AppHandle,
    handle: &WslFsHandle,
    transfer_id: u64,
    local_path: &Path,
    remote_path: &str,
) -> Result<()> {
    let event = format!("sftp:transfer:{transfer_id}");
    let mut local = tokio::fs::File::open(local_path).await?;
    let total = local.metadata().await?.len();
    let unc = handle.linux_to_unc(remote_path);

    let result: Result<()> = async {
        let mut remote = tokio::fs::File::create(&unc)
            .await
            .map_err(|e| AppError::Sftp(format!("open remote: {e}")))?;
        let mut sent: u64 = 0;
        let mut buf = vec![0u8; CHUNK];
        let mut last_emit = Instant::now();
        loop {
            let n = local.read(&mut buf).await?;
            if n == 0 {
                break;
            }
            remote
                .write_all(&buf[..n])
                .await
                .map_err(|e| AppError::Sftp(format!("write: {e}")))?;
            sent += n as u64;
            if last_emit.elapsed() >= PROGRESS_THROTTLE {
                let _ = app.emit(
                    &event,
                    TransferProgress {
                        transfer_id,
                        bytes_sent: sent,
                        total_bytes: total,
                        done: false,
                        error: None,
                    },
                );
                last_emit = Instant::now();
            }
        }
        remote.flush().await?;
        let _ = app.emit(
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
    }
    .await;

    if let Err(e) = &result {
        let _ = app.emit(
            &event,
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

pub async fn upload_bytes(
    app: &AppHandle,
    handle: &WslFsHandle,
    transfer_id: u64,
    bytes: &[u8],
    remote_path: &str,
) -> Result<()> {
    let event = format!("sftp:transfer:{transfer_id}");
    let total = bytes.len() as u64;
    let unc = handle.linux_to_unc(remote_path);

    let result: Result<()> = async {
        let mut remote = tokio::fs::File::create(&unc)
            .await
            .map_err(|e| AppError::Sftp(format!("open remote: {e}")))?;
        let mut sent: u64 = 0;
        let mut last_emit = Instant::now();
        for chunk in bytes.chunks(CHUNK) {
            remote
                .write_all(chunk)
                .await
                .map_err(|e| AppError::Sftp(format!("write: {e}")))?;
            sent += chunk.len() as u64;
            if last_emit.elapsed() >= PROGRESS_THROTTLE {
                let _ = app.emit(
                    &event,
                    TransferProgress {
                        transfer_id,
                        bytes_sent: sent,
                        total_bytes: total,
                        done: false,
                        error: None,
                    },
                );
                last_emit = Instant::now();
            }
        }
        remote.flush().await?;
        let _ = app.emit(
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
    }
    .await;

    if let Err(e) = &result {
        let _ = app.emit(
            &event,
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

pub async fn download(
    app: &AppHandle,
    handle: &WslFsHandle,
    transfer_id: u64,
    remote_path: &str,
    local_path: &Path,
) -> Result<()> {
    let event = format!("sftp:transfer:{transfer_id}");
    let unc = handle.linux_to_unc(remote_path);

    let mut local = tokio::fs::File::create(local_path).await?;

    let result: Result<()> = async {
        let meta = tokio::fs::metadata(&unc)
            .await
            .map_err(|e| AppError::Sftp(format!("stat: {e}")))?;
        let total = meta.len();
        let mut remote = tokio::fs::File::open(&unc)
            .await
            .map_err(|e| AppError::Sftp(format!("open: {e}")))?;
        let mut received: u64 = 0;
        let mut buf = vec![0u8; CHUNK];
        let mut last_emit = Instant::now();
        loop {
            let n = remote
                .read(&mut buf)
                .await
                .map_err(|e| AppError::Sftp(format!("read: {e}")))?;
            if n == 0 {
                break;
            }
            local.write_all(&buf[..n]).await?;
            received += n as u64;
            if last_emit.elapsed() >= PROGRESS_THROTTLE {
                let _ = app.emit(
                    &event,
                    TransferProgress {
                        transfer_id,
                        bytes_sent: received,
                        total_bytes: total,
                        done: false,
                        error: None,
                    },
                );
                last_emit = Instant::now();
            }
        }
        local.flush().await?;
        let _ = app.emit(
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
    }
    .await;

    if let Err(e) = &result {
        let _ = app.emit(
            &event,
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
