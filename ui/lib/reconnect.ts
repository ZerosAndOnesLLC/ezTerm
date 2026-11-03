/** Auto-reconnect backoff (seconds): 1, 2, 4, 8, 16, then 30 flat. */
const BACKOFF_SECS = [1, 2, 4, 8, 16, 30] as const;

/** Give up after this many attempts (~8 minutes of trying) and fall back
 *  to the manual Reconnect card. */
export const MAX_RECONNECT_ATTEMPTS = 20;

/** ±25 % spread so a blip that drops every tab doesn't send them all back
 *  in lock-step and trip the server's `MaxStartups` handshake limit. */
const JITTER = 0.25;

/** Delay before reconnect attempt `attempt` (1-based), in milliseconds.
 *  `rand` is injectable for tests; it must return a value in [0, 1). */
export function reconnectDelayMs(attempt: number, rand: () => number = Math.random): number {
  const i = Math.min(Math.max(attempt, 1), BACKOFF_SECS.length) - 1;
  const factor = 1 - JITTER + 2 * JITTER * rand();
  return Math.round(BACKOFF_SECS[i] * 1000 * factor);
}

/** Error codes no amount of retrying fixes — the user has to act. Host-key,
 *  auth-fix and X server cases are handled before this list is consulted. */
const NON_RETRYABLE_CODES: ReadonlySet<string> = new Set([
  'auth_failed',   // wrong credentials
  'auth_error',    // auth exchange broke: agent error, too many attempts
  'vault_locked',
  'not_found',     // session deleted
  'validation',    // bad session row / out-of-range slot
]);

export function isRetryableConnectError(code: string | undefined): boolean {
  return !code || !NON_RETRYABLE_CODES.has(code);
}
