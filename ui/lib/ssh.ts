import { listen, type UnlistenFn } from '@tauri-apps/api/event';

export interface SshEventHandlers {
  onData:  (bytes: Uint8Array) => void;
  onClose: (exitStatus: number | null) => void;
  onError: (message: string) => void;
}

export async function subscribeSshEvents(connectionId: number, h: SshEventHandlers): Promise<UnlistenFn> {
  const unlisteners: UnlistenFn[] = [];
  unlisteners.push(await listen<number[]>(`ssh:data:${connectionId}`, (e) => {
    h.onData(new Uint8Array(e.payload));
  }));
  unlisteners.push(await listen<number | null>(`ssh:close:${connectionId}`, (e) => {
    h.onClose(e.payload);
  }));
  unlisteners.push(await listen<string>(`ssh:error:${connectionId}`, (e) => {
    h.onError(e.payload);
  }));
  return () => unlisteners.forEach((u) => u());
}
