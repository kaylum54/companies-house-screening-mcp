/**
 * Telling the operator when the deployment is in trouble.
 *
 * The obvious design is a cron job that queries the Analytics Engine SQL API
 * and alerts on what it finds. That was rejected: the SQL API needs an
 * account-scoped API token, and putting one inside an authless Worker that
 * anybody on the internet can reach adds a credential to the most exposed
 * component in the system in order to watch it. **This reads the Durable
 * Object instead** — the same authoritative counter every request already
 * consults — so there is no read token anywhere and nothing new to leak.
 *
 * The only secret involved is the delivery address, `CH_ALERT_WEBHOOK_URL`,
 * which is optional. Without it nothing is sent and the scheduled run still
 * records a heartbeat, so a deployment with no webhook is still measurable.
 *
 * Nothing here carries a caller identity or a company number; the payload is
 * two numbers and a state. See ADR 16.
 */

import type { BudgetOutcome } from '../http/budget.js';

/** How the deployment looked on the last scheduled check. Persisted in KV. */
export interface AlertState {
  /** True while an alert is outstanding, so recovery can be reported once. */
  firing: boolean;
  /** Consecutive bad readings. Alerting waits for this to clear the bound. */
  strikes: number;
  /**
   * When the trouble started — the first bad check, not the moment of firing.
   *
   * Recorded at onset rather than at the alert so it means what an operator
   * would assume; taking it at firing time understated every incident by a
   * full period.
   */
  since: number;
  /** Which condition fired, so a change of cause is reported rather than swallowed. */
  reason: AlertReason;
  /** When the last message went out, so a flapping deployment cannot spam. */
  alertedAt: number;
}

export type AlertReason =
  | 'budget_exhausted'
  | 'limiter_unavailable'
  | 'upstream_throttled'
  | 'none';

export const INITIAL_ALERT_STATE: AlertState = {
  firing: false,
  strikes: 0,
  since: 0,
  reason: 'none',
  alertedAt: 0
};

/**
 * Consecutive bad checks before anybody is woken.
 *
 * One is too eager: a busy five minutes legitimately drains the window, and
 * that is the design working rather than a fault. Two consecutive checks means
 * the window failed to recover across a full period, which is the point at
 * which it stops being normal traffic.
 */
const STRIKES_BEFORE_ALERTING = 2;

/**
 * Fraction of the window left that counts as exhausted.
 *
 * Not zero. By the time the pooled budget is at zero, callers have already
 * been refused for some time; the useful moment is while there is still a
 * little left and somebody could act.
 */
const EXHAUSTED_BELOW = 0.05;

/**
 * Floor on the gap between two firing alerts.
 *
 * The cause-change re-fire exists so a changed situation is not swallowed, but
 * without a bound it is a lever: a caller cycling the budget across the
 * threshold, or a coordinator flapping, produces a message on every check
 * forever. Thirty minutes keeps a genuine escalation prompt while making the
 * channel un-spammable. Recovery is never suppressed — the end of an incident
 * is the one message an operator is owed.
 */
const MIN_ALERT_GAP_MS = 30 * 60 * 1000;

export interface AlertPayload {
  /** `firing` when something is wrong, `resolved` when it has recovered. */
  state: 'firing' | 'resolved';
  reason: AlertReason;
  /** One line, suitable for a chat message. Carries no caller data. */
  text: string;
  budgetRemaining: number;
  budgetLimit: number;
  at: string;
}

export interface AlertDecision {
  /** The state to persist for the next run. */
  state: AlertState;
  /** Present only when something should actually be sent. */
  payload?: AlertPayload;
}

/**
 * Decides whether this reading is worth telling anybody about.
 *
 * Pure, and separate from both the reading and the sending, because the rules
 * here are the part worth testing exhaustively: alerting that cries wolf gets
 * muted, and muted alerting is worse than none because it is believed to work.
 */
