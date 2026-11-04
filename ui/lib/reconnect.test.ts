import { describe, expect, it } from 'vitest';
import {
  FLAP_WINDOW_MS, MAX_RECONNECT_ATTEMPTS, authLostShouldStop, flapResumeAttempt,
  isRetryableConnectError, reconnectDelayMs, shouldRetryReattach,
} from './reconnect';

const mid = () => 0.5; // jitter factor exactly 1

describe('reconnectDelayMs', () => {
  it('backs off exponentially then caps at 30s', () => {
    expect([1, 2, 3, 4, 5, 6, 7, 20].map((a) => reconnectDelayMs(a, mid))).toEqual(
      [1000, 2000, 4000, 8000, 16000, 30000, 30000, 30000],
    );
  });
  it('clamps nonsense attempts to the first step', () => {
    expect(reconnectDelayMs(0, mid)).toBe(1000);
    expect(reconnectDelayMs(-5, mid)).toBe(1000);
  });
  it('jitters within ±25%', () => {
    expect(reconnectDelayMs(6, () => 0)).toBe(22500);
    expect(reconnectDelayMs(6, () => 0.999999)).toBe(37500);
    for (let i = 0; i < 200; i++) {
      const d = reconnectDelayMs(3);
      expect(d).toBeGreaterThanOrEqual(3000);
      expect(d).toBeLessThanOrEqual(5000);
    }
  });
  it('gives up after a bounded total wait', () => {
    let total = 0;
    for (let a = 1; a <= MAX_RECONNECT_ATTEMPTS; a++) total += reconnectDelayMs(a, () => 0.999999);
    expect(total).toBeLessThanOrEqual(12 * 60 * 1000);
  });
});

describe('isRetryableConnectError', () => {
  it('retries transport-level failures', () => {
    for (const c of [undefined, 'ssh', 'io', 'auth_lost']) expect(isRetryableConnectError(c)).toBe(true);
  });
  it('stops on errors the user must fix', () => {
    for (const c of ['auth_failed', 'auth_error', 'vault_locked', 'not_found', 'validation']) {
      expect(isRetryableConnectError(c)).toBe(false);
    }
  });
});

describe('flapResumeAttempt', () => {
  it('starts at 1 with no recent reconnect', () => {
    expect(flapResumeAttempt(null, 1000)).toBe(1);
    expect(flapResumeAttempt({ at: 0, attempt: 7 }, FLAP_WINDOW_MS)).toBe(1);
  });
  it('continues the count when the link flaps soon after a reconnect', () => {
    expect(flapResumeAttempt({ at: 1000, attempt: 7 }, 1000 + FLAP_WINDOW_MS - 1)).toBe(8);
  });
});

describe('shouldRetryReattach', () => {
  const base = { auto: true, wasPersistent: true, wantPersistent: true, persistent: false };
  it('retries only a transient probe failure', () => {
    expect(shouldRetryReattach({ ...base, reason: 'probe_failed' })).toBe(true);
  });
  it('accepts the plain shell for permanent reasons', () => {
    for (const reason of ['missing', 'no_posix_shell', 'channel_refused', 'tool_error', null, undefined]) {
      expect(shouldRetryReattach({ ...base, reason })).toBe(false);
    }
  });
  it('never applies to manual connects, first connects, opted-out sessions or persistent results', () => {
    const r = 'probe_failed';
    expect(shouldRetryReattach({ ...base, auto: false, reason: r })).toBe(false);
    expect(shouldRetryReattach({ ...base, wasPersistent: false, reason: r })).toBe(false);
    expect(shouldRetryReattach({ ...base, wantPersistent: false, reason: r })).toBe(false);
    expect(shouldRetryReattach({ ...base, persistent: true, reason: r })).toBe(false);
  });
});

describe('authLostShouldStop', () => {
  it('retries the first lost-during-login, stops on the second in a row', () => {
    expect(authLostShouldStop(1)).toBe(false);
    expect(authLostShouldStop(2)).toBe(true);
    expect(authLostShouldStop(5)).toBe(true);
  });
});
