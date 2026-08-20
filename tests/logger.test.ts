import { describe, expect, it } from 'vitest';

import type { LogLevel } from '../src/telemetry/logger.js';
import { createLogger } from '../src/telemetry/logger.js';

const collect = (level: LogLevel = 'info') => {
  const lines: string[] = [];
  const logger = createLogger({
    level,
    write: (line) => lines.push(line),
    now: () => new Date('2026-08-20T09:00:00.000Z')
  });
  return { logger, lines, parsed: () => lines.map((line) => JSON.parse(line) as Record<string, unknown>) };
};

describe('createLogger', () => {
  it('writes one JSON object per line', () => {
    const { logger, parsed } = collect();
    logger.info('started', { port: 1234 });

    expect(parsed()).toEqual([
      { time: '2026-08-20T09:00:00.000Z', level: 'info', message: 'started', port: 1234 }
    ]);
  });

  it('drops records below the configured level', () => {
    const { logger, lines } = collect('warn');
    logger.debug('noisy');
    logger.info('also noisy');
    logger.warn('kept');
    logger.error('kept');

    expect(lines).toHaveLength(2);
  });

  it('merges child fields into every record', () => {
    const { logger, parsed } = collect();
    logger.child({ requestId: 'r-1' }).info('fetching', { path: '/company/1' });

    expect(parsed()[0]).toMatchObject({ requestId: 'r-1', path: '/company/1' });
  });

  it('serialises an Error rather than emitting an empty object', () => {
    const { logger, parsed } = collect();
    logger.error('failed', { error: new Error('boom') });

    const record = parsed()[0]?.['error'] as Record<string, unknown>;
    expect(record['message']).toBe('boom');
    expect(record['name']).toBe('Error');
  });

  it('survives a value that cannot be serialised', () => {
    // A log line must never be the reason a request fails.
    const { logger, parsed } = collect();
    const circular: Record<string, unknown> = {};
    circular['self'] = circular;

    expect(() => logger.info('circular', { circular })).not.toThrow();
    expect(parsed()[0]?.['message']).toBe('circular');
  });

  it('handles a bigint field', () => {
    const { logger, parsed } = collect();
    logger.info('big', { value: 10n });
    expect(parsed()[0]?.['value']).toBe('10');
  });
});
