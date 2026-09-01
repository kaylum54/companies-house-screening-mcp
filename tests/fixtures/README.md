# Fixtures

## Where these come from

Recorded from the live Companies House API with `npm run record-fixtures`.
They are real responses about real companies, not hand-authored approximations
of the documented shape.

| Fixture | Company | Why this one |
|---|---|---|
| `company/profile-active.json`, `officers/`, `charges/`, `psc/`, `filing-history/` | Royal Mail Group Limited (04138203) | Every section is populated — five officers, fifteen charges of which two are outstanding, two PSC entries — so no fixture is an empty list. |
| `company/profile-dissolved.json`, `officers/officers-dissolved.json` | Marine and General Mutual Life Assurance Society (00000006) | Incorporated 1862, dissolved 2018. The Companies House documentation's own example company. The officers list is the case that breaks a naive reading of "active": three of them have no `resigned_on` because the company was dissolved out from under them, so Companies House reports `active_count: 0` alongside `inactive_count: 3`. |
| `officers/appointments-dissolved.json` | A director of 00000006 | One person's appointments spanning live and dissolved companies, so `is_active` can be checked against the company as well as the appointment. Found because the deployed server called him a serving director of a company that has not existed since 2018. |
| `company/profile-insolvent.json`, `insolvency/` | Carillion PLC (03782379) | In compulsory liquidation since 2018. |
| `officers/appointments.json` | Derived at record time | The recorder picks whichever officer on the page holds the most appointments, so the fixture actually demonstrates the tool that follows a person across companies. |

## Why those subjects, specifically

The choice is editorial as much as technical. These names end up in generated
documentation, so the examples are institutions and widely-reported corporate
failures rather than small trading businesses.

The register is public and the data is Open Government Licence, so
republishing the facts is fine. What would not be fine is the *framing* — a
named two-director company cast as "the supplier you should worry about", or a
named individual cast as concealing a conflict, in a story invented to make a
documentation page read well. Royal Mail's and Carillion's register entries
are already among the most-read public records in the country, and an
illustrative example there adds nothing to what is on the front of the file.

The generated recipes follow the same rule: they describe what the register
shows and do not allege what it means.

## Re-recording

```bash
npm run record-fixtures
```

Reads `COMPANIES_HOUSE_API_KEY` from your environment or from a `.env` at the
repository root. Override any subject:

```bash
CH_FIXTURE_COMPANY=00000000
CH_FIXTURE_DISSOLVED_COMPANY=SC000000
CH_FIXTURE_INSOLVENT_COMPANY=00000000
```

Page sizes are capped at five so a fixture stays readable in a diff. Royal
Mail has sixty-four officers and fifteen charges; five of each exercises every
field.

**Review the diff rather than committing it blind.** It is the first honest
answer to "is our understanding of this API still right", and a surprise in it
is worth chasing before it becomes a bug. Re-recording will break assertions
that pin specific values — that is the intended cost of testing against real
data, and rewriting those assertions is part of the job.

## Why fixtures at all

Contract tests replay these files, so the suite runs offline, deterministically
and without a key. A contributor can clone the repo and run `npm test` with
nothing configured, which is the difference between a project that gets
contributions and one that does not.

The corresponding risk is drift: the API changes and nobody notices. That is
what `tests/live.smoke.test.ts` exists for. It runs against the real API on a
schedule in CI, and its job is to fail loudly the week Companies House changes
a field.

## What recording these taught us

Two things that hand-authored fixtures had wrong, and one API quirk:

- **00000006 is dissolved**, not an active trading company. The hand-authored
  version had it active.
- **Real payloads are much heavier than the invented ones.** Per-item ETags,
  filing-transaction arrays, `person_number`, `identity_verification_details`
  and search `matches` blocks pushed the measured saving from the projection
  layer up from 29–42% to **36–72%**.
- **`has_charges` on the profile is not reliable.** Royal Mail's profile
  reports `has_charges: false` while its charges endpoint returns fifteen. The
  charges section is authoritative and no signal is derived from the flag;
  there is a test pinning this so nobody "simplifies" it back.
