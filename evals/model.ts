import Anthropic from '@anthropic-ai/sdk';

import type { ToolCall } from './score.js';

/**
 * The model half of the eval, behind an interface.
 *
 * Everything expensive and non-deterministic is on the other side of
 * `Selector`. Tests inject a scripted one; the runner injects a real model,
 * through whichever provider is configured.
 *
 * Two providers are supported because not everybody has an Anthropic account,
 * and because being able to ask the same question of several models is the
 * more useful property anyway — a tool description that only one model reads
 * correctly is a tool description with a problem.
 */

export interface ToolDefinition {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
}

export interface Selector {
  /** Returns the tool calls the model made on its first turn. Nothing is executed. */
  select(question: string, system: string, tools: ToolDefinition[]): Promise<ToolCall[]>;
  readonly label: string;
}

export type ProviderName = 'anthropic' | 'openrouter';

/**
 * Defaults per provider.
 *
 * OpenRouter defaults to GLM 5.2 rather than to the frontier model the
 * Anthropic route uses. A full pass is roughly fifty-six thousand input
 * tokens — about four pence on GLM against thirty on a frontier model — and an
 * eval nobody runs because of the bill is an eval that is not doing anything.
 *
 * It also makes the eval more useful, not less. A tool description that only a
 * frontier model reads correctly is a tool description with a problem: the
 * cheaper model failing a case is a finding about the description, not about
 * the model. Run it across several with --model; the report records which was
 * used, because a pass rate without a model beside it means nothing.
 *
 * A note on `z-ai/glm-5.2:free`, which is tempting and is not the default:
 * free tiers queue and throttle, and this eval treats an inconsistent result
 * as a *finding* about overlapping tool descriptions. Throttling would show up
 * as flakiness that has nothing to do with the descriptions, which is the one
 * kind of noise this suite must not manufacture.
 */
export const DEFAULT_MODEL: Record<ProviderName, string> = {
  anthropic: 'claude-opus-5',
  openrouter: 'z-ai/glm-5.2'
};

// --- Anthropic ------------------------------------------------------------

export interface AnthropicSelectorOptions {
  model?: string;
  maxTokens?: number;
  client?: Anthropic;
}

/**
 * One turn, tools offered, nothing executed.
 *
 * The eval only cares what the model *reaches for*, which the first turn
 * settles. Running the full agent loop would cost several times as much and
 * would mix tool-selection failures together with everything that can go wrong
 * downstream of them.
 *
 * The server's own instructions go in as the system prompt, because that is
 * what a real host sends and because the instructions are part of what is
 * being tested.
 */
export function anthropicSelector(options: AnthropicSelectorOptions = {}): Selector {
  const model = options.model ?? DEFAULT_MODEL.anthropic;
  const client = options.client ?? new Anthropic();
  const maxTokens = options.maxTokens ?? 16000;

  return {
    label: `anthropic:${model}`,
    async select(question, system, tools) {
      const response = await client.messages.create({
        model,
        max_tokens: maxTokens,
        system,
        tools: tools.map((tool) => ({
          name: tool.name,
          description: tool.description,
          input_schema: tool.input_schema as Anthropic.Tool['input_schema']
        })),
        messages: [{ role: 'user', content: question }]
      });

      return response.content
        .filter((block): block is Anthropic.ToolUseBlock => block.type === 'tool_use')
        .map((block) => ({
          name: block.name,
          // Tool inputs come back as parsed JSON; never string-match the raw
          // serialisation, which varies in its escaping between models.
          input: (block.input ?? {}) as Record<string, unknown>
        }));
    }
  };
}

// --- OpenRouter -----------------------------------------------------------

export interface OpenAiFunctionTool {
  type: 'function';
  function: { name: string; description: string; parameters: Record<string, unknown> };
}

/**
 * MCP tool definitions to the OpenAI function-calling shape OpenRouter speaks.
 *
 * `$schema` is stripped because several providers reject a schema carrying it,
 * and a top-level `type: "object"` is asserted because some reject a schema
 * without one. Both are the kind of difference that turns into a 400 with an
 * unhelpful message rather than anything obvious.
 */
export function toOpenAiTools(tools: ToolDefinition[]): OpenAiFunctionTool[] {
  return tools.map((tool) => {
    const { $schema: _ignored, ...parameters } = tool.input_schema as Record<string, unknown> & {
      $schema?: unknown;
    };
    return {
      type: 'function',
      function: {
        name: tool.name,
        description: tool.description,
        parameters: { type: 'object', ...parameters }
      }
    };
  });
}

interface OpenAiToolCall {
  function?: { name?: unknown; arguments?: unknown };
}

/**
 * Reads tool calls out of an OpenAI-shaped response.
 *
 * The trap here is that `arguments` is a **JSON string**, not an object —
 * unlike the Anthropic shape, where it arrives parsed. Forgetting that gives
 * you an argument check comparing a company number against the characters
 * `{"company_number":"04138203"}`, which fails in a way that looks like a
 * model error rather than a parsing bug.
 *
 * A call whose arguments will not parse is kept with empty arguments rather
 * than dropped: the model did choose that tool, and the tool-choice check
 * should still see it.
 */
