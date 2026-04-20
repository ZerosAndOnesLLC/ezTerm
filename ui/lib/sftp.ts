import { listen, type UnlistenFn } from '@tauri-apps/api/event';
import type { TransferProgress } from './types';

/// Subscribe to progress events for one transfer. The Rust side emits
/// `sftp:transfer:{id}` with a `TransferProgress` payload; the final event
/// sets either `done: true` (success) or populates `error`.
///
/// Returns the unlisten function — the caller must invoke it on unmount to
/// avoid leaking listeners in long-lived sessions.
export async function subscribeTransfer(
  transferId: number,
  onProgress: (p: TransferProgress) => void,
): Promise<UnlistenFn> {
  return await listen<TransferProgress>(`sftp:transfer:${transferId}`, (e) => {
    onProgress(e.payload);
  });
}
