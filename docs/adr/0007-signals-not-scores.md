# 7. Signals, not scores

- **Status:** accepted
- **Date:** 2026-08-20

## Context

`company_snapshot` and `screen_companies` exist to answer "should I look
harder at this company". The obvious way to finish that job is a rating —
green, amber, red, or a number out of a hundred — and a screening table sorted
by it. It is what every commercial product in this space does, and it is what
somebody will eventually open an issue asking for.

## Decision

No rating. No score, no grade, no severity, no traffic light. The snapshot
carries `signals`: a list of `{ code, detail }` pairs, each one a fact read
off the register with the date or the name behind it.

The reasoning is not squeamishness about the maths. It is that the maths would
be dishonest:

- **The inputs do not support the conclusion.** This server can see filings,
  charges and officers. It cannot see the bank balance, the order book, the
  parent guarantee, or the reason the accounts are three weeks late. A company
  can be overdue because its accountant is ill; a company can be perfectly
  current on filings the month before it collapses.
- **A number stops being questioned.** "Two signals, one of them an
  outstanding charge held by a bank" invites a person to think. "Risk score:
  72" gets pasted into a spreadsheet, sorted, and acted on. The compression
  destroys exactly the information a reader would have needed to disagree.
- **There is a real company on the other end.** Being dropped by a customer on
  the strength of a number produced by a tool that never saw your accounts,
  with no way to find out why, is a bad thing to build.

So the tool reports what it saw and leaves the judgement with the person
making the decision, who has context this server does not.

`signals` is ordered by materiality as a human reader would rank it. That is
an ordering, not a scoring: nothing combines two signals into a third and
nothing weights them.

## Consequences

Callers who want a ranking have to write it themselves, with their own
thresholds, in the open. That is the point — their weighting is visible and
arguable, whereas one baked in here would not be.

`signals: []` is ambiguous unless the caller checks `sections_included`. An
empty list means nothing on the list was found, which is not the same as the
company being sound, and is definitely not the same as the charges call having
failed. Hence `sections_included` and `sections_unavailable` on every snapshot,
`sections_used` on every screening table, and a test asserting no scoring
vocabulary appears anywhere in a signal.

If this is ever revisited, the thing to add is more signals, not a number.
