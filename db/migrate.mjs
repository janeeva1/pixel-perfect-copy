// Creates the database (if missing) and applies db/schema.sql.
//
//   npm run db:migrate        create if missing, then apply schema
//   npm run db:reset          drop the database first, then apply schema
//
// Connection settings come from .env (see .env.example).

import { readFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { createConnection } from "mysql2/promise";

const rootDir = path.resolve(import.meta.dirname, "..");

try {
  process.loadEnvFile(path.join(rootDir, ".env"));
} catch {
  // .env is optional; the built-in defaults below match a stock XAMPP install.
}

const database = process.env["DB_NAME"] ?? "attendance";
if (!/^[A-Za-z0-9_]+$/.test(database)) {
  console.error(`Refusing to use an unsafe database name: ${database}`);
  process.exit(1);
}

const baseOptions = {
  host: process.env["DB_HOST"] ?? "127.0.0.1",
  port: Number.parseInt(process.env["DB_PORT"] ?? "3306", 10),
  user: process.env["DB_USER"] ?? "root",
  password: process.env["DB_PASSWORD"] ?? "",
};

const fresh = process.argv.includes("--fresh");
const bootstrap = await createConnection(baseOptions);
if (fresh) {
  await bootstrap.query(`DROP DATABASE IF EXISTS \`${database}\``);
  console.log(`dropped ${database}`);
}
await bootstrap.query(
  `CREATE DATABASE IF NOT EXISTS \`${database}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`,
);
await bootstrap.end();

const sql = await readFile(path.join(rootDir, "db", "schema.sql"), "utf8");
const statements = sql
  .split("\n")
  .filter((line) => !line.trimStart().startsWith("--"))
  .join("\n")
  .split(";")
  .map((statement) => statement.trim())
  .filter(Boolean);

const connection = await createConnection({ ...baseOptions, database });
let applied = 0;
try {
  for (const statement of statements) {
    await connection.query(statement);
    applied += 1;
  }

  // MariaDB has no `ADD CONSTRAINT IF NOT EXISTS`, and the statements above are
  // split on semicolons so a prepared statement cannot be used here either. A
  // table that already exists also skips its CREATE TABLE entirely, which means
  // a rule added to one would never reach an install that predates it. So the
  // rules that cannot be written idempotently in SQL are applied here, once,
  // after checking whether they are already there.
  //
  // Adding a constraint fails outright if a row already breaks it, so a row that
  // does is reported rather than deleted or corrected: which day it was meant to
  // be is a question for a person, not a guess.
  const constraints = [
    {
      table: "recurring_schedules",
      name: "recurring_schedules_day_of_week_chk",
      column: "day_of_week",
      sql: "ALTER TABLE recurring_schedules ADD CONSTRAINT recurring_schedules_day_of_week_chk CHECK (day_of_week BETWEEN 0 AND 6)",
      broken:
        "SELECT id, template_id, day_of_week FROM recurring_schedules WHERE day_of_week NOT BETWEEN 0 AND 6",
    },
  ];

  for (const constraint of constraints) {
    const [existing] = await connection.query(
      `SELECT COUNT(*) AS found FROM information_schema.check_constraints cc
         JOIN information_schema.table_constraints tc
           ON tc.constraint_schema = cc.constraint_schema
          AND tc.constraint_name = cc.constraint_name
        WHERE tc.table_schema = DATABASE() AND tc.table_name = ? AND cc.check_clause LIKE ?`,
      [constraint.table, `%${constraint.column}%`],
    );
    if (Number((existing[0] ?? {}).found) > 0) continue;

    const [offenders] = await connection.query(constraint.broken);
    if (offenders.length > 0) {
      console.error(
        `${constraint.table}: ${offenders.length} row(s) have a ${constraint.column} outside the allowed range, so ${constraint.name} was not added:`,
      );
      for (const row of offenders) console.error(`  ${JSON.stringify(row)}`);
      process.exitCode = 1;
      continue;
    }
    await connection.query(constraint.sql);
    console.log(`${constraint.table}: added ${constraint.name}`);
  }
} finally {
  await connection.end();
}

console.log(`${database}: applied ${applied} statement(s)`);
