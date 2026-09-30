# Release 0.5.0 verification — 30 September 2026

Released source: `785b8e3ee5729a248391cbc59cc4d630de02058f`, tag `v0.5.0`.

## Delivered

- Accountant filing-deadline worksheets are published: 12 tools in both npm and hosted MCP.
- Empty and whitespace-only batch rows are retained as unresolved; duplicate rows retain their original indices and share upstream lookups.
- Cancellation reaches ongoing work and queued waits. A cancelled semaphore waiter spends no request budget and is not recorded as upstream traffic.
- Fresh cached deadline profiles remain usable at zero budget. Explicit refresh still requires budget; mixed cached/uncached inputs retain each row and its outcome.
- At most 12 upstream operations run concurrently across a shared client and its session views. This is a process/isolate bound, not a distributed global concurrency limit. The existing Durable Object continues enforcing the distributed request budget.
- Full and production-only npm audits report zero vulnerabilities. Runtime transitive packages were updated within supported ranges; narrow development-only Miniflare overrides select patched sharp and undici versions.
- CI now fails if its live API key is missing. The repository secret is configured, manual verification is enabled, and the actual live job passed five tests.

## Evidence

| Verification | Result |
|---|---|
| Typecheck/build/generated documentation | Passed |
| Node regression coverage | 615 tests passed, 91.45% line coverage |
| Worker runtime tests | 16 passed |
| Real API smoke tests | 5 passed locally and in GitHub CI |
| Offline MCP stress | 17 scenarios passed; twenty distinct batches peaked at 12 requests rather than the earlier 240 |
| Cancellation stress | Zero additional upstream calls after cancellation |
| npm package artifact checks | Passed |
| npm full / production audits | Zero vulnerabilities at release time |
| CI Node 22/24, Windows/Linux and Worker job | Passed |
| Release verification/npm/container publishing | Passed |
| Fresh-cache npx 0.5.0 installation | Connected; 12 tools; reconciliation and six-company deadline lookup passed |
| Hosted MCP 0.5.0 | Same acceptance checks passed |

- [CI run, including actual live tests](https://github.com/kaylum54/companies-house-screening-mcp/actions/runs/36660645811)
- [Successful release workflow](https://github.com/kaylum54/companies-house-screening-mcp/actions/runs/36660646378)
- [Published npm package](https://www.npmjs.com/package/companies-house-screening-mcp/v/0.5.0); `latest` verified as 0.5.0.
- Hosted endpoint: `https://companies-house-screening-mcp.kaylumj0.workers.dev/mcp`
- Worker version ID: `e5122af0-7166-4c2b-86ae-5bdddfec211c`.
- [Actual public transport verification](evidence/release-0.5.0-live.json)
- [Stress output](evidence/stress-release-0.5.0.json)
- [Hosted accountant response](evidence/release-0.5.0-hosted-worksheet.json) and [fresh npx response](evidence/release-0.5.0-npx-worksheet.json)
- [Readable demonstration worksheet](accountant-worksheet-2026-09-30.md)

The queue implementation initially made rate-limit refusals enter network retry handling. The full suite caught four timeout failures; separating budget refusal from fetch retry fixed them, and the final complete suite passed. npm briefly returned 404 while processing the accepted publish; verification was repeated only once the version became publicly available.

## Using this release

Use `npx -y companies-house-screening-mcp@latest` in the existing MCP client configuration, retaining your private Companies House API key, and restart/reconnect the MCP server. Configurations pinned to 0.4.0 need their version changed. Hosted users should reconnect so their client refreshes its tool list.

## Limits

No high-volume production load test or paid model evaluation was run. Stress evidence uses synthetic upstream responses. The worksheet is an on-demand review, not a scheduler or filing service. The six-company sample currently has no deadlines within the displayed 30-day window; do not imply otherwise in a video. Run it again on filming day. Local npx usage still has no telemetry, and hosted aggregate calls do not establish unique users.

The September 30 health report and September 16 rehearsal remain historical before-fix evidence; this document records the released state.