export function decideAlert(
  previous: AlertState,
  reading: BudgetOutcome,
  now: number
): AlertDecision {
  const reason = classify(reading);
  const healthy = reason === 'none';

  if (healthy) {
    if (!previous.firing) {
      return { state: { ...INITIAL_ALERT_STATE } };
    }
    // Recovery is reported exactly once, then the state resets. An operator
    // who was told about a problem is owed the end of it.
    return {
      state: { ...INITIAL_ALERT_STATE },
      payload: {
        state: 'resolved',
        reason: previous.reason,
        text: `Recovered: ${describe(previous.reason)} has cleared. Budget ${sane(reading.globalRemaining)} of ${sane(reading.limit)}.`,
        budgetRemaining: sane(reading.globalRemaining),
        budgetLimit: sane(reading.limit),
        at: new Date(now).toISOString()
      }
    };
  }

  // Consecutive *bad* checks, whatever the cause. Counting per-cause meant a
  // deployment failing every single check — a flaky Durable Object alternating
  // between timing out and reporting a drained window — reset the count each
  // time and never alerted at all. Two bad checks is two bad checks.
  const bad = previous.reason !== 'none' || previous.strikes > 0;
  const strikes = bad ? previous.strikes + 1 : 1;
  const since = previous.strikes > 0 ? previous.since : now;

  // Already alerting on this same cause: stay quiet. Repeating every five
  // minutes is how a channel gets muted, and a muted channel is worse than no
  // channel because everyone believes it is working.
  if (previous.firing && previous.reason === reason) {
    return { state: { ...previous, strikes, since, reason } };
  }

  // Firing already, but on something else. The situation has changed under
  // the operator and they are still owed the end of the first incident, so
  // this re-fires immediately under the new cause rather than waiting out the
  // strike count again — which previously cleared `firing` silently and left
  // the original alert open forever.
  if (previous.firing) {
    // Bounded: a deployment flapping between two causes would otherwise send
    // on every check. Still firing, still the new cause — just quiet about it
    // until the gap has passed.
    if (now - previous.alertedAt < MIN_ALERT_GAP_MS) {
      return { state: { ...previous, strikes, since, reason } };
    }
    return {
      state: { firing: true, strikes, since, reason, alertedAt: now },
      payload: fire(reason, reading, now, previous.reason)
    };
  }

  if (strikes < STRIKES_BEFORE_ALERTING) {
    return { state: { ...previous, firing: false, strikes, since, reason } };
  }

  return {
    state: { firing: true, strikes, since, reason, alertedAt: now },
    payload: fire(reason, reading, now)
  };
}

/** The DO response is cast without validation upstream; this is the last guard. */
const sane = (value: number): number =>
  Number.isFinite(value) ? Math.max(0, Math.round(value)) : 0;

function fire(
  reason: AlertReason,
  reading: BudgetOutcome,
  now: number,
  replacing?: AlertReason
): AlertPayload {
  const changed =
    replacing === undefined || replacing === reason
      ? ''
      : `(replacing: ${describe(replacing)}) `;
  return {
    state: 'firing',
    reason,
    text: `${changed}${describe(reason)} Budget ${sane(reading.globalRemaining)} of ${sane(reading.limit)}.`,
    budgetRemaining: sane(reading.globalRemaining),
    budgetLimit: sane(reading.limit),
    at: new Date(now).toISOString()
  };
}

