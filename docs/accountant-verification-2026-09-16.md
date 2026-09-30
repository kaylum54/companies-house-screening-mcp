# Accountant feature and fixes — verification

Local, unreleased changes on top of release 0.4.0. No npm publication or Worker deployment was performed.

## Implemented

- Batch results preserve original inputs with zero-based `input_index`, including duplicates and whitespace-only rows. Resolution and upstream work are shared, then results expanded back to source rows.
- MCP cancellation reaches composite and primitive HTTP requests, retry sleeps and limiter waits. Shared requests track subscribers: cancelling one leaves others working; cancelling the final subscriber aborts and removes the request so a new caller can retry.
- `review_filing_deadlines` accepts up to 50 client rows with optional references, an optional comparison date and a 0–366 day inclusive horizon. It retrieves profiles only and retains missing dates, invalid company numbers and failed lookups explicitly. UTC is used for date arithmetic; the current register overdue flag is shown independently of the selected comparison date.
- Generated reference documentation, evaluation tool registry and two accountant selection/grounding cases are updated. Nested company numbers in accountant inputs now participate in grounding checks.

## Evidence

- Typecheck, build and generated-document checks passed.
- 607 Node tests passed. Coverage: lines 91.15%, statements 89.24%, branches 84.36%, functions 89.55%.
- 16 Worker tests passed; dependency sourcemap warnings remain non-failing.
- [Sixteen stress scenarios, three successful reruns](evidence/stress-review-after-2026-09-16.json). Before cancellation wiring, 184 further mock requests were made after cancellation. After the fix: zero further requests in all three runs. Input reconciliation now passes all three originally failing variants.
- [Actual compiled-stdio rehearsal](evidence/accountant-live-demo-2026-09-16.json): six real company-profile reads, all checked, all references preserved, no cached profiles. One accounts date in the 30-day window: Marks and Spencer P.L.C., 30 September 2026, 14 days from the comparison date. [Readable worksheet](accountant-live-worksheet.md).
- The rehearsal called the actual compiled MCP through an SDK client. It was not an end-to-end test of Codex choosing the tool from natural language. No paid model evaluation was run; the new selection cases are prepared for that follow-up.

The initial integration suite found a stale generated page and an outdated expected tool list; both were corrected before the passing full run.

## Remaining limits

- Published npm users still get 0.4.0 without the new deadline tool. Publish a new version and verify fresh npx before filming viewer installation for this feature.
- The tool creates an on-demand review. Monthly scheduling requires a separate host scheduler; it does not submit filings or send reminders.
- The aggregate concurrency hardening opportunity from the stress review is unchanged. It was not included in the requested reconciliation/cancellation/deadline scope.
- All demo client relationships are illustrative. Rehearse again on the recording day because register dates change.

## Learning note

Durable concept: cancellation has to propagate from the MCP request through queued work, shared-request subscribers and waits. Cancelling a UI promise alone does not stop API quota consumption. Evidence: the before/after stress JSON and shared-subscriber regressions in `tests/client.test.ts`. Next practice: explain why cancelling one subscriber must not abort a lookup still needed by another.
