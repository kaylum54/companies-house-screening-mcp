import Anthropic from '@anthropic-ai/sdk';

import type { ToolCall } from './score.js';

/**
 * The model half of the eval, behind an interface.
 *
 * Everything expensive and non-deterministic is on the other side of
 * `Selector`. Tests inject a scripted one; the runner injects a real model.
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
 * being tested — "prefer company_snapshot", "never guess a number" and the
 * rest either change behaviour here or they are decoration.
 */
export function anthropicSelector(options: AnthropicSelectorOptions = {}): Selector {
  const model = options.model ?? 'claude-opus-5';
  const client = options.client ?? new Anthropic();
  const maxTokens = options.maxTokens ?? 16000;

  return {
    label: model,
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

/** A selector driven by a lookup table. Used by the tests. */
export function scriptedSelector(script: Record<string, ToolCall[]>): Selector {
  return {
    label: 'scripted',
    select: async (question) => script[question] ?? []
  };
}