function classify(reading: BudgetOutcome): AlertReason {
  // Checked first: a window that cannot be consulted reports zero everywhere,
  // which would otherwise be read as an exhausted budget and send the
  // operator looking at traffic when the coordinator is down.
  if (reading.boundBy === 'unavailable') return 'limiter_unavailable';

  // A 429 hold, checked before the window is looked at. Companies House has
  // throttled the key, so every caller is being refused — and the window is
  // deliberately reported *full* during a hold, because a hold is not a
  // spending problem. Judging this on `globalRemaining` alone reported perfect
  // health while the deployment was completely down for everybody, which is
  // the worst reading this check can produce.
  if (reading.boundBy === 'penalty') return 'upstream_throttled';

  // `globalRemaining`, not `remaining`. The check peeks as an unseen client,
  // and an unseen client is guaranteed a reservation — 71 of 570 at the
  // defaults — so its share cannot fall below that until the window is
  // almost gone. Comparing it against 5% of the same 570 put the threshold
  // 2.5x underneath a floor the reading could not cross, which made this
  // silent through exactly the case it was written for: one caller draining
  // the window while every other caller is refused.
  if (reading.limit > 0 && reading.globalRemaining <= reading.limit * EXHAUSTED_BELOW) {
    return 'budget_exhausted';
  }
  return 'none';
}

function describe(reason: AlertReason): string {
  switch (reason) {
    case 'limiter_unavailable':
      return 'The rate-limit Durable Object could not be reached, so requests are failing closed.';
    case 'budget_exhausted':
      return 'The shared Companies House budget is nearly spent and callers are being refused.';
    case 'upstream_throttled':
      return 'Companies House has rate-limited the key, so every caller is being refused until the hold expires.';
    case 'none':
      return 'Nothing is wrong.';
  }
}

/** Rejects anything that is not an `AlertState`, so bad storage cannot latch. */
export function isAlertState(value: unknown): value is AlertState {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as Record<string, unknown>;
  if (typeof candidate['firing'] !== 'boolean') return false;
  if (typeof candidate['strikes'] !== 'number' || !Number.isFinite(candidate['strikes'])) {
    return false;
  }
  if (typeof candidate['since'] !== 'number' || !Number.isFinite(candidate['since'])) return false;
  if (
    typeof candidate['alertedAt'] !== 'number' ||
    !Number.isFinite(candidate['alertedAt'])
  ) {
    return false;
  }
  // A corrupted count now delays the first alert by that many checks rather
  // than by one, since strikes no longer reset on a change of cause.
  if (!Number.isInteger(candidate['strikes']) || (candidate['strikes'] as number) < 0) return false;
  return (
    candidate['reason'] === 'budget_exhausted' ||
    candidate['reason'] === 'limiter_unavailable' ||
    candidate['reason'] === 'upstream_throttled' ||
    candidate['reason'] === 'none'
  );
}

/**
 * Where an alert may be sent.
 *
 * `https` only, and parsed rather than pattern-matched. The address comes from
 * the operator rather than from a caller, so this is not defending against an
 * attacker — it is defending against a typo that would post an alert in clear
 * text, or a value that is not a URL at all and would throw inside a
 * scheduled run nobody is watching.
 */
export function alertEndpoint(raw: string | undefined): URL | undefined {
  if (raw === undefined || raw.trim() === '') return undefined;
  try {
    const url = new URL(raw.trim());
    return url.protocol === 'https:' ? url : undefined;
  } catch {
    return undefined;
  }
}

export interface SendAlertOptions {
  url: URL;
  payload: AlertPayload;
  fetchImpl: typeof fetch;
  /** Bounded so a hanging endpoint cannot hold the scheduled run open. */
  timeoutMs?: number;
}

/**
 * Posts one alert, and never throws.
 *
 * A scheduled run that dies on a bad webhook stops persisting state, which
 * means the next run starts from scratch and the strike counter never
 * reaches the bound — the alerting quietly stops working, in a code path
 * nobody looks at. Returning false instead keeps the run intact.
 */
export async function sendAlert(options: SendAlertOptions): Promise<boolean> {
  try {
    const response = await options.fetchImpl(options.url.toString(), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(options.payload),
      // Not followed. `fetch` follows redirects by default, so an endpoint
      // answering `302 -> http://...` would replay the POST in clear text to
      // an arbitrary host and quietly defeat the https-only check above.
      redirect: 'manual',
      signal: AbortSignal.timeout(options.timeoutMs ?? 5_000)
    });
    return response.ok;
  } catch {
    return false;
  }
}
