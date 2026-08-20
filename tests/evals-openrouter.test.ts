import { describe, expect, it } from 'vitest';

import {
  DEFAULT_MODEL,
  openRouterSelector,
  parseOpenAiToolCalls,
  resolveProvider,
  toOpenAiTools
} from '../evals/model.js';

/**
 * The OpenRouter path.
 *
 * OpenRouter speaks the OpenAI function-calling shape, which differs from the
 * Anthropic shape in ways that are easy to get wrong and hard to notice: tool
 * definitions are wrapped in a `function` envelope, and — the one that bites —
 * arguments arrive as a **JSON string** rather than a parsed object.
 *
 * Getting that wrong would not crash. It would quietly make every argument
 * assertion in the eval compare a company number against the characters
 * `{"company_number":"04138203"}` and report the model as wrong. An eval that
 * blames the model for its own parsing bug is worse than no eval.
 */

describe('toOpenAiTools', () => {
  const tool = {
    name: 'get_company',
    description: 'Profile for one company.',
    input_schema: {
      $schema: 'http://json-schema.org/draft-07/schema#',
      type: 'object',
      properties: { company_number: { type: 'string' } },
      required: ['company_number']
    }
  };

  it('wraps each tool in the function envelope', () => {
    const [converted] = toOpenAiTools([tool]);
    expect(converted?.type).toBe('function');
    expect(converted?.function.name).toBe('get_company');
    expect(converted?.function.description).toBe('Profile for one company.');
  });

  it('strips $schema, which several providers reject', () => {
    const [converted] = toOpenAiTools([tool]);
    expect(converted?.function.parameters).not.toHaveProperty('$schema');
    expect(converted?.function.parameters['required']).toEqual(['company_number']);
  });

  it('asserts a top-level object type, which others require', () => {
    const [converted] = toOpenAiTools([
      { name: 'x', description: 'y', input_schema: { properties: {} } }
    ]);
    expect(converted?.function.parameters['type']).toBe('object');
  });

  it('converts every tool it is given', () => {
    expect(toOpenAiTools([tool, { ...tool, name: 'other' }])).toHaveLength(2);
  });
});

describe('parseOpenAiToolCalls', () => {
  it('parses arguments, which arrive as a JSON string rather than an object', () => {
    const calls = parseOpenAiToolCalls([
      { function: { name: 'get_company', arguments: '{"company_number":"04138203"}' } }
    ]);

    expect(calls).toEqual([{ name: 'get_company', input: { company_number: '04138203' } }]);
  });

  it('accepts arguments that already arrived parsed', () => {
    const calls = parseOpenAiToolCalls([
      { function: { name: 'get_company', arguments: { company_number: '04138203' } } }
    ]);
    expect(calls[0]?.input).toEqual({ company_number: '04138203' });
  });

  it('keeps a call whose arguments will not parse, with empty arguments', () => {
    // The model did choose that tool. Dropping the call would hide a
    // tool-choice failure behind a parsing failure.
    const calls = parseOpenAiToolCalls([{ function: { name: 'find_company', arguments: '{oops' } }]);
    expect(calls).toEqual([{ name: 'find_company', input: {} }]);
  });

  it('treats absent or empty arguments as no arguments', () => {
    expect(parseOpenAiToolCalls([{ function: { name: 'a' } }])).toEqual([{ name: 'a', input: {} }]);
    expect(parseOpenAiToolCalls([{ function: { name: 'a', arguments: '' } }])).toEqual([
      { name: 'a', input: {} }
    ]);
  });

  it('ignores entries with no usable tool name', () => {
    expect(parseOpenAiToolCalls([{ function: { arguments: '{}' } }, {}, null])).toEqual([]);
  });

  it('returns nothing when the model called no tool', () => {
    expect(parseOpenAiToolCalls(undefined)).toEqual([]);
    expect(parseOpenAiToolCalls([])).toEqual([]);
  });

  it('keeps several calls in order', () => {
    const calls = parseOpenAiToolCalls([
      { function: { name: 'find_company', arguments: '{"query":"a"}' } },
      { function: { name: 'get_company', arguments: '{"company_number":"1"}' } }
    ]);
    expect(calls.map((call) => call.name)).toEqual(['find_company', 'get_company']);
  });
});

