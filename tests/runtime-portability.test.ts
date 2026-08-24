import { readdir, readFile } from 'node:fs/promises';
import { join, relative } from 'node:path';

import { describe, expect, it } from 'vitest';

/**
 * The portable-core rule, enforced rather than remembered.
 *
 * This server runs on Node over stdio, on Node over HTTP, and on Cloudflare
 * Workers. Workers have no filesystem and no `node:os`, so a single stray
 * `import { readFile } from 'node:fs/promises'` in the shared code is enough
 * to break the Worker build — and it breaks it at deploy time, in a way that
 * unit tests running under Node would never notice.
 *
 * So the rule is: anything under `src/node/` may reach for Node built-ins.
 * Nothing else may, with the single audited exception below. See ADR 14.
 */

const SRC = new URL('../src/', import.meta.url).pathname;

/**
 * Only `src/node/` may reach for Node built-ins. `src/cloudflare/` is held to
 * the same rule as the portable core, because a Worker cannot use them either
 * — exempting it would defeat the point of having the rule.
 */
const RUNTIME_SPECIFIC = ['node/'];

/**
 * `node:crypto`'s `createHash` is the one exception, used for cache keys.
 * Cloudflare implements it under the `nodejs_compat` flag, which the Worker
 * config sets. It is listed here explicitly so that adding a second exception
 * is a decision somebody makes on purpose rather than a line that slips in.
 */
const ALLOWED_CORE_IMPORTS = new Set(['node:crypto']);

async function tsFiles(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const out: string[] = [];
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...(await tsFiles(full)));
    else if (entry.name.endsWith('.ts')) out.push(full);
  }
  return out;
}

describe('runtime portability', () => {
  it('keeps Node built-ins out of the portable core', async () => {
    const files = await tsFiles(SRC);
    expect(files.length).toBeGreaterThan(10);

    const offenders: string[] = [];

    for (const file of files) {
      const rel = relative(SRC, file);
      if (RUNTIME_SPECIFIC.some((prefix) => rel.startsWith(prefix))) continue;

      const source = await readFile(file, 'utf8');
      // Import statements only. A `node:fs` mentioned in a comment explaining
      // why it is absent is not a violation.
      for (const match of source.matchAll(/^\s*import\s[^;]*?from\s+'(node:[^']+)'/gm)) {
        const specifier = match[1] as string;
        if (!ALLOWED_CORE_IMPORTS.has(specifier)) {
          offenders.push(`${rel} imports ${specifier}`);
        }
      }
    }

    expect(offenders).toEqual([]);
  });

  it('keeps the runtime-specific directories out of the shared server', async () => {
    // `server.ts` builds the McpServer and registers tools. If it ever learns
    // which runtime it is on, every entry point stops being interchangeable
    // and the transport work in ADR 12 quietly comes undone.
    const server = await readFile(join(SRC, 'server.ts'), 'utf8');
    expect(server).not.toMatch(/from '\.\/(node|cloudflare)\//);
    expect(server).not.toMatch(/Transport/);
  });

  it('keeps the Worker free of Node built-ins beyond the audited exception', async () => {
    // Covered by the sweep above, asserted separately so a future decision to
    // exempt `src/cloudflare/` has to argue with a test named after the reason.
    const files = await tsFiles(join(SRC, 'cloudflare'));
    expect(files.length).toBeGreaterThan(0);

    for (const file of files) {
      const source = await readFile(file, 'utf8');
      for (const match of source.matchAll(/^\s*import\s[^;]*?from\s+'(node:[^']+)'/gm)) {
        expect(ALLOWED_CORE_IMPORTS).toContain(match[1]);
      }
    }
  });
});
