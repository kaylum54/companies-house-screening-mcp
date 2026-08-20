import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

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

How to use it:
- Every retrieval tool takes an eight-character company number. If you have a name, call find_company first. Do not guess a number — a plausible wrong one returns a real company and nothing downstream will flag the mistake.
- When find_company reports disambiguation_needed, ask which company was meant rather than taking the first result.
- get_company returns derived flags (overdue filings, charges, insolvency history, incorporated within the last year) computed by this server. Prefer them to working the same thing out from dates.
- Every response carries meta.rate_limit_remaining. Companies House allows 600 requests per five minutes; pace long runs by that number, and check meta.stale before relying on an answer during an outage.

This server cannot change anything. There is no filing, no write path, and no access to anything beyond the public register.

Data is published by Companies House under the Open Government Licence v3.0. When reproducing it, include: "Contains public sector information licensed under the Open Government Licence v3.0."`;

export function createServer(context: ToolContext, version: string): McpServer {
  const server = new McpServer({ name: SERVER_NAME, version }, { instructions: INSTRUCTIONS });
  registerTools(server, context);
  return server;
}
