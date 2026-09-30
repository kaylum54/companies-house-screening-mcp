/** A cancellation-safe FIFO semaphore for limiting active upstream work. */
interface Waiter {
  resolve: (release: () => void) => void;
  reject: (reason: unknown) => void;
  signal?: AbortSignal;
  onAbort?: () => void;
}

export class Semaphore {
  readonly #capacity: number;
  #active = 0;
  readonly #queue: Waiter[] = [];

  constructor(capacity: number) {
    if (!Number.isInteger(capacity) || capacity < 1) throw new RangeError('capacity must be a positive integer');
    this.#capacity = capacity;
  }

  async acquire(signal?: AbortSignal): Promise<() => void> {
    if (signal?.aborted) throw signal.reason ?? new DOMException('The operation was aborted.', 'AbortError');
    if (this.#active < this.#capacity && this.#queue.length === 0) {
      this.#active += 1;
      return this.#releaseOnce();
    }
    return new Promise((resolve, reject) => {
      const waiter: Waiter = { resolve, reject, ...(signal === undefined ? {} : { signal }) };
      if (signal !== undefined) {
        waiter.onAbort = () => {
          const index = this.#queue.indexOf(waiter);
          if (index !== -1) this.#queue.splice(index, 1);
          reject(signal.reason ?? new DOMException('The operation was aborted.', 'AbortError'));
        };
        signal.addEventListener('abort', waiter.onAbort, { once: true });
      }
      this.#queue.push(waiter);
    });
  }

  #releaseOnce(): () => void {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.#active -= 1;
      while (this.#queue.length > 0) {
        const next = this.#queue.shift()!;
        if (next.signal?.aborted) continue;
        if (next.signal !== undefined && next.onAbort !== undefined) next.signal.removeEventListener('abort', next.onAbort);
        this.#active += 1;
        next.resolve(this.#releaseOnce());
        break;
      }
    };
  }
}
