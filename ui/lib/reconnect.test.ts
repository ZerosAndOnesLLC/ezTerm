import { describe, expect, it } from 'vitest';
import { MAX_RECONNECT_ATTEMPTS, isRetryableConnectError, reconnectDelayMs } from './reconnect';

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
    for (const c of [undefined, 'ssh', 'io']) expect(isRetryableConnectError(c)).toBe(true);
  });
  it('stops on errors the user must fix', () => {
    for (const c of ['auth_failed', 'auth_error', 'vault_locked', 'not_found', 'validation']) {
      expect(isRetryableConnectError(c)).toBe(false);
    }
  });
});
