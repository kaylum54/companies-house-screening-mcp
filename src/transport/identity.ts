import { createHash } from 'node:crypto';

/**
 * Who is calling, and out of whose budget.
 *
 * The server is authless today: paste the URL, it works, which is the whole
 * point of hosting it. But "no authentication" must not mean "no identity".
 * The fair-share limiter needs something to be fair *between*, and an
 * authless server that treats every caller as the same principal has a
 * fair-share limiter that cannot do its job.
 *
 * So identity and authentication are separated here. `AuthProvider` decides
 * whether a request may proceed and what to call it; everything downstream
 * consumes the resulting `ClientIdentity` and never asks how it was
 * established. Adding OAuth later means writing one provider, not rewriting
 * the limiter, the session registry and the entry points. See ADR 15.
 */

/** Header a caller uses to bring their own Companies House key. */
export const API_KEY_HEADER = 'x-companies-house-api-key';

export interface ClientIdentity {
  /**
   * Stable id used for fair-share accounting.
   *
   * Prefixed by how it was derived (`ip:`, `key:`, later `sub:`) so that two
   * schemes can never collide, and so a log line says what kind of principal
   * it is without revealing which one.
   */
  clientId: string;
  /**
   * The caller's own Companies House key, when they supplied one.
   *
   * Present here and nowhere else: it must not reach a log, a tool result, a
   * cache key or the model. See `describe`, which exists so that logging an
   * identity cannot accidentally log this.
   */
  apiKey?: string | undefined;
  /** True when this caller is spending their own budget rather than the pool. */
  ownsBudget: boolean;
}

/** Minimal view of request headers, so this works on Node and on Workers alike. */
export type HeaderLookup = (name: string) => string | null | undefined;

export interface IdentityRequest {
  header: HeaderLookup;
  /** Peer address, where the runtime exposes one. */
  remoteAddress?: string | undefined;
}

export type AuthResult =
  | { ok: true; identity: ClientIdentity }
  | { ok: false; status: number; message: string; wwwAuthenticate?: string | undefined };

export interface AuthProvider {
  authenticate(request: IdentityRequest): Promise<AuthResult>;
}

/**
 * Safe rendering of an identity for logs.
 *
 * Takes the whole identity rather than its parts so there is no version of
 * "log the caller" that reaches for `apiKey` by accident.
 */
export function describe(identity: ClientIdentity): Record<string, unknown> {
  return { clientId: identity.clientId, ownsBudget: identity.ownsBudget };
}

/**
 * Short, stable, non-reversible id for a value we must not store.
 *
 * Used for both IP addresses and API keys. An IP address is personal data and
 * has no business sitting in a log line for the life of a process; an API key
 * obviously cannot. Sixteen hex characters is far more than enough to keep
 * distinct callers distinct, and reveals nothing about the input.
 */
export function fingerprint(value: string): string {
  return createHash('sha256').update(value).digest('hex').slice(0, 16);
}

export interface NoAuthProviderOptions {
  /**
   * Whether a caller may bring their own Companies House key.
   *
   * On by default: it is the pressure valve for anyone who finds the shared
   * budget too tight, and it costs the operator nothing.
   */
  allowClientKeys?: boolean;
  /** Identity used when the runtime exposes no peer address at all. */
  anonymousId?: string;
}

/**
 * The default provider: admits everybody, but tells them apart.
 *
 * Identity is derived, in order of preference, from the caller's own API key
 * (they have their own budget, so the key *is* the principal) or from the peer
 * address. Neither is stored in the clear.
 *
 * The peer address is a weak principal — a NAT groups strangers together, and
 * anyone determined can move between addresses. It is not being used as a
 * security control, and nothing here should be mistaken for one. It is used
 * because fair sharing needs *some* partition of callers, and an address is
 * the best available one before a caller has proved anything about itself.
 * The consequence of getting it wrong is a caller sharing a reservation it
 * should have had to itself, never a caller reading data it should not see —
 * there is no per-caller data here to read, only the public register.
 */
export class NoAuthProvider implements AuthProvider {
  readonly #allowClientKeys: boolean;
  readonly #anonymousId: string;

  constructor(options: NoAuthProviderOptions = {}) {
    this.#allowClientKeys = options.allowClientKeys ?? true;
    this.#anonymousId = options.anonymousId ?? 'anonymous';
  }

  async authenticate(request: IdentityRequest): Promise<AuthResult> {
    const supplied = this.#allowClientKeys ? readApiKey(request.header) : undefined;

    if (supplied !== undefined) {
      return {
        ok: true,
        identity: {
          clientId: `key:${fingerprint(supplied)}`,
          apiKey: supplied,
          ownsBudget: true
        }
      };
    }

    const address = request.remoteAddress?.trim();
    const clientId =
      address === undefined || address === ''
        ? `ip:${this.#anonymousId}`
        : `ip:${fingerprint(address)}`;

    return { ok: true, identity: { clientId, ownsBudget: false } };
  }
}

/**
 * Reads and sanity-checks a caller-supplied key.
 *
 * Rejects anything with whitespace or control characters rather than passing
 * it on: the value ends up in an `Authorization` header, and a header value
 * carrying a newline is how header injection starts. A malformed key is
 * treated as absent, which drops the caller into the shared pool — a worse
 * budget, but a working server, and a clearer signal than a 400 they cannot
 * act on.
 */
function readApiKey(header: HeaderLookup): string | undefined {
  const raw = header(API_KEY_HEADER);
  if (raw === null || raw === undefined) return undefined;

  const trimmed = raw.trim();
  if (trimmed === '') return undefined;
  // Printable ASCII only, and no spaces. Companies House keys are alphanumeric.
  if (!/^[\x21-\x7e]+$/.test(trimmed)) return undefined;
  if (trimmed.length > 256) return undefined;

  return trimmed;
}
