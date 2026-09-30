# Health fixes and release plan

Authorized scope: fix September 30 health findings, verify, and publish/deploy the resulting MCP including the existing accountant/cancellation work.

1. Let empty company strings reach row validation; retain every batch input.
2. Plan deadline requests against cache availability before spending API budget. Refresh must still request current upstream data. The HTTP limiter remains authoritative if a cache entry expires after planning.
3. Bound concurrent upstream operations to 12 per shared client, including its session views. Cancellation removes queued work; completed/error responses release slots. This bounds a process/Worker isolate, not every distributed isolate globally. Keep the existing Durable Object request-budget enforcement.
4. Update affected runtime dependencies within supported ranges. Patch development-only Miniflare transitive dependencies through narrowly scoped overrides where upstream pins prevent normal updates. Verify workerd compatibility.
5. Make missing live-test credentials a failure, set the existing Companies House credential as the repository CI secret without exposing it, and permit manual live verification.
6. Release as 0.5.0: update generated documentation and availability notices; run typecheck, build, full coverage, Worker tests, live API tests, stress cases, dependency audits and packaged-artifact checks. Commit/push and use the tag-driven npm/container release. Deploy Worker using existing configuration.
7. Verify fresh npx and hosted tool discovery, version, empty-row handling and accountant worksheet using real register records. Run GitHub CI including its live job. Record results and remaining limitations.

Acceptance: empty rows no longer reject a valid batch; fresh cached deadline profiles work at zero budget; queued cancellation does not leak request slots; shared concurrent calls stay within the bound; audits clean; actual published and deployed 0.5.0 expose all 12 tools and pass real lookups; CI executes live tests.

Tradeoff: a bounded queue lowers burst throughput in exchange for bounded resource use. Cache preflight is advisory rather than a reservation; the existing limiter still protects the request window if the cache changes between planning and use. A distributed concurrency service would add operational complexity and is outside this repair.
