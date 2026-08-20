# 9. Documentation is generated from the server, and CI fails when it drifts

- **Status:** accepted
- **Date:** 2026-08-20

## Context

Every project intends to keep its reference documentation current. Almost none
manage it, and the failure is never dramatic: a field gets renamed, the page
still says the old name, and six months later the docs describe a version
nobody is running. Readers stop trusting them, which makes them not worth
updating, which finishes the job.

Worked examples rot faster than reference pages, because they contain
responses that were pasted in once and were never executed again.

## Decision

**The tool reference is generated from the running server**, not from the Zod
schemas and not by hand. `scripts/generate-tool-docs.ts` starts the server,
connects a real MCP client, calls `tools/list`, and renders what comes back.
What gets documented is therefore what a host is actually told, after the SDK
has converted schemas to JSON Schema — documenting the intent and shipping
something different is exactly the drift this is meant to catch.

**The recipes execute.** `scripts/generate-recipes.ts` runs every call on
every recipe page through the real server and embeds whatever comes back. A
recipe that stops working stops generating, and a step that returns an error
throws rather than quietly producing a page that claims it worked.

**Both are gated.** `npm run docs:check` regenerates in memory and exits 1 if
anything differs from what is committed. CI runs it before the tests, and
`tests/docs.test.ts` runs the same comparison so the failure arrives while the
change is still in front of you.

**The pages say they are generated.** Every file opens with a banner telling a
reader not to edit it by hand, and a test asserts the banner is there.

## Consequences

Changing a tool description now means running `npm run docs:generate` and
committing the result. That is the cost, it is one command, and it is the
mechanism — a cost-free version of this rule would not work.

Recipe prose lives in `scripts/generate-recipes.ts` rather than in markdown
files, which is a strange place to edit prose. The alternative was hand-written
pages with generated fragments spliced in, which cannot be drift-checked as a
whole. Keeping the whole page generated was worth the oddity.

The recipes currently run against the repository's fixtures, which are
hand-authored rather than recorded. The behaviour and derived values in those
pages are genuine; the companies are invented, every page says so, and a test
asserts the caveat is present. Once `npm run record-fixtures` has run against a
real key, the same script produces pages about real companies with no change.

Building the reference from a live server, rather than from the schemas, was
the right call for a second reason found while doing it: the first version of
the recipe generator returned the same company profile for every request, and
the generated page showed a name resolving to the *wrong company* — the exact
failure the no-names rule exists to prevent. A hand-written example would have
been written correctly and would have been fiction. This one was wrong in a way
that was visible.
