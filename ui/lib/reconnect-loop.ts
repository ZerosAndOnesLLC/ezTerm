import { MAX_RECONNECT_ATTEMPTS, reconnectDelayMs } from './reconnect';

/** Result of one reconnect attempt, as reported by the caller. `cancelled`
 *  means the attempt was superseded elsewhere and the loop should stop
 *  without touching state. */
export type AttemptOutcome = 'ok' | 'fatal' | 'retryable' | 'cancelled';

export interface ReconnectLoopHooks {
  /** Run attempt `n` (1-based). */
  attempt: (n: number) => Promise<AttemptOutcome>;
  /** Attempt `n` is armed to fire at epoch-ms `at` (`at <= now`: firing now). */
  onState: (state: { attempt: number; at: number } | null) => void;
  /** Every attempt failed transiently. */
  onGiveUp: () => void;
  delayMs?: (n: number) => number;
  maxAttempts?: number;
  now?: () => number;
}

/** Auto-reconnect state machine: backoff timer, "retry now", cancel, and
 *  give-up — with a generation counter so an attempt still in flight
 *  when the loop is cancelled or restarted can never re-arm it. Kept free
 *  of React so it can be unit-tested with fake timers. */
export class ReconnectLoop {
  private timer: ReturnType<typeof setTimeout> | null = null;
  private gen = 0;
  private current = 0;
  private readonly h: Required<ReconnectLoopHooks>;

  constructor(hooks: ReconnectLoopHooks) {
    this.h = {
      delayMs: reconnectDelayMs,
      maxAttempts: MAX_RECONNECT_ATTEMPTS,
      now: Date.now,
      ...hooks,
    };
  }

  /** Begin (or restart) the loop. `fromAttempt` > 1 continues a count
   *  instead of starting over — used when the link drops again right after
   *  a reconnect, so a flapping link still runs out of attempts. */
  start(fromAttempt = 1): void {
    this.cancel();
    this.schedule(Math.max(1, Math.floor(fromAttempt)), this.gen);
  }

  /** Fire the pending attempt immediately. No-op if none is waiting. */
  retryNow(): void {
    if (this.timer === null) return;
    clearTimeout(this.timer);
    this.timer = null;
    void this.run(this.current, this.gen);
  }

  /** Stop: clears the timer and orphans any attempt in flight. */
  cancel(): void {
    this.gen += 1;
    this.current = 0;
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
    this.h.onState(null);
  }

  /** True while an attempt is waiting or in flight. */
  get active(): boolean {
    return this.current > 0;
  }

  private schedule(n: number, gen: number): void {
    if (n > this.h.maxAttempts) {
      this.current = 0;
      this.h.onState(null);
      this.h.onGiveUp();
      return;
    }
    this.current = n;
    const delay = this.h.delayMs(n);
    this.h.onState({ attempt: n, at: this.h.now() + delay });
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.run(n, gen);
    }, delay);
  }

  private async run(n: number, gen: number): Promise<void> {
    if (gen !== this.gen) return;
    this.h.onState({ attempt: n, at: this.h.now() });
    const outcome = await this.h.attempt(n);
    if (gen !== this.gen || outcome === 'cancelled') return;
    if (outcome === 'retryable') {
      this.schedule(n + 1, gen);
      return;
    }
    this.current = 0;
    this.h.onState(null);
  }
}
