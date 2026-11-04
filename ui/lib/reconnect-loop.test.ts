import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ReconnectLoop, type AttemptOutcome } from './reconnect-loop';

type State = { attempt: number; at: number } | null;

function setup(outcomes: AttemptOutcome[] | (() => Promise<AttemptOutcome>), max = 5) {
  const states: State[] = [];
  const calls: number[] = [];
  let gaveUp = 0;
  const queue = Array.isArray(outcomes) ? [...outcomes] : null;
  const loop = new ReconnectLoop({
    attempt: async (n) => {
      calls.push(n);
      if (!queue) return (outcomes as () => Promise<AttemptOutcome>)();
      return queue.shift() ?? 'retryable';
    },
    onState: (s) => states.push(s),
    onGiveUp: () => { gaveUp += 1; },
    delayMs: (n) => n * 1000,
    maxAttempts: max,
    now: () => Date.now(),
  });
  return { loop, states, calls, gaveUp: () => gaveUp };
}

describe('ReconnectLoop', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it('retries with backoff until an attempt succeeds', async () => {
    const t = setup(['retryable', 'retryable', 'ok']);
    t.loop.start();
    await vi.advanceTimersByTimeAsync(999);
    expect(t.calls).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    expect(t.calls).toEqual([1]);
    await vi.advanceTimersByTimeAsync(2000);
    expect(t.calls).toEqual([1, 2]);
    await vi.advanceTimersByTimeAsync(3000);
    expect(t.calls).toEqual([1, 2, 3]);
    expect(t.states.at(-1)).toBeNull();
    expect(t.loop.active).toBe(false);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(t.calls).toEqual([1, 2, 3]);
  });

  it('stops on a fatal outcome without giving up', async () => {
    const t = setup(['retryable', 'fatal']);
    t.loop.start();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(t.calls).toEqual([1, 2]);
    expect(t.gaveUp()).toBe(0);
    expect(t.states.at(-1)).toBeNull();
  });

  it('gives up after maxAttempts transient failures', async () => {
    const t = setup([], 3);
    t.loop.start();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(t.calls).toEqual([1, 2, 3]);
    expect(t.gaveUp()).toBe(1);
  });

  it('retryNow fires the pending attempt immediately and keeps the count', async () => {
    const t = setup(['retryable', 'ok']);
    t.loop.start();
    t.loop.retryNow();
    await vi.advanceTimersByTimeAsync(0);
    expect(t.calls).toEqual([1]);
    // Next attempt is #2 on its normal 2s delay.
    t.loop.retryNow();
    await vi.advanceTimersByTimeAsync(0);
    expect(t.calls).toEqual([1, 2]);
  });

  it('retryNow is a no-op while an attempt is in flight', async () => {
    let release!: (o: AttemptOutcome) => void;
    const t = setup(() => new Promise<AttemptOutcome>((r) => { release = r; }));
    t.loop.start();
    await vi.advanceTimersByTimeAsync(1000);
    t.loop.retryNow();
    expect(t.calls).toEqual([1]);
    release('ok');
  });

  it('cancel during an in-flight attempt never re-arms the loop', async () => {
    let release!: (o: AttemptOutcome) => void;
    const t = setup(() => new Promise<AttemptOutcome>((r) => { release = r; }));
    t.loop.start();
    await vi.advanceTimersByTimeAsync(1000);
    expect(t.calls).toEqual([1]);
    t.loop.cancel();
    release('retryable');
    await vi.advanceTimersByTimeAsync(60_000);
    expect(t.calls).toEqual([1]);
    expect(t.states.at(-1)).toBeNull();
    expect(t.loop.active).toBe(false);
  });

  it('cancel before the timer fires prevents the attempt', async () => {
    const t = setup(['ok']);
    t.loop.start();
    t.loop.cancel();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(t.calls).toEqual([]);
  });

  it('restart orphans the previous run', async () => {
    let release!: (o: AttemptOutcome) => void;
    let n = 0;
    const t = setup(() => {
      n += 1;
      return n === 1 ? new Promise<AttemptOutcome>((r) => { release = r; }) : Promise.resolve('ok');
    });
    t.loop.start();
    await vi.advanceTimersByTimeAsync(1000); // attempt 1 in flight
    t.loop.start();                          // link lost again → restart
    release('retryable');                    // stale result must not schedule #2
    await vi.advanceTimersByTimeAsync(1000); // fresh attempt 1
    expect(t.calls).toEqual([1, 1]);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(t.calls).toEqual([1, 1]);
  });

  it('start(n) continues the count so a flapping link still gives up', async () => {
    const t = setup([], 5);
    t.loop.start(4);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(t.calls).toEqual([4, 5]);
    expect(t.gaveUp()).toBe(1);
  });

  it('start(n) past the limit gives up straight away', () => {
    const t = setup([], 3);
    t.loop.start(4);
    expect(t.calls).toEqual([]);
    expect(t.gaveUp()).toBe(1);
  });

  it('a cancelled outcome leaves state alone', async () => {
    const t = setup(['cancelled']);
    t.loop.start();
    await vi.advanceTimersByTimeAsync(1000);
    // Last state is the "trying now" one; the canceller owns cleanup.
    expect(t.states.at(-1)).toEqual({ attempt: 1, at: expect.any(Number) });
  });
});