export function parseOpenAiToolCalls(toolCalls: unknown): ToolCall[] {
  if (!Array.isArray(toolCalls)) return [];

  return toolCalls
    .map((entry) => {
      // `entry` itself can be null. Optional chaining on `call.function`
      // guards the property, not the object holding it, so this check is not
      // redundant — without it a null in the array throws.
      if (typeof entry !== 'object' || entry === null) return undefined;

      const call = entry as OpenAiToolCall;
      const name = call.function?.name;
      if (typeof name !== 'string' || name === '') return undefined;

      const raw = call.function?.arguments;
      if (typeof raw === 'object' && raw !== null) {
        return { name, input: raw as Record<string, unknown> };
      }
      if (typeof raw !== 'string' || raw.trim() === '') return { name, input: {} };

      try {
        const parsed: unknown = JSON.parse(raw);
        return {
          name,
          input: typeof parsed === 'object' && parsed !== null ? (parsed as Record<string, unknown>) : {}
        };
      } catch {
        return { name, input: {} };
      }
    })
    .filter((call): call is ToolCall => call !== undefined);
}

export interface OpenRouterSelectorOptions {
  model?: string;
  apiKey?: string;
  baseUrl?: string;
  maxTokens?: number;
  /** Injectable for tests. */
  fetchImpl?: typeof fetch;
  maxRetries?: number;
  sleep?: (ms: number) => Promise<void>;
}

const RETRYABLE = new Set([408, 409, 429, 500, 502, 503, 504]);

export function openRouterSelector(options: OpenRouterSelectorOptions = {}): Selector {
  const model = options.model ?? DEFAULT_MODEL.openrouter;
  const baseUrl = options.baseUrl ?? 'https://openrouter.ai/api/v1';
  const apiKey = options.apiKey ?? process.env['OPENROUTER_API_KEY'] ?? '';
  const doFetch = options.fetchImpl ?? globalThis.fetch;
  const maxRetries = options.maxRetries ?? 3;
  const sleep = options.sleep ?? ((ms: number) => new Promise((resolve) => setTimeout(resolve, ms)));

  return {
    label: `openrouter:${model}`,
    async select(question, system, tools) {
      const body = JSON.stringify({
        model,
        max_tokens: options.maxTokens ?? 16000,
        tools: toOpenAiTools(tools),
        tool_choice: 'auto',
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: question }
        ]
      });

      let lastError = '';
      for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
        if (attempt > 0) await sleep(Math.min(500 * 2 ** (attempt - 1), 8000));

        const response = await doFetch(`${baseUrl}/chat/completions`, {
          method: 'POST',
          headers: {
            authorization: `Bearer ${apiKey}`,
            'content-type': 'application/json',
            // OpenRouter uses these for its public model-usage rankings. They
            // are optional; identifying the caller is simply polite.
            'http-referer': 'https://github.com/companies-house-screening-mcp',
            'x-title': 'companies-house-screening-mcp eval'
          },
          body
        });

        if (!response.ok) {
          lastError = `${response.status} ${(await response.text()).slice(0, 300)}`;
          if (RETRYABLE.has(response.status) && attempt < maxRetries) continue;
          throw new Error(`OpenRouter request failed: ${lastError}`);
        }

        const payload = (await response.json()) as {
          choices?: { message?: { tool_calls?: unknown } }[];
          error?: { message?: string };
        };

        // OpenRouter can return HTTP 200 with an error body when an upstream
        // provider fails, so the status alone is not enough to trust it.
        if (payload.error !== undefined) {
          lastError = payload.error.message ?? 'unknown error';
          if (attempt < maxRetries) continue;
          throw new Error(`OpenRouter returned an error: ${lastError}`);
        }

        return parseOpenAiToolCalls(payload.choices?.[0]?.message?.tool_calls);
      }

      throw new Error(`OpenRouter request failed after ${maxRetries + 1} attempts: ${lastError}`);
    }
  };
}

// --- selection ------------------------------------------------------------

export interface CreateSelectorOptions {
  provider?: ProviderName | undefined;
  model?: string | undefined;
  env?: NodeJS.ProcessEnv;
}

export interface ProviderResolution {
  provider: ProviderName | undefined;
  /** Populated when neither key is present. */
  problem?: string;
}

/**
 * Works out which provider to use.
 *
 * An explicit `--provider` always wins, and says so loudly if its key is
 * missing rather than silently falling back to the other one — a run that
 * quietly measured a different model than you asked for is worse than a run
 * that failed.
 */
export function resolveProvider(options: CreateSelectorOptions = {}): ProviderResolution {
  const env = options.env ?? process.env;
  const hasAnthropic = (env['ANTHROPIC_API_KEY'] ?? '') !== '';
  const hasOpenRouter = (env['OPENROUTER_API_KEY'] ?? '') !== '';

  if (options.provider === 'anthropic') {
    return hasAnthropic
      ? { provider: 'anthropic' }
      : { provider: undefined, problem: 'ANTHROPIC_API_KEY is not set, but --provider anthropic was given.' };
  }

  if (options.provider === 'openrouter') {
    return hasOpenRouter
      ? { provider: 'openrouter' }
      : { provider: undefined, problem: 'OPENROUTER_API_KEY is not set, but --provider openrouter was given.' };
  }

  // No explicit choice: OpenRouter first, because somebody who has configured
  // it has usually done so in preference to a direct account.
  if (hasOpenRouter) return { provider: 'openrouter' };
  if (hasAnthropic) return { provider: 'anthropic' };

  return {
    provider: undefined,
    problem: 'Neither OPENROUTER_API_KEY nor ANTHROPIC_API_KEY is set.'
  };
}

export function createSelector(provider: ProviderName, model?: string | undefined): Selector {
  return provider === 'openrouter'
    ? openRouterSelector(model === undefined ? {} : { model })
    : anthropicSelector(model === undefined ? {} : { model });
}

/** A selector driven by a lookup table. Used by the tests. */
export function scriptedSelector(script: Record<string, ToolCall[]>): Selector {
  return {
    label: 'scripted',
    select: async (question) => script[question] ?? []
  };
}
