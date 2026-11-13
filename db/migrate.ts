/**
 * Bring the database up to date, for whichever engine is configured.
 *
 *   npm run db:migrate          apply anything outstanding
 *   npm run db:reset            start the SQLite file again (destroys its data)
 *
 * SQLite is the default and has numbered migrations in `db/migrations`.
 * `migrate()` also runs automatically the first time the app opens a SQLite
 * database, so an installed copy needs no setup step; this script is for
 * development and for the `--fresh` case.
 *
 * MySQL is opt-in with `DB_DRIVER=mysql`. It has its schema in `db/schema.sql`,
 * applied by `db/migrate.mjs`. That file is idempotent: every statement in it is
 * `IF NOT EXISTS`.
 *
 * `--sqlite` forces the SQLite file regardless of DB_DRIVER, which is how
 * `db:reset` stays a safe "throw away the local file" command on every platform
 * without needing cross-env to set a variable.
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";

try {
  process.loadEnvFile(path.resolve(process.cwd(), ".env"));
} catch {
  // .env is optional; db/migrate.mjs has its own defaults.
}

const fresh = process.argv.includes("--fresh");
const sqlite =
  process.argv.includes("--sqlite") ||
  (process.env["DB_DRIVER"] ?? "sqlite").toLowerCase() !== "mysql";

if (!sqlite) {
  // `--fresh` drops the database. That is a reasonable thing to ask for a
  // throwaway SQLite file and an unacceptable thing to do to the MariaDB
  // install that holds the accounts, the master lists and the attendance
  // history, so it is refused rather than offered.
  if (fresh) {
    console.error(
      "Refusing to run db:reset against MySQL: it would DROP the database named in " +
        "DB_NAME, along with every account, master list and event in it.\n" +
        "To rebuild the SQLite file instead, run this with DB_DRIVER=sqlite.",
    );
    process.exit(1);
  }
  const result = spawnSync(process.execPath, [path.resolve(process.cwd(), "db", "migrate.mjs")], {
    stdio: "inherit",
  });
  process.exit(result.status ?? 1);
}

// The file location is read from DB_FILE, which db.ts also reads. Setting it
// here rather than in db.ts keeps one source of truth for where the data lives.
const file = path.resolve(
  process.env["DB_FILE"] ?? path.join(process.cwd(), "db", "attendance.db"),
);

if (fresh && fs.existsSync(file)) {
  for (const suffix of ["", "-wal", "-shm"]) {
    fs.rmSync(`${file}${suffix}`, { force: true });
  }
  console.log(`removed ${file}`);
}

const { closeDb, migrate } = await import("../src/server/db");
const result = migrate();

if (result.applied.length === 0) {
  console.log(`${file} is already at version ${result.version}; nothing to do.`);
} else {
  console.log(`${file}: applied ${result.applied.join(", ")} (now version ${result.version})`);
}

// Close before the process exits so WAL contents are checkpointed into the
// database file rather than left in a sidecar that a copy might miss.
await closeDb();
