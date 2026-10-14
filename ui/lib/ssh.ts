import { Channel } from '@tauri-apps/api/core';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';

/** Output channel passed to `ssh_connect` / `local_connect`. */
export type OutputChannel = Channel<ArrayBuffer>;

/**
 * Terminal output arrives on a Tauri IPC channel rather than an event:
 * payloads are raw bytes (an `ArrayBuffer` here) instead of a JSON
 * `number[]`, and the channel exists before the connect command runs so
 * no listener-registration race can drop the first bytes.
 */
export function createOutputChannel(onData: (bytes: Uint8Array) => void): OutputChannel {
  const ch = new Channel<ArrayBuffer>();
  ch.onmessage = (buf) => onData(new Uint8Array(buf));
  return ch;
}

export interface SshEventHandlers {
  onClose: (exitStatus: number | null) => void;
  onError: (message: string) => void;
}

/** Low-volume lifecycle events still travel as Tauri events, keyed by
 *  connection id. Local PTYs reuse the same topics. */
export async function subscribeSshEvents(connectionId: number, h: SshEventHandlers): Promise<UnlistenFn> {
  const unlisteners: UnlistenFn[] = [];
  unlisteners.push(await listen<number | null>(`ssh:close:${connectionId}`, (e) => {
    h.onClose(e.payload);
  }));
  unlisteners.push(await listen<string>(`ssh:error:${connectionId}`, (e) => {
    h.onError(e.payload);
  }));
  return () => unlisteners.forEach((u) => u());
}
