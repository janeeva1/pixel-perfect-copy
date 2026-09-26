import { existsSync } from "node:fs";
import { resolve } from "node:path";

let loaded = false;

/**
 * Loads `.env` into `process.env` for server code.
 *
 * Vite only injects `.env` values into `import.meta.env` during development, and
 * the built Nitro Node server reads no dotenv file at all, so both runtimes call
 * this before any configuration is read. Real environment variables win, which
 * keeps packaged desktop builds configurable without a `.env` file.
 */
export function loadServerEnv(): void {
  if (loaded) return;
  loaded = true;

  const envFile = resolve(process.cwd(), ".env");
  if (!existsSync(envFile)) return;

  process.loadEnvFile(envFile);
}
