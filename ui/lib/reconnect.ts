/** Auto-reconnect backoff (seconds): 1, 2, 4, 8, 16, then 30 flat. */
const BACKOFF_SECS = [1, 2, 4, 8, 16, 30] as const;

/** Give up after this many attempts (~8 minutes of trying) and fall back
 *  to the manual "Disconnected → Reconnect" card. */
export const MAX_RECONNECT_ATTEMPTS = 20;

/** Delay before reconnect attempt `attempt` (1-based), in milliseconds. */
export function reconnectDelayMs(attempt: number): number {
  const i = Math.min(Math.max(attempt, 1), BACKOFF_SECS.length) - 1;
  return BACKOFF_SECS[i] * 1000;
}
