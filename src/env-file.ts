/**
 * Optional `.env` loading.
 *
 * Node's `process.loadEnvFile` has the two behaviours worth having: a variable
 * already set in the environment **wins** over the file, and a missing file
 * throws rather than failing quietly. Both are what you want — the shell
 * should always be able to override, and "I edited .env and nothing changed"
 * should not be a mystery.
 *
 * Deliberately *not* automatic in the server. When a host launches this over
 * stdio, the working directory is the host's, not yours; silently reading a
 * `.env` from wherever that happens to be is a way to load someone else's
 * credentials by accident. The server reads a `.env` only when `CH_ENV_FILE`
 * names one. Development entry points — the test config, the fixture recorder,
 * the eval runner — load the repository's own `.env` from a known path.
 */

export interface EnvFileResult {
  loaded: boolean;
  path: string;
  /** Set when the file existed but could not be read or parsed. */
  error?: string;
}

export function loadEnvFile(path: string): EnvFileResult {
  try {
    process.loadEnvFile(path);
    return { loaded: true, path };
  } catch (error) {
    const code = (error as NodeJS.ErrnoException | undefined)?.code;
    if (code === 'ENOENT') return { loaded: false, path };
    return {
      loaded: false,
      path,
      error: error instanceof Error ? error.message : String(error)
    };
  }
}
