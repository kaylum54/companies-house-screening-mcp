/**
 * Time as an injected dependency.
 *
 * The rate limiter and the cache both make decisions about elapsed time. If
 * they read `Date.now()` directly, testing them means either sleeping in the
 * test suite or accepting that the timing paths go untested. Both are bad
 * trades, so time comes in through this interface and tests pass a fake.
 */
export interface Clock {
  now(): number;
  sleep(ms: number): Promise<void>;
}

export const systemClock: Clock = {
  now: () => Date.now(),
  sleep: (ms: number) =>
    new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, ms);
      // Do not hold the event loop open purely to finish a backoff sleep.
      timer.unref?.();
    })
};

/**
 * A clock that only moves when something waits on it.
 *
 * `sleep` resolves immediately but advances the reported time, so a test can
 * exercise a five-minute rate-limit window in under a millisecond.
 */
export class FakeClock implements Clock {
  #now: number;
  readonly sleeps: number[] = [];

  constructor(startMs = 0) {
    this.#now = startMs;
  }

  now(): number {
    return this.#now;
  }

  async sleep(ms: number): Promise<void> {
    this.sleeps.push(ms);
    this.#now += ms;
    // Yield to the microtask queue so that awaiting callers interleave the way
    // they would with a real timer.
    await Promise.resolve();
  }

  advance(ms: number): void {
    this.#now += ms;
  }
}
