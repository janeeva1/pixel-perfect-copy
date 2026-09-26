// A one-off helper to categorise the events that were already loaded when
// `event_category` was added, by guessing from the event's title.
//
//   npm run db:backfill-categories            list what it would change
//   npm run db:backfill-categories -- --apply write it
//
// It is a script rather than a line in db/schema.sql because a guess is not
// something a migration should re-apply on every run: 'other' is both the
// default and a real choice, so a migration guarded on `event_category = 'other'`
// cannot tell an uncategorised event from one somebody deliberately set back to
// Other, and would keep overriding the second. It also previews and waits, so
// the rows it is about to touch are read before they are written.
//
// This guesses. The category is meant to be set deliberately, because renaming
// an event must not move it between reports. Prefer the event's own edit form
// where there are only a handful of events; this is for the case where there
// are hundreds.
//
// Connection settings come from .env, as in db/migrate.mjs.

import path from "node:path";
import process from "node:process";
import { createConnection } from "mysql2/promise";

const rootDir = path.resolve(import.meta.dirname, "..");

try {
  process.loadEnvFile(path.join(rootDir, ".env"));
} catch {
  // .env is optional; the defaults below match a stock XAMPP install.
}

const apply = process.argv.includes("--apply");
const database = process.env["DB_NAME"] ?? "attendance";
if (!/^[A-Za-z0-9_]+$/.test(database)) {
  console.error(`Refusing to use an unsafe database name: ${database}`);
  process.exit(1);
}

const connection = await createConnection({
  host: process.env["DB_HOST"] ?? "127.0.0.1",
  port: Number.parseInt(process.env["DB_PORT"] ?? "3306", 10),
  user: process.env["DB_USER"] ?? "root",
  password: process.env["DB_PASSWORD"] ?? "",
  database,
});

// The same guess the migration used to make, kept in one place so what is
// previewed is exactly what would be written. 'MASSAGE' and 'Molecular Mass'
// match this and are not Community Masses, which is why the titles are printed
// rather than written blind.
const guess = "LOWER(title) LIKE '%mass%'";

const TABLES = [
  { name: "student_events", label: "student" },
  { name: "staff_events", label: "staff" },
];

try {
  let total = 0;
  for (const table of TABLES) {
    const [rows] = await connection.query(
      `SELECT id, title, event_date FROM \`${table.name}\`
       WHERE event_category = 'other' AND ${guess}
       ORDER BY event_date, title`,
    );
    const found = /** @type {{ id: string; title: string; event_date: string }[]} */ (rows);
    if (found.length === 0) {
      console.log(`${table.label}: nothing to categorise`);
      continue;
    }
    console.log(`\n${table.label}: ${found.length} event(s) whose title contains "mass"`);
    for (const row of found) {
      console.log(`  ${row.event_date}  ${row.title}`);
    }
    total += found.length;

    if (apply) {
      const [result] = await connection.query(
        `UPDATE \`${table.name}\` SET event_category = 'community_mass'
         WHERE event_category = 'other' AND ${guess}`,
      );
      const changed = /** @type { affectedRows?: number } */ (result).affectedRows ?? 0;
      console.log(`  -> set ${changed} to community_mass`);
    }
  }

  if (total === 0) {
    console.log("\nNothing to do.");
  } else if (apply) {
    console.log("\nDone. Check the event edit forms and correct any that are wrong.");
  } else {
    console.log(`\n${total} event(s) would be set to community_mass.`);
    console.log("Read the list above, then re-run with --apply to write it.");
  }
} finally {
  await connection.end();
}
