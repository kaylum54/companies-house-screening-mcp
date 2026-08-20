# 5. Tools shaped around questions, and the no-names rule

- **Status:** accepted
- **Date:** 2026-08-20

## Context

The Companies House public data API has fourteen endpoint groups. The obvious
mapping is one MCP tool per endpoint: twenty-two thin pass-throughs, a
weekend's work, and what most published MCP servers are.

Three problems with that:

1. Every tool schema sits in the model's context on every turn, needed or not.
2. It pushes orchestration onto the model. "Is this supplier safe to onboard"
   becomes search, profile, officers, charges, insolvency — five round trips,
   five chances to lose the thread.
3. The payloads carry a lot of structure nobody reads.

There is also a domain-specific hazard. Company numbers are opaque
eight-character strings with no checksum. A model asked for "Greggs" will
happily produce `00502851`, and if that is wrong it returns a *different real
company* — real directors, real charges, real accounts. Nothing downstream
marks it as the wrong one, and the answer reads as confident and correct.

## Decision

**Eleven tools shaped around questions, not endpoints.** Nine primitives
(phase 2), plus `company_snapshot` and `screen_companies` (phase 3) which fan
out server-side and return one derived object.

**Retrieval tools accept a company number and refuse a company name.** Input
containing three or more consecutive letters is rejected before any request is
made, with an error naming `find_company` as the next step. Two consecutive
letters is the longest a valid prefix gets, so this cannot reject a real
number.

**Numbers are normalised but never guessed.** Purely numeric input is
zero-padded, because "1234567" and "01234567" are unambiguously the same
company and everybody writes the short form. Anything else that is not
eight characters is rejected rather than repaired.

**Search reports its own ambiguity.** `find_company` sets
`disambiguation_needed` when more than one candidate came back and none
matched the query exactly, and the server instructions tell the host to ask
rather than take the first row.

**Upstream is read loosely, output is validated strictly.** Parsing the
Companies House payload against a strict schema would mean that the day they
add a field, every call fails — a total outage caused by a change that
affected nothing we read. So payloads are read defensively field by field, and
the contract that gets enforced is the one we publish.

## Consequences

Getting from a name to a profile costs two calls instead of one. That is the
price, and it is the right one: one extra round trip against a wrong answer
about a real business that nobody catches.

Projections have to be maintained by hand as the API grows. The live smoke
test and the `verbose` escape hatch are the mitigation — `verbose` means a
missing field never blocks anyone while a projection is updated.

Tool descriptions become load-bearing. They are the only thing a model reads
when choosing, and a badly worded one produces a failure no unit test can see:
the tool works perfectly and never gets picked. Phase 5's tool-selection eval
exists specifically for this.

The measured saving from shaping is 29% to 42%, not the order of magnitude
originally assumed here. That was corrected once it was measured, and
`scripts/measure-projections.ts` keeps it honest. The stronger arguments for
the projection layer turned out to be the derived flags, the officer IDs
lifted out of URLs, and withholding personal data by default — not size.