describe('openRouterSelector', () => {
  const okResponse = (toolCalls: unknown): Response =>
    new Response(JSON.stringify({ choices: [{ message: { tool_calls: toolCalls } }] }), {
      status: 200,
      headers: { 'content-type': 'application/json' }
    });

  it('sends the system prompt, the question and the tools', async () => {
    let seen: Record<string, unknown> = {};
    const selector = openRouterSelector({
      apiKey: 'test',
      fetchImpl: async (_url, init) => {
        seen = JSON.parse(String(init?.body)) as Record<string, unknown>;
        return okResponse([{ function: { name: 'find_company', arguments: '{"query":"x"}' } }]);
      }
    });

    const calls = await selector.select('who is x?', 'SERVER INSTRUCTIONS', [
      { name: 'find_company', description: 'search', input_schema: { type: 'object' } }
    ]);

    const messages = seen['messages'] as { role: string; content: string }[];
    expect(messages[0]).toEqual({ role: 'system', content: 'SERVER INSTRUCTIONS' });
    expect(messages[1]).toEqual({ role: 'user', content: 'who is x?' });
    expect(seen['tool_choice']).toBe('auto');
    expect(calls[0]?.name).toBe('find_company');
  });

  it('posts to the chat completions endpoint with a bearer token', async () => {
    let url = '';
    let auth = '';
    const selector = openRouterSelector({
      apiKey: 'sk-test-123',
      fetchImpl: async (target, init) => {
        url = String(target);
        auth = new Headers(init?.headers as Record<string, string>).get('authorization') ?? '';
        return okResponse([]);
      }
    });

    await selector.select('q', 's', []);
    expect(url).toBe('https://openrouter.ai/api/v1/chat/completions');
    expect(auth).toBe('Bearer sk-test-123');
  });

  it('retries a rate limit and then succeeds', async () => {
    let attempts = 0;
    const selector = openRouterSelector({
      apiKey: 'test',
      sleep: async () => {},
      fetchImpl: async () => {
        attempts += 1;
        if (attempts === 1) return new Response('slow down', { status: 429 });
        return okResponse([{ function: { name: 'get_company', arguments: '{}' } }]);
      }
    });

    const calls = await selector.select('q', 's', []);
    expect(attempts).toBe(2);
    expect(calls[0]?.name).toBe('get_company');
  });

  it('does not retry a rejected key', async () => {
    let attempts = 0;
    const selector = openRouterSelector({
      apiKey: 'bad',
      sleep: async () => {},
      fetchImpl: async () => {
        attempts += 1;
        return new Response('no', { status: 401 });
      }
    });

    await expect(selector.select('q', 's', [])).rejects.toThrow(/401/);
    expect(attempts).toBe(1);
  });

  it('treats an error body on a 200 as a failure', async () => {
    // OpenRouter returns HTTP 200 with an error payload when an upstream
    // provider fails, so the status alone is not enough to trust the response.
    const selector = openRouterSelector({
      apiKey: 'test',
      maxRetries: 0,
      sleep: async () => {},
      fetchImpl: async () =>
        new Response(JSON.stringify({ error: { message: 'upstream is down' } }), { status: 200 })
    });

    await expect(selector.select('q', 's', [])).rejects.toThrow(/upstream is down/);
  });

  it('labels itself with the provider and model, so a result is attributable', () => {
    expect(openRouterSelector({ apiKey: 'x' }).label).toBe(`openrouter:${DEFAULT_MODEL.openrouter}`);
    expect(openRouterSelector({ apiKey: 'x', model: 'moonshotai/kimi-k2.6' }).label).toBe(
      'openrouter:moonshotai/kimi-k2.6'
    );
  });

  it('defaults to a model cheap enough that the eval actually gets run', () => {
    // An eval nobody runs because of the bill is an eval that is not doing
    // anything. GLM 5.2 is roughly four pence for a full pass.
    expect(DEFAULT_MODEL.openrouter).toBe('z-ai/glm-5.2');
  });

  it('does not default to a free tier', () => {
    // Free tiers queue and throttle. This eval reports an inconsistent result
    // as a finding about overlapping tool descriptions, so throttling would
    // manufacture exactly the noise it must not manufacture.
    expect(DEFAULT_MODEL.openrouter).not.toContain(':free');
  });
});

describe('resolveProvider', () => {
  it('prefers OpenRouter when both keys are present', () => {
    expect(
      resolveProvider({ env: { OPENROUTER_API_KEY: 'a', ANTHROPIC_API_KEY: 'b' } }).provider
    ).toBe('openrouter');
  });

  it('falls back to whichever key exists', () => {
    expect(resolveProvider({ env: { ANTHROPIC_API_KEY: 'b' } }).provider).toBe('anthropic');
    expect(resolveProvider({ env: { OPENROUTER_API_KEY: 'a' } }).provider).toBe('openrouter');
  });

  it('honours an explicit choice', () => {
    const env = { OPENROUTER_API_KEY: 'a', ANTHROPIC_API_KEY: 'b' };
    expect(resolveProvider({ provider: 'anthropic', env }).provider).toBe('anthropic');
    expect(resolveProvider({ provider: 'openrouter', env }).provider).toBe('openrouter');
  });

  it('refuses rather than silently using the other provider', () => {
    // A run that quietly measured a different model than the one you asked for
    // is worse than a run that failed.
    const result = resolveProvider({ provider: 'openrouter', env: { ANTHROPIC_API_KEY: 'b' } });
    expect(result.provider).toBeUndefined();
    expect(result.problem).toContain('OPENROUTER_API_KEY is not set');
  });

  it('reports when neither key is configured', () => {
    const result = resolveProvider({ env: {} });
    expect(result.provider).toBeUndefined();
    expect(result.problem).toContain('Neither');
  });

  it('ignores an empty key', () => {
    expect(resolveProvider({ env: { OPENROUTER_API_KEY: '' } }).provider).toBeUndefined();
  });
});
