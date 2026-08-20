/**
 * Bounded parallelism.
 *
 * The composite tools fan out across several companies at once. Firing every
 * request simultaneously would not go faster — the rate limiter serialises
 * acquisition anyway — but it would queue two hundred sockets against one
 * host and make the failure mode on a bad day much worse than it needs to be.
 *
 * Four in flight is enough to hide latency behind the rate limiter without
 * looking like a scraper.
 */
export const DEFAULT_CONCURRENCY = 4;

export async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  run: (item: T, index: number) => Promise<R>
): Promise<R[]> {
  if (items.length === 0) return [];
  const width = Math.max(1, Math.min(limit, items.length));
  const results = new Array<R>(items.length);
  let cursor = 0;

  const worker = async (): Promise<void> => {
    for (;;) {
      const index = cursor;
      cursor += 1;
      if (index >= items.length) return;
      results[index] = await run(items[index]!, index);
    }
  };

  await Promise.all(Array.from({ length: width }, () => worker()));
  return results;
}

export type Attempt<T> =
  | { ok: true; value: T }
  | { ok: false; error: unknown };

/**
 * Runs something and reports the outcome instead of throwing.
 *
 * A snapshot that fails entirely because the charges endpoint was briefly
 * unavailable is worse than one that returns the profile, the officers and a
 * note saying charges could not be read. `Promise.allSettled` gets most of
 * the way there; this keeps the call sites readable.
 */
export async function attempt<T>(run: () => Promise<T>): Promise<Attempt<T>> {
  try {
    return { ok: true, value: await run() };
  } catch (error) {
    return { ok: false, error };
  }
}
