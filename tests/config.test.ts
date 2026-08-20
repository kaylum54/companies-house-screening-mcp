import { describe, expect, it } from 'vitest';

import { ConfigError, defaultCacheDir, loadConfig, redactConfig } from '../src/config.js';

const base = { COMPANIES_HOUSE_API_KEY: 'abc123' } satisfies NodeJS.ProcessEnv;

describe('loadConfig', () => {
  it('needs only an API key', () => {
    const config = loadConfig({ ...base, CH_CACHE_DIR: '/tmp/x' });
    expect(config.apiKey).toBe('abc123');
    expect(config.baseUrl).toBe('https://api.company-information.service.gov.uk');
    expect(config.rateLimit).toBe(600);
    expect(config.rateWindowMs).toBe(300_000);
    expect(config.timeoutMs).toBe(10_000);
    expect(config.logLevel).toBe('info');
  });

  it('reports every problem at once', () => {
    // Handing back one missing variable per restart is a poor way to treat
    // somebody setting this up for the first time.
    try {
      loadConfig({ CH_CACHE_DIR: '/tmp/x', CH_RATE_LIMIT: 'lots', CH_LOG_LEVEL: 'shouty' });
      expect.unreachable('should have thrown');
    } catch (error) {
      expect(error).toBeInstanceOf(ConfigError);
      expect((error as ConfigError).issues.length).toBeGreaterThanOrEqual(3);
    }
  });

  it('names the missing key in plain terms', () => {
    try {
      loadConfig({ CH_CACHE_DIR: '/tmp/x' });
      expect.unreachable('should have thrown');
    } catch (error) {
      expect((error as ConfigError).message).toContain('COMPANIES_HOUSE_API_KEY is required');
    }
  });

  it('coerces numeric strings from the environment', () => {
    const config = loadConfig({ ...base, CH_CACHE_DIR: '/tmp/x', CH_RATE_LIMIT: '120', CH_TIMEOUT_MS: '2500' });
    expect(config.rateLimit).toBe(120);
    expect(config.timeoutMs).toBe(2500);
  });

  it.each(['false', '0', 'no', 'off'])('treats CH_CACHE_ENABLED=%s as off', (value) => {
    expect(loadConfig({ ...base, CH_CACHE_DIR: '/tmp/x', CH_CACHE_ENABLED: value }).cacheEnabled).toBe(false);
  });

  it.each(['true', '1', 'yes'])('treats CH_CACHE_ENABLED=%s as on', (value) => {
    expect(loadConfig({ ...base, CH_CACHE_DIR: '/tmp/x', CH_CACHE_ENABLED: value }).cacheEnabled).toBe(true);
  });

  it('rejects a rate limit of zero', () => {
    expect(() => loadConfig({ ...base, CH_CACHE_DIR: '/tmp/x', CH_RATE_LIMIT: '0' })).toThrow(ConfigError);
  });

  it('rejects a safety margin above one', () => {
    expect(() => loadConfig({ ...base, CH_CACHE_DIR: '/tmp/x', CH_RATE_SAFETY_MARGIN: '1.5' })).toThrow(
      ConfigError
    );
  });

  it('rejects a base URL that is not a URL', () => {
    expect(() => loadConfig({ ...base, CH_CACHE_DIR: '/tmp/x', CH_API_BASE_URL: 'not-a-url' })).toThrow(
      ConfigError
    );
  });
});

describe('defaultCacheDir', () => {
  it('prefers an explicit setting', () => {
    expect(defaultCacheDir({ CH_CACHE_DIR: '/custom' })).toBe('/custom');
  });

  it('honours XDG_CACHE_HOME', () => {
    expect(defaultCacheDir({ XDG_CACHE_HOME: '/xdg' })).toContain('companies-house-mcp');
  });

  it('ignores an empty setting rather than using an empty path', () => {
    expect(defaultCacheDir({ CH_CACHE_DIR: '   ' })).not.toBe('   ');
  });

  it('never returns the working directory', () => {
    // A server launched by a host should not scatter files wherever that host
    // happened to be started from.
    expect(defaultCacheDir({})).not.toBe(process.cwd());
  });
});

describe('redactConfig', () => {
  it('never emits the full API key', () => {
    const config = loadConfig({ ...base, CH_CACHE_DIR: '/tmp/x' });
    const redacted = redactConfig(config);
    expect(JSON.stringify(redacted)).not.toContain('abc123');
    expect(redacted['apiKey']).toContain('redacted');
  });

  it('keeps the rest of the configuration readable', () => {
    const config = loadConfig({ ...base, CH_CACHE_DIR: '/tmp/x' });
    expect(redactConfig(config)['rateLimit']).toBe(600);
  });
});
