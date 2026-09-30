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
  sleep(ms: number, signal?: AbortSignal): Promise<void>;
}

/** Throw the caller's abort reason in a consistent shape before doing I/O. */
export function throwIfAborted(signal: AbortSignal | undefined): void {
  if (!signal?.aborted) return;
  throw signal.reason ?? new DOMException('The operation was aborted.', 'AbortError');
}

/** Wait on an injected clock, but let cancellation release the caller promptly. */
export async function sleepWithAbort(
  clock: Clock,
  ms: number,
  signal: AbortSignal | undefined
): Promise<void> {
  throwIfAborted(signal);
  if (signal === undefined) {
    await clock.sleep(ms);
    return;
  }

  if (clock === systemClock) {
    await clock.sleep(ms, signal);
    return;
  }

  await new Promise<void>((resolve, reject) => {
    let settled = false;
    const cleanup = () => signal.removeEventListener('abort', onAbort);
    const onAbort = () => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(signal.reason ?? new DOMException('The operation was aborted.', 'AbortError'));
    };
    signal.addEventListener('abort', onAbort, { once: true });
    clock.sleep(ms).then(
      () => {
        if (settled) return;
        settled = true;
        cleanup();
        resolve();
      },
      (error: unknown) => {
        if (settled) return;
        settled = true;
        cleanup();
        reject(error);
      }
    );
    if (signal.aborted) onAbort();
  });
}

export const systemClock: Clock = {
  now: () => Date.now(),
  sleep: (ms: number, signal?: AbortSignal) =>
    new Promise<void>((resolve, reject) => {
      if (signal?.aborted) {
        reject(signal.reason ?? new DOMException('The operation was aborted.', 'AbortError'));
        return;
      }
      let timer: ReturnType<typeof setTimeout>;
      const cleanup = () => signal?.removeEventListener('abort', onAbort);
      const onTimer = () => {
        cleanup();
        resolve();
      };
      const onAbort = () => {
        clearTimeout(timer);
        cleanup();
        reject(signal?.reason ?? new DOMException('The operation was aborted.', 'AbortError'));
      };
      timer = setTimeout(onTimer, ms);
      signal?.addEventListener('abort', onAbort, { once: true });
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
