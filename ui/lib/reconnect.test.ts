import { describe, expect, it } from 'vitest';
import { MAX_RECONNECT_ATTEMPTS, reconnectDelayMs } from './reconnect';

describe('reconnectDelayMs', () => {
  it('backs off exponentially then caps at 30s', () => {
    expect([1, 2, 3, 4, 5, 6, 7, 20].map(reconnectDelayMs)).toEqual(
      [1000, 2000, 4000, 8000, 16000, 30000, 30000, 30000],
    );
  });
  it('clamps nonsense attempts to the first step', () => {
    expect(reconnectDelayMs(0)).toBe(1000);
    expect(reconnectDelayMs(-5)).toBe(1000);
  });
  it('gives up after a bounded total wait', () => {
    let total = 0;
    for (let a = 1; a <= MAX_RECONNECT_ATTEMPTS; a++) total += reconnectDelayMs(a);
    expect(total).toBeLessThanOrEqual(10 * 60 * 1000);
  });
});
