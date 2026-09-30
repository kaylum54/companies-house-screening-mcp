# Health check — 30 September 2026

The published MCP is working. Local regression and stress checks pass, but dependency advisories, ineffective scheduled live testing, and unreleased local changes need attention. This review did not modify product source, publish, or deploy anything.

## Downloads

Source: npm downloads API, through 29 September; today's incomplete reporting is excluded.

| Period | Downloads |
|---|---:|
| Lifetime, 20 August–29 September | 903 |
| Last 30 days, 31 August–29 September | 437 |
| Since previous review, 16–29 September | 58 |
| Last 7 days, 23–29 September | 21 |

Daily totals for 16–29 September: 1, 10, 1, 9, 6, 8, 2, 0, 2, 0, 5, 5, 9, 0.

The earlier period now totals 845, versus the previous report's 832: npm revised historical data by 13. Therefore the increase from the previous reported lifetime total is 71, but 58 downloads occurred in the new period. Downloads include repeats, automation, and testing; they are not unique users or successful installations. npx can reuse cached packages without a new download.

Evidence: `.cache/downloads-health-2026-09-30.json`. Public endpoint: https://api.npmjs.org/downloads/range/2026-08-20:2026-09-29/companies-house-screening-mcp

## Published and local versions

- npm and hosted Worker both report 0.4.0 and expose 11 tools. Fresh npx installation in a temporary directory with a fresh npm cache, MCP initialization, tool discovery, and a real `get_company` lookup passed. Hosted MCP initialization, tool discovery, and the same lookup passed; `/health` is healthy.
- Local source exposes 12 tools. Its real company lookup and `review_filing_deadlines` lookup passed with comparison date 2026-09-30.
- HEAD remains release commit `444742d9769a32cc35a74117f0790817ca8ec126`. Cancellation/reconciliation changes and the accountant tool remain uncommitted and unpublished. Local package version still says 0.4.0. README correctly labels the accountant feature unreleased.
- GitHub currently shows no open issues or PRs, zero stars and forks. This is not evidence that users have encountered no problems.

Evidence: `.cache/health-runtime-2026-09-30.json` and its reproducible `.mjs` script.

## Verification

| Check | Result |
|---|---|
| TypeScript typecheck and build | Passed |
| Generated tool and recipe documentation checks | Passed |
| Node regression suite | 607 tests, 23 files passed |
| Coverage | Lines 91.15%; statements 89.24%; branches 84.36%; functions 89.55% |
| Worker suite | 16 tests passed; dependency sourcemap warnings |
| Live Companies House smoke suite | 5 tests passed |
| Offline MCP stress suite | 16 scenarios passed |
| Published npx and hosted real lookup | Passed |
| Local accountant real lookup | Passed |
| Dependency security audit | Advisories found; not a clean result |

Stress checks covered concurrent batches, shared-request deduplication, budget contention, section failures, malformed responses, timeouts, invalid input, reconciliation and cancellation. Cancellation stopped at 16 upstream requests, with zero additional requests afterward. Ten competing batches respected a 57-request budget. These are synthetic upstream tests, not a production capacity benchmark. No destructive or high-volume production load test was run. Paid model evaluations were not rerun.

## Findings and recommended order

1. **Triage dependency security advisories.** The installed lockfile's full dependency graph reports 9 affected package entries: 6 high and 3 moderate. Production-only audit reports 4 entries: `fast-uri` high; `hono`, `ip-address`, and `qs` moderate. The remaining entries concern development tooling, including the Cloudflare test stack. These counts are affected packages, not distinct proven exploits. Audit does not establish that vulnerable functions are reachable in this application. Apply targeted compatible updates and rerun Node, Worker, transport, and live checks. Do not blindly apply npm's suggested major rollback of the Cloudflare test adapter.
2. **Restore scheduled live verification.** Latest scheduled GitHub run `36571660933` is marked successful but its log says `COMPANIES_HOUSE_API_KEY is not set; skipping the live smoke test.` The workflow explicitly exits successfully in this case (`.github/workflows/ci.yml:98–104`). Configure the repository secret and make a missing prerequisite visibly distinguishable from passing live verification. Local live tests passed using the local environment; that does not repair CI monitoring.
3. **Finish reconciliation before releasing existing work.** `src/tools/composite.ts:349` still requires each input string to contain at least one character. A real MCP call with `['00000006', '']` rejects the entire call before reconciliation. Whitespace-only strings are preserved, explaining why the existing reconciliation stress case passes. Permit an empty string to reach row-level validation and add the exact regression case.
4. **Review cached deadline behavior under exhausted budget.** `src/tools/deadlines.ts:70–82` selects affordable company numbers before consulting the HTTP cache. A zero remaining budget marks every valid company `not_screened`, even when a fresh cached profile could satisfy the request without spending budget. This is a code-path finding, not a separately executed reproduction. Decide whether to serve available cache entries before budgeting misses, or document the conservative behavior.
5. **Release the verified local work.** Current cancellation fixes and accountant functionality are unavailable to users on npm/hosted 0.4.0. After the above fixes, commit, version, publish, deploy, and repeat the actual installed-package and hosted checks. Do not advertise the accountant tool as live yet.
6. **Consider an aggregate concurrency limit as usage grows.** Twenty distinct simultaneous batches reached 240 concurrent synthetic upstream requests. The rate budget remained enforced, but per-batch concurrency multiplies across callers. A shared cap would reduce bursts and resource pressure. No production outage was demonstrated.

Audit evidence: `.cache/health-audit-2026-09-30.json`, `.cache/health-production-audit-2026-09-30.json`. Stress evidence: `.cache/health-stress-2026-09-30.json`.

## Hosted usage and failures

Cloudflare Analytics Engine query window: 16 September 00:00 UTC through 30 September 00:00 UTC, excluding today's review activity. Existing OAuth credentials were refreshed through Wrangler; analytics then became accessible.

| Tool | Successful calls | Failed calls |
|---|---:|---:|
| find_company | 12 | 1 |
| get_officers | 8 | 0 |
| screen_companies | 4 | 0 |
| get_company | 3 | 0 |
| company_snapshot | 3 | 0 |
| Total named tools | 30 | 1 |

The failed search was labelled `upstream_bad_request`. There were also 182 successful non-handler requests and 82 `protocol_error` requests labelled `unknown`. This bucket includes handshakes, discovery, and calls rejected before reaching a handler; it cannot be interpreted as 82 failed company lookups or attributed to individual users from these aggregates.

Heartbeat records: 4,057 successes and one `upstream_unavailable` error. This is separate from the GitHub live-test gap and does not establish continuous availability. No unique-user attribution exists, and owner testing may contribute to activity. Local npx tool calls are not covered by hosted analytics.

Evidence: `.cache/health-analytics-2026-09-30.json`. Counts use sampling weights (`SUM(_sample_interval)`).

## Business demo readiness

The accountant monthly-review use case remains useful: input confirmed company numbers and client references; retrieve current profiles; classify accounts and confirmation-statement deadlines; return a dated worksheet with uncheckable rows retained. The live local lookup works, but release it before filming public setup instructions. Monthly automatic execution requires a scheduler; the tool itself creates neither reminders nor filings. The September 16 demonstration worksheet is historical evidence, not a current client review.
