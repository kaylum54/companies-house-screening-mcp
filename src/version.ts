import { createRequire } from 'node:module';

/**
 * Reads the version from package.json at runtime.
 *
 * A hardcoded constant here would drift from the published version the first
 * time someone ran `npm version patch`, and the value is reported to every
 * connecting host during initialisation — a wrong one is misleading in exactly
 * the situation where you are trying to work out which build is running.
 *
 * The relative path resolves to the package root from both `src/` and `dist/`.
 */
export function packageVersion(): string {
  try {
    const require = createRequire(import.meta.url);
    const manifest = require('../package.json') as { version?: unknown };
    return typeof manifest.version === 'string' ? manifest.version : '0.0.0';
  } catch {
    return '0.0.0';
  }
}
