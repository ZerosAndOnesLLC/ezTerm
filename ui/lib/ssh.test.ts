import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Tauri's Channel registers a callback on window.__TAURI_INTERNALS__ in
// its constructor, which doesn't exist under vitest. A minimal stand-in
// with the same onmessage contract is all createOutputChannel needs.
vi.mock('@tauri-apps/api/core', () => ({
  Channel: class {
    onmessage: (b: ArrayBuffer) => void = () => {};
  },
}));
vi.mock('@tauri-apps/api/event', () => ({ listen: vi.fn() }));

import { createOutputChannel, startOutputWatchdog } from './ssh';

const chunk = (s: string) => new TextEncoder().encode(s).buffer as ArrayBuffer;

describe('createOutputChannel', () => {
  it('buffers until armed, then flushes in order and streams live', () => {
    const got: string[] = [];
    const out = createOutputChannel((b) => got.push(new TextDecoder().decode(b)));
    out.channel.onmessage(chunk('a'));
    out.channel.onmessage(chunk('b'));
    expect(got).toEqual([]);
    expect(out.received()).toBe(0);
    out.arm();
    expect(got).toEqual(['a', 'b']);
    out.channel.onmessage(chunk('c'));
    expect(got).toEqual(['a', 'b', 'c']);
    expect(out.received()).toBe(3);
  });

  it('drops everything after detach, including buffered chunks', () => {
    const got: string[] = [];
    const out = createOutputChannel((b) => got.push(new TextDecoder().decode(b)));
    out.channel.onmessage(chunk('a'));
    out.detach();
    out.channel.onmessage(chunk('b'));
    out.arm();
    expect(got).toEqual([]);
  });

  it('arm is idempotent', () => {
    const got: string[] = [];
    const out = createOutputChannel((b) => got.push(new TextDecoder().decode(b)));
    out.channel.onmessage(chunk('a'));
    out.arm();
    out.arm();
    expect(got).toEqual(['a']);
  });
});

describe('startOutputWatchdog', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  function harness(sentSeq: number[]) {
    const out = createOutputChannel(() => {});
    out.arm();
    let i = 0;
    const sent = vi.fn(async () => sentSeq[Math.min(i++, sentSeq.length - 1)]);
    const stall = vi.fn();
    const stop = startOutputWatchdog(out, sent, stall, 1000);
    return { out, sent, stall, stop };
  }

  it('fires after two consecutive polls with Rust ahead and no progress', async () => {
    const { stall } = harness([5, 5, 5]);
    await vi.advanceTimersByTimeAsync(1000);
    expect(stall).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1000);
    expect(stall).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(5000);
    expect(stall).toHaveBeenCalledTimes(1); // stopped itself
  });

  it('does not fire while chunks keep arriving', async () => {
    const { out, stall } = harness([2, 4, 6, 8]);
    for (let n = 0; n < 4; n++) {
      out.channel.onmessage(chunk('x'));
      await vi.advanceTimersByTimeAsync(1000);
    }
    expect(stall).not.toHaveBeenCalled();
  });

  it('does not fire when counts match', async () => {
    const { out, stall } = harness([1, 1, 1]);
    out.channel.onmessage(chunk('x'));
    await vi.advanceTimersByTimeAsync(3000);
    expect(stall).not.toHaveBeenCalled();
  });

  it('stops polling when the connection is reported gone', async () => {
    const out = createOutputChannel(() => {});
    const sent = vi.fn(async () => { throw { code: 'not_found', message: 'gone' }; });
    const stall = vi.fn();
    startOutputWatchdog(out, sent, stall, 1000);
    await vi.advanceTimersByTimeAsync(3000);
    expect(sent).toHaveBeenCalledTimes(1);
    expect(stall).not.toHaveBeenCalled();
  });

  it('keeps polling through a transient query failure', async () => {
    const out = createOutputChannel(() => {});
    let n = 0;
    const sent = vi.fn(async () => { if (n++ === 0) throw new Error('ipc hiccup'); return 3; });
    const stall = vi.fn();
    startOutputWatchdog(out, sent, stall, 1000);
    await vi.advanceTimersByTimeAsync(3000);
    expect(sent).toHaveBeenCalledTimes(3);
    expect(stall).toHaveBeenCalledTimes(1); // two clean behind polls after the hiccup
  });

  it('does not query Rust while local progress is observed', async () => {
    const { out, sent } = harness([9, 9, 9]);
    for (let n = 0; n < 3; n++) {
      out.channel.onmessage(chunk('x'));
      await vi.advanceTimersByTimeAsync(1000);
    }
    expect(sent).not.toHaveBeenCalled();
  });

  it('never overlaps ticks: a slow query is not double-counted', async () => {
    const out = createOutputChannel(() => {});
    out.arm();
    let resolve: ((n: number) => void) | null = null;
    const sent = vi.fn(() => new Promise<number>((r) => { resolve = r; }));
    const stall = vi.fn();
    startOutputWatchdog(out, sent, stall, 1000);
    await vi.advanceTimersByTimeAsync(3500); // three intervals elapse during one slow query
    expect(sent).toHaveBeenCalledTimes(1);
    resolve!(5);
    await vi.advanceTimersByTimeAsync(0);
    expect(stall).not.toHaveBeenCalled(); // only one behind poll so far
  });
});
