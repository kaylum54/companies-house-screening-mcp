import { homedir } from 'node:os';
import { join } from 'node:path';

/**
 * Picks a cache directory that respects platform convention, so the server
 * does not scatter files into the working directory of whatever host launched
 * it.
 *
 * This lives under `src/node/` rather than in `config.ts` because `node:os`
 * does not exist on Workers, and configuration is parsed on every runtime this
 * server targets. Resolving a filesystem path is the job of the entry point
 * that actually has a filesystem — see ADR 14.
 */
export function defaultCacheDir(env: NodeJS.ProcessEnv = process.env): string {
  const explicit = env['CH_CACHE_DIR'];
  if (explicit !== undefined && explicit.trim() !== '') return explicit;

  const xdg = env['XDG_CACHE_HOME'];
  if (xdg !== undefined && xdg.trim() !== '') return join(xdg, 'companies-house-screening-mcp');

  if (process.platform === 'win32') {
    const localAppData = env['LOCALAPPDATA'];
    if (localAppData !== undefined && localAppData.trim() !== '') {
      return join(localAppData, 'companies-house-screening-mcp', 'cache');
    }
  }

  return join(homedir(), '.cache', 'companies-house-screening-mcp');
}
