# Stress review — 16 September 2026

Reviewed release 0.4.0, source commit 444742d9769a32cc35a74117f0790817ca8ec126. Product source was not changed. This review adds a repeatable offline probe and evidence. Nothing was published or deployed.

## Result

Two reproducible defects and one concurrency hardening opportunity. The existing suite passes but does not catch these cases. Fix input reconciliation and cancellation before demonstrating large invoice or supplier worksheets.

## Verification

- 589 Node tests passed; coverage: lines 91.14%, branches 85.15%.
- 16 Worker tests passed. The restricted environment emitted Wrangler log/export-analysis warnings; these did not fail the Worker tests.
- Five real Companies House API smoke checks passed.
- Typecheck, build and generated-document checks passed.
- The initial restricted Node run had one five-second stdio subprocess timeout. The unrestricted full rerun passed; this does not establish a product startup defect.
- New offline probe: 16 scenarios, repeated three times. Each repeat had 12 passing checks and four failed invariants representing two defects (three input-reconciliation variants and cancellation).
- 20 concurrent distinct 50-company batches returned all 1,000 companies in input order, using 4,000 synthetic upstream requests. Peak in-flight requests: 240.
- 20 concurrent identical batches shared 200 synthetic upstream requests; peak 12. Request coalescing works in this scenario.
- Ten batches competing for a 57-request effective budget made exactly 57 requests and accounted for every input.
- Charges responses of 403, 429, 503 and malformed JSON remained explicitly unavailable. All 50 profile timeouts became not-screened entries. Invalid arrays, oversized arrays, non-string entries and oversized strings were rejected without upstream traffic; the next valid call succeeded.

The new probe uses a real MCP client and server connected through in-memory transport, a real clock, synthetic upstream latency and zero retries. Its raised budget in throughput cases is local only. It is not a production throughput benchmark, load-balancer test or real Companies House load test. Existing tests cover retry behaviour; this probe isolates failure and accounting behaviour. No new model-provider evaluations were run; historical tool-selection flakiness remains a separate limitation.

Run `node node_modules/tsx/dist/cli.mjs scripts/stress-review.ts`. It deliberately exits 1 while the failed invariants remain. See [saved evidence](evidence/stress-review-2026-09-16.json).

## Fixes to prioritise

### P1 — input rows silently disappear

Evidence: `screen_companies` receives two identical numbers, reports `requested: 2`, but returns only one row and no explanation of the other. A valid number plus whitespace also returns only one accounted input; whitespace alone reports one requested with zero accounted.

Cause: `src/tools/composite.ts:347` filters duplicates and blank values before resolution, while `requested` retains the original array length. This contradicts the tool's promise to keep every input visible. It matters for accounts-payable ledgers where several invoices legitimately reference the same company.

Proposed fix: retain original row indices or caller row IDs, deduplicate only upstream work, and expand results back to the original rows. Blank rows must be rejected explicitly or represented as invalid. Acceptance: requested rows equal screened + unresolved + not-screened/invalid rows; duplicate rows spend no redundant upstream requests; references and order survive.

### P2 — cancellation leaves API work running

Evidence: cancelling a 50-company full snapshot batch after 16 requests still allowed it to complete all 200 requests: 184 additional requests in all three repeats.

Cause: composite callbacks at `src/tools/composite.ts:282` and `:340` do not consume the MCP request's abort signal. `fetchSections` and the concurrency helper do not check cancellation. The HTTP client already accepts a signal, but tools do not propagate it. Budget acquisition and retry sleeps also need cancellation consideration.

Proposed fix: propagate cancellation, stop scheduling queued companies/sections, and make waits abortable. Preserve independent callers sharing an in-flight request: cancelling one subscriber must not cancel useful work for another. Acceptance: no new work scheduled after cancellation is observed; aborted waits terminate promptly; unrelated requests complete normally. MCP [cancellation guidance](https://modelcontextprotocol.io/specification/2025-11-25/basic/utilities/cancellation) recommends stopping cancelled processing and freeing resources.

### P2 hardening — per-batch concurrency has no aggregate cap

Evidence: 1 / 5 / 20 distinct full-section batches peaked at 12 / 60 / 240 in-flight synthetic requests. All finished successfully; no crash or budget violation was observed.

Cause: `src/concurrency.ts:12` limits each map, and `src/tools/composite.ts:450` nests company and section maps. Concurrent tool calls each obtain their own workers. Rate budgeting limits requests per time window, not simultaneous sockets.

Proposed upgrade: a shared upstream concurrency queue with a documented limit and abortable queue entries. Acceptance: concurrent distinct batches stay below the configured global ceiling, preserve order and budget accounting, and do not starve small requests. This trades some peak throughput for predictable resource use. Do not claim four total in-flight requests from the current helper's comments.

## Niche upgrades and filming concepts

These are proposals, not currently shipped features. They reuse existing register access and should follow the fixes above.

| Priority / audience | Useful upgrade | Demonstration | Acceptance criteria |
|---|---|---|---|
| 1 — accountants and bookkeepers | Batch filing-deadline review with explicit as-of date and horizon | “Which clients have filings due in the next 30 days?” Show an illustrative client list becoming a dated checklist. | Profile-only retrieval; exact due dates; overdue / due soon / later / unknown categories; boundary-day tests; one row per client; freshness. No filings or reminders implied. |
| 2 — accounts payable | Structured comparison of supplied invoice entity fields with register fields | “These invoices repeat the same supplier. Do the names and company numbers reconcile?” Show six fictional invoice rows with duplicates, a mismatch and missing fields. | Preserve invoice references; deterministic case/whitespace normalization; field-level differences and unknowns; possible trading names remain unverified; never authenticate sender, bank account or invoice. |
| 3 — procurement | Optional detailed batch rows | “Turn a supplier onboarding list into a review worksheet.” Show status, address, dates, charge counts and coverage together. | Include fields already fetched without extra network requests; explicit missing sections; preserve lightweight default; no supplier approval or risk score. |
| 4 — company secretarial teams and business researchers | Bounded filings-since-date briefing with automatic pagination | “What has this company filed since our last review?” Show a cutoff date becoming an evidence-linked timeline. | Fetch until cutoff or stated cap; expose partial coverage; distinguish filing date from accounting period; no claims to read PDFs or monitor continuously. |

Why these are upgrades: current batch rows expose signals but omit due dates and registered addresses (`src/domain/schemas.ts:381`). Dates already exist in the profile/snapshot. Invoice comparison is currently performed by the host from a prompt. Filing history currently exposes page controls rather than a server-side date-window workflow. A shared-director comparison is another later opportunity, but full pagination and identity ambiguity make it a more involved first feature.

## Suggested release order

1. Reconcile every input and stop cancelled work; add regression tests.
2. Add an aggregate concurrency bound and stress it with distinct batches.
3. Ship the filing-deadline worksheet as the first focused niche feature; test date boundaries and missing dates before filming.
4. Ship invoice comparison with row references, then the filing briefing.

The meaningful distinction is between fetching official records and assembling a reliable business worksheet. The MCP supplies structured facts and coverage; the AI client presents them. Neither layer should silently turn missing facts into approval.
