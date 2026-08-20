/**
 * Structured logging for the server.
 *
 * Everything goes to stderr. This is not a style preference: when the server
 * runs over the stdio transport, stdout carries the JSON-RPC frames. A stray
 * `console.log` anywhere in the process writes into that stream and corrupts
 * the protocol, and the failure looks like a mysterious client-side parse
 * error rather than anything pointing at the log line that caused it.
 */

export const LOG_LEVELS = ['error', 'warn', 'info', 'debug'] as const;

export type LogLevel = (typeof LOG_LEVELS)[number];

const LEVEL_RANK: Record<LogLevel, number> = {
  error: 0,
  warn: 1,
  info: 2,
  debug: 3
};

export type LogFields = Record<string, unknown>;

export interface Logger {
  error(message: string, fields?: LogFields): void;
  warn(message: string, fields?: LogFields): void;
  info(message: string, fields?: LogFields): void;
  debug(message: string, fields?: LogFields): void;
  /** Returns a logger that merges `fields` into every record it writes. */
  child(fields: LogFields): Logger;
}

export interface LoggerOptions {
  level?: LogLevel;
  /** Injectable sink, for tests. Defaults to stderr. */
  write?: (line: string) => void;
  /** Injectable clock, for deterministic tests. */
  now?: () => Date;
  base?: LogFields;
}

const writeToStderr = (line: string): void => {
  process.stderr.write(`${line}\n`);
};

/**
 * Replaces values that JSON.stringify cannot represent usefully, so that a bad
 * log field can never throw inside a request path.
 */
const replacer = (_key: string, value: unknown): unknown => {
  if (typeof value === 'bigint') return value.toString();
  if (value instanceof Error) {
    return { name: value.name, message: value.message, stack: value.stack };
  }
  return value;
};

export function createLogger(options: LoggerOptions = {}): Logger {
  const level = options.level ?? 'info';
  const write = options.write ?? writeToStderr;
  const now = options.now ?? (() => new Date());
  const base = options.base ?? {};
  const threshold = LEVEL_RANK[level];

  const emit = (recordLevel: LogLevel, message: string, fields?: LogFields): void => {
    if (LEVEL_RANK[recordLevel] > threshold) return;
    const record = {
      time: now().toISOString(),
      level: recordLevel,
      message,
      ...base,
      ...fields
    };
    try {
      write(JSON.stringify(record, replacer));
    } catch {
      // A log record must never be the reason a request fails. Fall back to
      // the bare message and drop the fields.
      write(JSON.stringify({ time: now().toISOString(), level: recordLevel, message }));
    }
  };

  const logger: Logger = {
    error: (message, fields) => emit('error', message, fields),
    warn: (message, fields) => emit('warn', message, fields),
    info: (message, fields) => emit('info', message, fields),
    debug: (message, fields) => emit('debug', message, fields),
    child: (fields) => createLogger({ ...options, base: { ...base, ...fields } })
  };

  return logger;
}

/** A logger that discards everything. Useful as a default in library code. */
export const silentLogger: Logger = {
  error: () => {},
  warn: () => {},
  info: () => {},
  debug: () => {},
  child: () => silentLogger
};
