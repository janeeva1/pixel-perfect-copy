import { existsSync } from "node:fs";
import { resolve } from "node:path";

let loaded = false;

/**
 * True for the variables that name the shared sync hub. They are the only keys a
 * desktop `.env` is allowed to contribute, so pointing a packaged install at a hub
 * can never disturb the local database it was launched with.
 */
function isSyncKey(name: string): boolean {
  return name.startsWith("SYNC_DB_");
}

/**
 * Loads the sync-only environment file, if one was named.
 *
 * The desktop app ships no `.env` and must never fall back to MariaDB, so
 * `loadServerEnv` stops early once the launcher has chosen SQLite. That left the
 * hub connection with no supported way to be configured at all, which is why the
 * launcher points `SYNC_ENV_FILE` at a file in the user data directory and this
 * reads it.
 *
 * Node's own parser is used for the parsing, then anything it added that is not a
 * `SYNC_DB_*` name is put back the way it was. The local `DB_DRIVER`, `DB_FILE` and
 * `SESSION_SECRET` therefore cannot be overridden from that file even by accident.
 */
function loadSyncEnv(): void {
  const envFile = process.env["SYNC_ENV_FILE"];
  if (!envFile || !existsSync(envFile)) return;

  const before = new Map<string, string | undefined>();
  for (const name of Object.keys(process.env)) before.set(name, process.env[name]);

  try {
    process.loadEnvFile(envFile);
  } catch {
    return; // An unreadable or malformed file leaves the hub unconfigured.
  }

  for (const name of Object.keys(process.env)) {
    if (isSyncKey(name)) continue;
    const original = before.get(name);
    if (original === undefined) delete process.env[name];
    else process.env[name] = original;
  }
}

/**
 * Loads `.env` into `process.env` for server code.
 *
 * Vite only injects `.env` values into `import.meta.env` during development, and
 * the built Nitro Node server reads no dotenv file at all, so both runtimes call
 * this before any configuration is read. Real environment variables win, which
 * keeps the hosted app configurable without any code change.
 *
 * The desktop app is the exception. It sets its own database configuration in
 * the launcher before the server bundle is imported, ships no `.env`, and must
 * never fall back to MariaDB — so once the launcher has chosen SQLite, this
 * becomes a no-op. `SKIP_DOTENV` is the same switch for the case where the
 * launcher did not set it. Either way the sync-only file is read first, because
 * the hub is shared with machines that are not this one.
 */
export function loadServerEnv(): void {
  if (loaded) return;
  loaded = true;

  loadSyncEnv();

  if (process.env["SKIP_DOTENV"] === "1") return;
  if (process.env["DB_DRIVER"]?.toLowerCase() === "sqlite") return;

  const envFile = resolve(process.cwd(), ".env");
  if (!existsSync(envFile)) return;

  process.loadEnvFile(envFile);
}
