import { Channel } from '@tauri-apps/api/core';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';

/**
 * Terminal output arrives on a Tauri IPC channel rather than an event:
 * payloads are raw bytes (an `ArrayBuffer` here; chunks under 1 KiB
 * still cross as a JSON array that Tauri wraps back into a buffer), and
 * the channel exists before the connect command runs so no
 * listener-registration race can drop the first bytes.
 *
 * Lifecycle:
 *   - created → chunks are **buffered**. The remote shell's prompt setup
 *     can include a cursor-position query (`ESC[6n`); xterm answers it
 *     synchronously via `onData`, so nothing may reach xterm until the
 *     keystroke handler is wired or the reply is lost and the shell hangs.
 *   - `arm()` → buffered chunks are flushed, later ones go straight through.
 *   - `detach()` → everything from now on is dropped. Called before the
 *     terminal is disposed; Rust keeps sending until it processes the
 *     close, and xterm throws on write after dispose.
 */
export interface OutputChannel {
  /** Pass this to `ssh_connect` / `local_connect`. */
  channel: Channel<ArrayBuffer>;
  /** Chunks delivered so far (buffered ones count once flushed). */
  received(): number;
  arm(): void;
  detach(): void;
}

export function createOutputChannel(onData: (bytes: Uint8Array) => void): OutputChannel {
  const ch = new Channel<ArrayBuffer>();
  let armed = false;
  let detached = false;
  let count = 0;
  let pending: Uint8Array[] = [];
  const deliver = (bytes: Uint8Array) => { count += 1; onData(bytes); };
  ch.onmessage = (buf) => {
    if (detached) return;
    const bytes = new Uint8Array(buf);
    if (armed) deliver(bytes);
    else pending.push(bytes);
  };
  return {
    channel: ch,
    received: () => count,
    arm() {
      if (armed || detached) return;
      armed = true;
      const queued = pending;
      pending = [];
      for (const b of queued) deliver(b);
    },
    detach() {
      detached = true;
      pending = [];
      ch.onmessage = () => {};
    },
  };
}

/** `ssh:close` payload: a numeric exit status, a human-readable reason
 *  (e.g. "killed by SIGKILL"), or null when the channel just ended. */
export type CloseReason = number | string | null;

export interface SshEventHandlers {
  onClose: (reason: CloseReason) => void;
  onError: (message: string) => void;
}

/** Low-volume lifecycle events still travel as Tauri events, keyed by
 *  connection id. Local PTYs reuse the same topics. */
export async function subscribeSshEvents(connectionId: number, h: SshEventHandlers): Promise<UnlistenFn> {
  const unlisteners: UnlistenFn[] = [];
  unlisteners.push(await listen<CloseReason>(`ssh:close:${connectionId}`, (e) => {
    h.onClose(e.payload);
  }));
  unlisteners.push(await listen<string>(`ssh:error:${connectionId}`, (e) => {
    h.onError(e.payload);
  }));
  return () => unlisteners.forEach((u) => u());
}

/** Output-stall watchdog. Tauri delivers channel messages strictly in
 *  index order; a chunk whose transfer fails is logged by Tauri and never
 *  delivered, after which every later chunk queues forever and the
 *  terminal silently freezes. Rust counts chunks it has sent; the
 *  frontend counts chunks it has received.
 *
 *  A tick first checks for local progress — if the received count moved
 *  since the last tick the channel is demonstrably alive and Rust is not
 *  asked. Only a quiet tab costs an IPC call. If Rust is ahead and the
 *  received count stays put across two consecutive ticks, the stream is
 *  wedged. Ticks never overlap (an await in flight skips the next tick),
 *  so a frozen main thread cannot replay queued ticks back to back. The
 *  count query failing with `not_found` means the connection is gone and
 *  the watchdog stops; any other failure is transient and polling
 *  continues. Returns a stop function. */
export function startOutputWatchdog(
  output: OutputChannel,
  sentCount: () => Promise<number>,
  onStall: () => void,
  intervalMs = 3000,
): () => void {
  let lastReceived = output.received();
  let behindPolls = 0;
  let stopped = false;
  let inFlight = false;
  const stop = () => { stopped = true; clearInterval(timer); };
  const tick = async () => {
    if (stopped || inFlight) return;
    const before = output.received();
    if (before !== lastReceived) {
      lastReceived = before;
      behindPolls = 0;
      return;
    }
    inFlight = true;
    let sent: number;
    try {
      sent = await sentCount();
    } catch (e: unknown) {
      inFlight = false;
      if ((e as { code?: string })?.code === 'not_found') stop();
      return;
    }
    inFlight = false;
    if (stopped) return;
    const after = output.received();
    if (after !== before) {
      lastReceived = after;
      behindPolls = 0;
      return;
    }
    behindPolls = sent > before ? behindPolls + 1 : 0;
    if (behindPolls >= 2) { stop(); onStall(); }
  };
  const timer = setInterval(() => { void tick(); }, intervalMs);
  return stop;
}
