/**
 * A scripted stand-in for `fetch`.
 *
 * The client takes its fetch implementation by injection precisely so that
 * retry, backoff, revalidation and rate-limit behaviour can be tested without
 * a network, a key, or a sleeping test suite.
 */

export interface FakeResponseSpec {
  status?: number;
  /** Serialised as JSON. Ignored when `text` is present. */
  body?: unknown;
  /** Raw body, for testing malformed responses. */
  text?: string;
  headers?: Record<string, string>;
  /** Thrown instead of returning, for testing network failures. */
  throws?: unknown;
}

export interface FakeCall {
  url: string;
  method: string;
  headers: Record<string, string>;
}

export interface FakeFetch {
  fetch: typeof fetch;
  calls: FakeCall[];
}

function toResponse(spec: FakeResponseSpec): Response {
  const status = spec.status ?? 200;
  const headers = new Headers(spec.headers ?? {});
  if (!headers.has('content-type')) headers.set('content-type', 'application/json');

  // 204 and 304 must not carry a body, or the Response constructor throws.
  if (status === 204 || status === 304) {
    return new Response(null, { status, headers });
  }

  const body = spec.text ?? JSON.stringify(spec.body ?? {});
  return new Response(body, { status, headers });
}

function normaliseHeaders(init: RequestInit | undefined): Record<string, string> {
  const raw = init?.headers;
  if (raw === undefined) return {};
  const headers = new Headers(raw as ConstructorParameters<typeof Headers>[0]);
  const out: Record<string, string> = {};
  headers.forEach((value, key) => {
    out[key.toLowerCase()] = value;
  });
  return out;
}

/**
 * Returns responses in order. Running past the end is a test authoring
 * mistake rather than a scenario, so it throws loudly instead of repeating
 * the last response.
 */
export function fakeFetchSequence(specs: FakeResponseSpec[]): FakeFetch {
  const calls: FakeCall[] = [];
  let index = 0;

  const impl: typeof fetch = async (input, init) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    calls.push({ url, method: init?.method ?? 'GET', headers: normaliseHeaders(init ?? undefined) });

    const spec = specs[index];
    index += 1;
    if (spec === undefined) {
      throw new Error(
        `fakeFetchSequence ran out of responses on call ${index} (${url}). Script ${specs.length}, got ${index}.`
      );
    }
    if (spec.throws !== undefined) throw spec.throws;
    return toResponse(spec);
  };

  return { fetch: impl, calls };
}

/** Returns the same response for every call. */
export function fakeFetchAlways(spec: FakeResponseSpec): FakeFetch {
  const calls: FakeCall[] = [];

  const impl: typeof fetch = async (input, init) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    calls.push({ url, method: init?.method ?? 'GET', headers: normaliseHeaders(init ?? undefined) });
    if (spec.throws !== undefined) throw spec.throws;
    return toResponse(spec);
  };

  return { fetch: impl, calls };
}

/** An error shaped like the one `AbortSignal.timeout` produces. */
export function timeoutError(): Error {
  const error = new Error('The operation was aborted due to timeout');
  error.name = 'TimeoutError';
  return error;
}

/**
 * Routes by URL rather than by call order.
 *
 * The composite tools fetch several sections concurrently. Asserting on a
 * fixed sequence there would be testing the scheduler rather than the tool,
 * and it would break the first time the concurrency width changed. Routing on
 * the path says what the test actually means.
 *
 * The first matching pattern wins. An unmatched URL throws, because in these
 * tests an unexpected request is a defect rather than a scenario.
 */
export function fakeFetchRouter(routes: [RegExp, FakeResponseSpec][]): FakeFetch {
  const calls: FakeCall[] = [];

  const impl: typeof fetch = async (input, init) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    calls.push({ url, method: init?.method ?? 'GET', headers: normaliseHeaders(init ?? undefined) });

    const match = routes.find(([pattern]) => pattern.test(url));
    if (match === undefined) throw new Error(`fakeFetchRouter has no route for ${url}`);
    const [, spec] = match;
    if (spec.throws !== undefined) throw spec.throws;
    return toResponse(spec);
  };

  return { fetch: impl, calls };
}
