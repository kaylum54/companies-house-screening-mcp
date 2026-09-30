# Accountant client deadline worksheet

`review_filing_deadlines` is included from version 0.5.0. Use `npx -y companies-house-screening-mcp@latest` and reconnect your client to discover the new tool. Historical rehearsal evidence below records the earlier local implementation; run the tool again for current deadlines.

## What it does

Supply up to 50 confirmed company numbers with optional internal client references. The tool retrieves company profiles and returns a row for every input, including repeated companies and failures. Each successful row has accounts and confirmation-statement due dates, with one of four categories:

- overdue: before the comparison date;
- due soon: the comparison date through the inclusive horizon (30 days by default);
- later: beyond that horizon;
- unknown: missing or invalid due date.

`as_of` defaults to today in UTC. It changes the date comparison, not the age of the retrieved register records; this is not a historical lookup. `refresh: true` requests fresh profiles. Source freshness and registered company status remain visible. The tool retrieves only profiles, so it does not pay for officer, charge or insolvency endpoints on a filing-date review.

It prepares an on-demand monthly review. Running it on a recurring schedule requires a separate scheduler in the host. It does not submit filings, calculate penalties or send reminders.

## Filming walkthrough (about 60 seconds)

1. **Face camera:** “Here's a use case for the Companies House MCP if you're an accountant. You've got a list of clients, and every month you want to see whose filings are coming up.”
2. **Show the input:** “Give it the company numbers and your client references. I'm using an example list here.” Keep **Illustrative client list — not real client relationships** visible. Use `examples/accountant-clients.json`.
3. **Show the tool call:** “Ask it to check accounts and confirmation-statement deadlines for the next thirty days.” Record the actual `review_filing_deadlines` call in Codex and trim waiting time.
4. **Show the result:** “It brings the dates back in one worksheet: overdue, coming up, later, or unknown. And if a company couldn't be checked, that row stays visible.” Point only to categories present in the real result; do not invent a missed deadline for dramatic effect.
5. **Show dates and freshness:** “You've got the lookup date here, and the original client references, so you can take this back to your client list and follow up.”
6. **Close:** “This automates pulling the worksheet together. If you want it running automatically every month, you'd connect it to a separate schedule. The example and setup are on GitHub.” Only say the last sentence once the release and guide are live.

## Codex demo prompt

```text
This is an illustrative accountant client list, not actual clients.
Use review_filing_deadlines with the following confirmed company numbers:
DEMO-01: 04138203
DEMO-02: 00445790
DEMO-03: 00185647
DEMO-04: 00502851
DEMO-05: 00214436
DEMO-06: 04412362

Use today as the comparison date, a 30-day horizon and refresh=true.
Return a compact worksheet with each client reference, legal company name,
registered status, accounts due date/category and confirmation-statement
due date/category. Keep all unknown and not-screened rows visible.
Show the comparison date, window end and data freshness.
Summarise factual follow-up items; don't infer penalties or submit anything.
```

## Rehearse before filming

Connect the published package (0.5.0 or later) or hosted MCP using the setup guide. Confirm that the tool list contains `review_filing_deadlines`, then run the prompt above. Local contributors can also build the project and point their client to `dist/bin.js` with their private Companies House environment key.

Rehearse on the recording day. Real dates and statuses can change. If there are no deadlines due soon, show that honestly; a wider horizon is a different query and must be labelled as such. Synthetic deadline-boundary tests are test evidence, not footage of current Companies House records.

Caption attribution: Contains public sector information licensed under the Open Government Licence v3.0.
