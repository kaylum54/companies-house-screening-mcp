# Portfolio review verification

Verified locally on Windows with Node 24.12.0 on 5 September 2026 (Europe/London).

## Behavior corrected

- A page of resigned officers cannot override a positive register-wide active count. Snapshots retain officer pagination; page-based departure observations identify their scope.
- Partially satisfied charges remain visible as a separate count and signal, and participate in the all-assets floating-charge observation.
- Screening retains per-company section failures, officer coverage and freshness metadata.
- Windows portability tests use filesystem-safe URL conversion and path separators. CI now includes Windows and Linux for Node 22 and 24.
- README, generated recipes, MCP licensing guidance and setup instructions distinguish registered facts from business conclusions and qualify OGL exclusions.

## Checks and outcomes

| Check | Outcome |
|---|---|
| TypeScript typecheck and build | Passed |
| Generated tool and recipe drift checks | Passed |
| Full Node suite with coverage | 589 passed; 22 test files |
| Coverage gates | Passed: 91.14% lines, 89.18% statements, 85.15% branches, 89.20% functions |
| Workers/workerd suite | 16 passed |
| Release package inspection | Passed: 90 files, approximately 488 KB unpacked; no publish performed |
| Live Companies House smoke suite | 5 passed |
| Live compiled stdio MCP | Handshake/list of 11 tools, company_snapshot and a two-company screen passed |
| Affected docs and eval tests after diagnostic wording changes | 69 passed |
| Real-model selection evaluation | 54/58 cases passed all three repeats; four flaky cases; nonzero exit retained |

The regression tests were run before the fixes and failed on missing officer pagination and partially satisfied charge visibility. They pass after the fixes. Further tests cover an unknown global count on a partial page, an explicit zero count on an empty page, future resignation dates, and unavailable sections in a batch row.

The full model run made 174 selections against `openrouter:z-ai/glm-5.2`. Grounding passed 7/7; flaky cases were `trap-foreign-registration`, `para-trading-1`, `near-who-is-behind` and `noise-typos`. These include incorrect but plausible company numbers. The tool interface is not a guarantee against model transcription or grounding failures. [Saved result and provenance](../evals/baselines/README.md).

## Reproduce

Use the [README verification commands](../README.md#development-and-verification). Build before running the suites. Live smoke tests require a Companies House REST key; model evaluations require a provider key and incur provider usage.

This machine's normal npm launcher pointed at a missing npm installation. Checks used installed project CLIs directly, and the intact npm JavaScript entry point for `release:check`. npm's cache was redirected to a temporary directory for the package inspection; no global Node/npm settings were changed. Workers emitted dependency sourcemap warnings and a sandbox static-analysis warning, while all runtime tests passed. Live calls required network access outside the sandbox.

The expanded Linux/Windows CI matrix has been configured, not executed on GitHub during this review. Claude Desktop/Code UI setup is documented against official guides; the compiled protocol flow was tested, but those clients' graphical setup screens were not manually exercised. Docker image publishing and a public hosted deployment were not performed. Existing user edits to `wrangler.toml` were preserved.

## Optional practice

Explain why `active_count: 1` and an empty `active` array can both be correct when `officers.pagination.has_more` is true. The array describes a page; the count describes the register.
