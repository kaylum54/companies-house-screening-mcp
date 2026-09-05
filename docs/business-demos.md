# Business demos and short video scripts

Start with a business task, show the input and result, then explain how the MCP supplied the facts. Use current lookups with a visible date, or clearly label recorded fixtures. Never present a fictional invoice or supplier relationship as real.

## 1. Procurement: a supplier review worksheet

**Hook:** “Procurement sent me a supplier list. Which registered records need a closer look?”

Use the [sample CSV](../examples/supplier-list.csv) as a labelled illustrative list. A file-capable host can read it; otherwise paste the company numbers.

**Prompt:** “Screen these company numbers. Return every input, legal name, registered status, factual signals, sections included, unavailable sections, officer pagination if requested, and data freshness. Separate unresolved and not-screened entries. Do not rank companies or approve suppliers. Summarise factual questions for human follow-up.”

**Show:** input list → `screen_companies` → worksheet → one `company_snapshot` drill-down. The benefit is consolidated evidence and visible incomplete checks, not an automated onboarding decision. Officers are off by default; request them explicitly if needed.

**45-second script:** 0–5s show the list and hook; 5–15s paste the prompt; 15–30s show an observation and its supporting date; 30–40s show coverage or a skipped entry; 40–45s point viewers to the setup guide. Do not claim a measured time saving unless you actually measure it.

## 2. Accounts payable: compare invoice details

**Hook:** “Before paying this first invoice, I checked which legal company it named.”

Make a clearly fictional invoice containing a real company number and deliberately mismatched legal name. Do not add real bank details.

**Prompt:** “Compare this illustrative invoice's company number, legal name and claimed registered office with company_snapshot. Return matching details, differences and unknowns. An address may be a trading address. Do not authenticate the invoice, approve payment or infer bank-account ownership.”

**Show:** invoice → registered profile → comparison table → request to confirm the legal entity with the supplier. The host reads the invoice; the MCP only retrieves register data. Independently verify any bank-detail change. A matching register record cannot establish that the sender represents the company.

## 3. Sales operations: resolve CRM legal entities

**Hook:** “Our CRM has brand names. Which legal companies are behind these records?”

**Prompt:** “Use find_company for these names. Show candidate company numbers, registered names and locations. Keep ambiguous entries unresolved and ask for confirmation. Do not invent company numbers. Produce a table I can review before importing into our CRM.”

**Show:** three names → candidate table → user confirms one entity → final reviewed table. Use an ambiguous input to demonstrate why guessing is unsafe. The host formats any CSV; the MCP neither writes to the CRM nor proves that a brand belongs to a candidate entity.

## 4. Accountancy: filing-date review

**Hook:** “Which clients have filing dates coming up?”

**Prompt:** “For these confirmed company numbers, retrieve accounts and confirmation-statement next_due dates using company_snapshot. Using today's date, list dates within the next 30 days, overdue observations and missing dates separately. Include data freshness. Do not file anything or infer a penalty.”

**Show:** sample client list → dated checklist → human follow-up. A registered due date is useful task input; the MCP does not submit filings, create calendar reminders or replace the accountant's records. If you show calendar creation, label it as a separate host integration and obtain its required approval.

## 5. Procurement governance: director overlaps

**Hook:** “Do these two registered companies share any officer appointments?”

**Prompt:** “Retrieve all officer pages for these two companies. Compare officer IDs, then inspect relevant get_officer_appointments pages. Separate current and resigned appointments. List shared records with evidence and identity limitations; do not allege an undisclosed conflict.”

**Show:** company pair → paginated officer retrieval → overlap table → question for human review. Shared names do not establish identity, one person can have multiple officer IDs, and shared directors can be ordinary group structure. Avoid displaying birth dates or addresses unless essential to the explanation.

## 6. Business research: a filing briefing

**Hook:** “What has this company filed since our last review?”

**Prompt:** “Get filing history since [date], fetching pages until the period is covered. Return filing date, type, description and relevant description values. Distinguish filing date from the accounts period. Do not claim to have read the PDF or infer revenue from filing metadata.”

**Show:** date cutoff → filing timeline → questions for a researcher. This is an on-demand briefing. A recurring watch needs separate scheduling, persistent previous results and comparison logic; the MCP does not provide those. Default filing-history caching is six hours, so this is not a real-time alert feed.

## Publishing checklist

- Show the actual output, tool calls and lookup date. Label fixture demonstrations and fictional paperwork.
- Keep API keys, customer records and unnecessary personal details out of the recording.
- Describe what the register records; do not label real companies fraudulent, unsafe or insolvent unless the precise current register fact supports the statement.
- Charges can be normal financing; absence of signals is not approval. Active registration is not proof of trading.
- Include “Contains public sector information licensed under the Open Government Licence v3.0” for OGL-covered material. Personal data is outside that licence; see [data reuse](../README.md#licence-and-data-reuse).
- End with a real setup link. Do not advertise a public endpoint until it exists and a tool call succeeds.

Suggested order: supplier worksheet, invoice comparison, CRM cleanup. Each has a visible input, a concrete output and a clear human next step.
