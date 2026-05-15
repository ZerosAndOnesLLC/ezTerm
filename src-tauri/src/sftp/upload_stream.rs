//! Streaming SFTP uploads — phase A3 of issue #28. Lifts the 256 MB
//! cap that `sftp_upload_bytes` had to enforce (since the whole file
//! had to fit in webview memory + the IPC buffer). The frontend now
//! slices the dropped `File` into chunks via `File.slice()` /
//! `Blob.arrayBuffer()` and ships each chunk through `sftp_upload_chunk`.
//!
//! Lifecycle:
//! 1. `sftp_upload_begin(cid, path)` — spawns a writer task that owns
//!    the SFTP session lock, opens the remote file, and waits on an
//!    mpsc channel for chunks. Returns an `upload_id`.
//! 2. `sftp_upload_chunk(upload_id, bytes)` — pushes one chunk into
//!    the channel and awaits the writer's ack. The ack lets the
//!    frontend detect remote write errors (disk full, permission
//!    denied) on the chunk that failed, not at finish time.
//! 3. `sftp_upload_finish(upload_id)` — flushes and closes the
//!    remote handle, removes the entry from the registry.
//! 4. `sftp_upload_abort(upload_id)` — best-effort cleanup if the
//!    user cancels a drag mid-upload. The writer task drops the
//!    handle without flushing; the remote file is left as-is.
//!
//! Concurrency: the writer task holds the per-connection SFTP session
//! lock for the FULL duration of the upload. Other SFTP commands on
//! the same connection block until the upload finishes. This matches
//! the existing `transfer::upload` behaviour (one transfer at a time
//! per session). Concurrent uploads require per-file SFTP sessions,
//! which is post-v0.3.

use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};

use russh_sftp::client::SftpSession;
use tokio::io::AsyncWriteExt;
use tokio::sync::{mpsc, oneshot, RwLock};

use crate::error::{AppError, Result};
use crate::sftp::SftpHandle;

/// Bounded so the frontend gets backpressure if the SFTP link is slow —
/// at most this many chunks can be in flight before chunk() blocks.
const CHANNEL_DEPTH: usize = 4;

enum UploadCmd {
    Data(Vec<u8>, oneshot::Sender<Result<()>>),
    Finish(oneshot::Sender<Result<()>>),
    Abort,
}

struct UploadState {
    tx: mpsc::Sender<UploadCmd>,
}

#[derive(Default)]
pub struct UploadStreamRegistry {
    inner:    RwLock<HashMap<u64, UploadState>>,
    next_id:  AtomicU64,
}

impl UploadStreamRegistry {
    pub fn new() -> Self { Self::default() }

    fn alloc_id(&self) -> u64 {
        self.next_id.fetch_add(1, Ordering::Relaxed) + 1
    }

    /// Spawn the writer task and return an upload_id the frontend can
    /// use to push chunks. The writer holds the SFTP session lock for
    /// its lifetime and shuts down cleanly on Finish/Abort/channel-close.
    pub async fn begin(
        &self,
        handle: std::sync::Arc<SftpHandle>,
        remote_path: String,
    ) -> Result<u64> {
        let upload_id = self.alloc_id();
        let (tx, rx) = mpsc::channel::<UploadCmd>(CHANNEL_DEPTH);
        self.inner.write().await.insert(upload_id, UploadState { tx });
        tokio::spawn(async move {
            let _ = writer_task(handle, remote_path, rx).await;
        });
        Ok(upload_id)
    }

    pub async fn chunk(&self, upload_id: u64, bytes: Vec<u8>) -> Result<()> {
        let tx = {
            let g = self.inner.read().await;
            g.get(&upload_id)
                .map(|s| s.tx.clone())
                .ok_or_else(|| AppError::Validation("unknown upload_id".into()))?
        };
        let (ack_tx, ack_rx) = oneshot::channel();
        tx.send(UploadCmd::Data(bytes, ack_tx))
            .await
            .map_err(|_| AppError::Sftp("upload writer task exited".into()))?;
        // Await the writer's per-chunk ack. If the writer dropped the
        // oneshot (task panicked / shut down), surface a clear error
        // rather than hanging.
        ack_rx
            .await
            .map_err(|_| AppError::Sftp("upload writer task dropped chunk ack".into()))?
    }

    pub async fn finish(&self, upload_id: u64) -> Result<()> {
        let state = self
            .inner
            .write()
            .await
            .remove(&upload_id)
            .ok_or_else(|| AppError::Validation("unknown upload_id".into()))?;
        let (ack_tx, ack_rx) = oneshot::channel();
        state
            .tx
            .send(UploadCmd::Finish(ack_tx))
            .await
            .map_err(|_| AppError::Sftp("upload writer task exited".into()))?;
        ack_rx
            .await
            .map_err(|_| AppError::Sftp("upload writer task dropped finish ack".into()))?
    }

    pub async fn abort(&self, upload_id: u64) -> Result<()> {
        let Some(state) = self.inner.write().await.remove(&upload_id) else {
            return Ok(()); // already gone — idempotent
        };
        let _ = state.tx.send(UploadCmd::Abort).await;
        Ok(())
    }
}

async fn writer_task(
    handle: std::sync::Arc<SftpHandle>,
    remote_path: String,
    mut rx: mpsc::Receiver<UploadCmd>,
) -> Result<()> {
    handle
        .with_session(async move |s: &mut SftpSession| -> Result<()> {
            let mut w = s
                .create(&remote_path)
                .await
                .map_err(|e| AppError::Sftp(format!("open remote: {e}")))?;
            while let Some(cmd) = rx.recv().await {
                match cmd {
                    UploadCmd::Data(bytes, ack) => {
                        let r = w
                            .write_all(&bytes)
                            .await
                            .map_err(|e| AppError::Sftp(format!("write: {e}")));
                        // Drop the bytes immediately after write so a
                        // slow-network upload doesn't pin the chunk in
                        // memory while the next one is being received.
                        drop(bytes);
                        let _ = ack.send(r);
                    }
                    UploadCmd::Finish(ack) => {
                        let r = w
                            .shutdown()
                            .await
                            .map_err(|e| AppError::Sftp(format!("close: {e}")));
                        let _ = ack.send(r);
                        return Ok(());
                    }
                    UploadCmd::Abort => {
                        // Drop the writer without shutdown — the remote
                        // is left with whatever bytes we've written so
                        // far. Best-effort cleanup; for "remove partial
                        // file" we'd need an extra SFTP op which itself
                        // can fail mid-abort.
                        return Ok(());
                    }
                }
            }
            // Channel closed without explicit Finish/Abort — treat as
            // abort, which avoids hanging the writer if the registry
            // entry was force-removed.
            Ok(())
        })
        .await
}
