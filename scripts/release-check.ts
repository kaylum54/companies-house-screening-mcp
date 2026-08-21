/**
 * Pre-publish checks that the test suite cannot make.
 *
 *   npm run release:check
 *
 * These are all about the *artefact* rather than the code: what ends up in the
 * tarball, whether the metadata npm provenance requires is present, and
 * whether the published entry point will actually start. Every one of them
 * corresponds to a way a package can be green in CI and broken on npm.
 *
 * Run automatically by `prepublishOnly`, so a publish cannot skip it.
 */

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = join(import.meta.dirname, '..');

interface Manifest {
  name?: string;
  version?: string;
  description?: string;
  license?: string;
  bin?: Record<string, string>;
  files?: string[];
  repository?: { type?: string; url?: string } | string;
  publishConfig?: { access?: string; provenance?: boolean };
}

interface PackedFile {
  path: string;
  size: number;
}

interface PackResult {
  name: string;
  version: string;
  files: PackedFile[];
  unpackedSize: number;
}

const failures: string[] = [];
const notes: string[] = [];

const check = (condition: boolean, failure: string): void => {
  if (!condition) failures.push(failure);
};

/** Prints what was found and sets the exit code. Called from every exit path. */
function report(): void {
  for (const note of notes) process.stdout.write(`  ${note}\n`);

  if (failures.length > 0) {
    process.stderr.write(
      `\nNot ready to publish:\n${failures.map((line) => `  - ${line}\n`).join('')}`
    );
    process.exitCode = 1;
    return;
  }

  process.stdout.write('  Release checks passed.\n');
}

function main(): void {
  const manifest = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) as Manifest;

  // --- metadata --------------------------------------------------------
  check(manifest.name !== undefined && manifest.name !== '', 'package.json has no name.');
  check(manifest.version !== undefined && manifest.version !== '0.0.0', 'package.json has no usable version.');
  check((manifest.description ?? '').length > 40, 'package.json needs a description; it is what npm search shows.');
  check(manifest.license === 'MIT', 'package.json license should be MIT, matching LICENSE.');

  // npm provenance is generated from the workflow but verified against this
  // field. A mismatch fails the publish rather than producing an unsigned
  // package, so getting it wrong is loud — but only at the last moment.
  check(
    manifest.repository !== undefined,
    'package.json has no `repository` field. npm provenance requires it and the publish will be rejected without it. Add:\n      "repository": { "type": "git", "url": "git+https://github.com/OWNER/REPO.git" }'
  );
  check(
    manifest.publishConfig?.access === 'public',
    'package.json needs publishConfig.access = "public".'
  );
  check(
    manifest.publishConfig?.provenance === true,
    'package.json needs publishConfig.provenance = true.'
  );

  // --- what actually goes in the tarball -------------------------------
  //
  // This runs before the entry-point checks because `npm pack` triggers
  // `prepack`, which is what builds dist. Looking for the entry point first
  // would report it missing on a clean checkout.
  //
  // Running npm from a script on Windows is fiddlier than it looks. `npm` is
  // `npm.cmd`, and Node refuses to spawn a `.cmd` without `shell: true` — a
  // deliberate restriction from the 2024 argument-injection fix. Turning the
  // shell on to get around that reintroduces exactly the hazard it was added
  // to prevent.
  //
  // Nested inside `npm publish`, `npm pack --dry-run --json` returns an empty
  // array rather than the tarball listing, so this check reports "returned
  // nothing" and fails a release that is otherwise fine. The release workflow
  // runs this script standalone in the verify job, which the publish job
  // depends on, so the guarantee is kept where it counts — this drops only the
  // second, nested copy of it.
  if (process.env['npm_command'] === 'publish') {
    notes.push('Skipping tarball inspection: nested `npm pack` inside a publish returns nothing.');
    notes.push('It ran standalone in the verify job; see .github/workflows/release.yml.');
    report();
    return;
  }

  // Running npm from a script on Windows is fiddlier than it looks. `npm` is
  // `npm.cmd`, and Node refuses to spawn a `.cmd` without `shell: true` — a
  // deliberate restriction from the 2024 argument-injection fix. Turning the
  // shell on to get around that reintroduces exactly the hazard it was added
  // to prevent.
  //
  // `npm_execpath` is set by npm itself when it runs a script, and points at
  // npm's JavaScript entry point, which the current Node can execute directly
  // with no shell anywhere. The fallback covers being run outside npm.
  const npmCli = process.env['npm_execpath'];
  const raw =
    npmCli !== undefined && npmCli.endsWith('.js')
      ? execFileSync(process.execPath, [npmCli, 'pack', '--dry-run', '--json'], {
          cwd: ROOT,
          encoding: 'utf8'
        })
      : execFileSync('npm', ['pack', '--dry-run', '--json'], {
          cwd: ROOT,
          encoding: 'utf8',
          shell: process.platform === 'win32'
        });

  const packed = JSON.parse(raw) as PackResult[];

  const result = packed[0];
  if (result === undefined) {
    failures.push('`npm pack --dry-run` returned nothing.');
  } else {
    const paths = result.files.map((file) => file.path);

    // A secret in a published tarball cannot be unpublished in any meaningful
    // sense — it is mirrored within seconds.
    for (const forbidden of ['.env', '.npmrc']) {
      check(
        !paths.some((path) => path === forbidden || path.endsWith(`/${forbidden}`)),
        `${forbidden} would be published in the tarball.`
      );
    }

    // Fixtures are recorded public-register data, and tests and evals are
    // development weight. None of it belongs in something people install.
    for (const prefix of ['tests/', 'evals/', 'scripts/', 'docs/', 'coverage/']) {
      check(
        !paths.some((path) => path.startsWith(prefix)),
        `${prefix} would be published in the tarball; tighten the "files" field.`
      );
    }

    check(paths.includes('README.md'), 'README.md is not in the tarball.');
    check(paths.includes('LICENSE'), 'LICENSE is not in the tarball.');
    check(
      paths.some((path) => path.startsWith('dist/')),
      'No dist/ files in the tarball.'
    );
    check(
      !paths.some((path) => path.endsWith('.map')),
      'Source maps are in the tarball; they roughly double its size and are rarely useful to a consumer.'
    );

    notes.push(
      `${result.name}@${result.version}: ${result.files.length} files, ${(result.unpackedSize / 1024).toFixed(0)} KB unpacked`
    );
  }

  // --- the built entry point -------------------------------------------
  const binPath = manifest.bin === undefined ? undefined : Object.values(manifest.bin)[0];
  check(binPath !== undefined, 'package.json declares no bin.');

  if (binPath !== undefined) {
    const resolved = join(ROOT, binPath);
    if (!existsSync(resolved)) {
      failures.push(`${binPath} does not exist. Run \`npm run build\` first.`);
    } else {
      const firstLine = readFileSync(resolved, 'utf8').split('\n')[0] ?? '';
      // Without this, `npx <package>` fails with an exec format error on every
      // platform that honours shebangs, and the cause is not obvious.
      check(firstLine.startsWith('#!'), `${binPath} has no shebang; npx would not be able to run it.`);
    }
  }

  check(existsSync(join(ROOT, 'LICENSE')), 'LICENSE is missing.');
  check(existsSync(join(ROOT, 'README.md')), 'README.md is missing.');

  report();
}

main();
