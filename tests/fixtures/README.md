# Fixtures

## Provenance, stated plainly

The files in this directory are **hand-authored to the documented response
shape**, not recorded from the live API. They were written without an API key
in hand, so they are correct about field names and structure and they are not
evidence about any real company.

That distinction matters, so the company names in them are obviously
synthetic. Nobody should be able to read a fixture and think it is a claim
about a real business.

## Replacing them with recorded responses

Once you hold an API key:

```bash
export COMPANIES_HOUSE_API_KEY=your_key
npm run record-fixtures
```

`scripts/record-fixtures.ts` fetches each fixture's real counterpart, strips
nothing, and overwrites the file. Review the diff before committing — that
diff is the first honest answer to "is our understanding of this API right",
and any surprise in it is worth reading properly rather than accepting.

## Why fixtures at all

Contract tests replay these files so the suite runs offline, deterministically,
and without a key. That means a contributor can clone the repo and run
`npm test` with nothing configured, which is the difference between a project
that gets contributions and one that does not.

The corresponding risk is that fixtures drift from reality without anyone
noticing. That is what `tests/live.smoke.test.ts` exists for: it runs against
the real API on a schedule in CI, and its job is to fail loudly the week
Companies House changes a field.
