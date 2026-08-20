import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

import { registerCompositeTools } from './tools/composite.js';
import { registerTools } from './tools/definitions.js';
import type { ToolContext } from './tools/shared.js';

export const SERVER_NAME = 'companies-house';

/**
 * Sent to the host once, during initialisation.
 *
 * This is where anything that applies across every tool belongs, rather than
 * being repeated in nine descriptions or attached to every response. The
 * Open Government Licence attribution lives here for that reason: it has to
 * be stated, and stating it once per session costs a fraction of stating it
 * on every call.
 */
export const INSTRUCTIONS = `Read-only access to the UK Companies House register: company profiles, officers, filing history, charges, persons with significant control, insolvency, and officer appointment networks.

READ ONLY. This server cannot file, submit, change, update or delete anything. If you are asked to do any of those, say plainly that it is not possible here — do not call a read tool instead and present it as progress.

Start with company_snapshot for a single company and screen_companies for anything involving more than one — they fan out server-side and cost you one call instead of four. Reach for the primitive tools when you need a full list rather than a summary: every officer including resigned ones, every charge, the filing history, the PSC register.

How to use it:
- Every retrieval tool takes an eight-character company number. If you have a name, call find_company first. Do not guess a number — a plausible wrong one returns a real company and nothing downstream will flag the mistake.
- When find_company reports disambiguation_needed, ask which company was meant rather than taking the first result.
- get_company returns derived flags (overdue filings, charges, insolvency history, incorporated within the last year) computed by this server. Prefer them to working the same thing out from dates.
- The signals on a snapshot are facts read off the register, not a rating. This server does not score companies and will not tell you whether one is safe to trade with. An empty signal list means nothing on the list was found, not that the company is sound, and signals can only reflect the sections named in sections_included.
- screen_companies never guesses which company a name meant. Rows it could not resolve come back under unresolved with candidates, and anything skipped for rate-limit budget comes back under not_screened. The table is never quietly shorter than the list you sent.
- Every response carries meta.rate_limit_remaining. Companies House allows 600 requests per five minutes; pace long runs by that number, and check meta.stale before relying on an answer during an outage.

There is no write path and no access to anything beyond the public register.

Data is published by Companies House under the Open Government Licence v3.0. When reproducing it, include: "Contains public sector information licensed under the Open Government Licence v3.0."`;

export function createServer(context: ToolContext, version: string): McpServer {
  const server = new McpServer({ name: SERVER_NAME, version }, { instructions: INSTRUCTIONS });
  registerTools(server, context);
  registerCompositeTools(server, context);
  return server;
}
