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

/** A link that drops again within this long of an auto-reconnect counts as
 *  the same outage: the attempt count continues instead of restarting. */
export const FLAP_WINDOW_MS = 60_000;

/** Attempt number to start the loop at after a link loss. `prevOk` is the
 *  last successful *auto*-reconnect (cleared by a manual one). */
export function flapResumeAttempt(
  prevOk: { at: number; attempt: number } | null,
  now: number,
  windowMs: number = FLAP_WINDOW_MS,
): number {
  if (prevOk && now - prevOk.at < windowMs) return prevOk.attempt + 1;
  return 1;
}

/** Should an auto-reconnect that came back *without* tmux/screen be thrown
 *  away and retried? Only when the previous connection really was
 *  persistent, the session still wants it, and the reason is transient
 *  (`probe_failed`: timed out / odd output on a loaded server). Permanent
 *  reasons (tool missing, no POSIX shell, MaxSessions, broken screen dir)
 *  accept the plain shell + notice, as before — retrying can't fix them. */
export function shouldRetryReattach(o: {
  auto: boolean;
  wasPersistent: boolean;
  wantPersistent: boolean;
  persistent: boolean;
  reason: string | null | undefined;
}): boolean {
  return o.auto && o.wasPersistent && o.wantPersistent && !o.persistent
    && o.reason === 'probe_failed';
}

/** `auth_lost` (link died mid-login, no DISCONNECT from the server) is
 *  retried once. A second one in a row stops the loop: if the server's
 *  refusal went unrecorded, retrying would keep re-offering credentials and
 *  risk fail2ban or an account lockout. `streak` counts consecutive
 *  `auth_lost` outcomes including this one. */
export function authLostShouldStop(streak: number): boolean {
  return streak >= 2;
}
