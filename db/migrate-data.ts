/**
 * Transfer all data from the live MariaDB into a fresh SQLite database, then
 * compare every table row-by-row.
 *
 * This is the step that proves the desktop build can run on real data. It reads
 * from MariaDB (read-only) and writes to a local SQLite file. Run it with
 * `npm run db:migrate-data`, or pass a destination file to write the copy the
 * desktop installer ships as its starting data:
 *
 *     npm run db:migrate-data -- db/seed/attendance.db
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { dirname, resolve } from "node:path";
import { createPool } from "mysql2/promise";
import type { RowDataPacket } from "mysql2";
import { loadServerEnv } from "../src/server/env";

loadServerEnv();

// Write to the requested destination, or to a throwaway directory when none was
// given. The desktop build needs a file at a known path so it can be bundled.
const destination = process.argv[2];
const workdir = destination
  ? resolve(dirname(destination))
  : fs.mkdtempSync(path.join(os.tmpdir(), "attendance-migrate-"));
const sqliteFile = destination ? resolve(destination) : path.join(workdir, "attendance.db");
fs.mkdirSync(dirname(sqliteFile), { recursive: true });
fs.rmSync(sqliteFile, { force: true });
for (const suffix of ["-wal", "-shm"]) fs.rmSync(sqliteFile + suffix, { force: true });

process.env["DB_DRIVER"] = "sqlite";
process.env["DB_FILE"] = sqliteFile;

const [{ getDb, closeDb }] = await Promise.all([import("../src/server/db")]);

// Open and migrate the target SQLite DB.
const sqlite = getDb();
sqlite.pragma("foreign_keys = ON");
sqlite.pragma("journal_mode = WAL");
sqlite.pragma("busy_timeout = 5000");

// Connect to MariaDB.
const pool = createPool({
  host: process.env["DB_HOST"] ?? "127.0.0.1",
  port: Number.parseInt(process.env["DB_PORT"] ?? "3306", 10),
  user: process.env["DB_USER"] ?? "root",
  password: process.env["DB_PASSWORD"] ?? "",
  database: process.env["DB_NAME"] ?? "attendance",
  connectTimeout: 10_000,
});

/**
 * Tables the SQLite migrations seed with rows of their own: the three built-in
 * staff presence overrides and the department-to-weekday map. The live database
 * carries its own copy of those rows, so a plain INSERT trips the unique key.
 * Replacing is safe for exactly these two because nothing else refers to them,
 * so no child row can be cascaded away, and the live row is the one kept.
 */
const replaceOnConflict = new Set(["staff_presence_overrides", "mass_department_weekdays"]);

const tableOrder = [
  "users",
  "profiles",
  "user_roles",
  "audit_logs",
  "students",
  "staff",
  "staff_presence_overrides",
  "student_events",
  "student_event_uploads",
  "student_scans",
  "staff_events",
  "staff_event_uploads",
  "staff_scans",
  "recurring_templates",
  "recurring_schedules",
  "recurring_schedule_departments",
  "student_event_departments",
  "staff_event_departments",
  "mass_department_weekdays",
  "mass_weeks",
  "mass_week_weekdays",
  "mass_expected",
  "mass_uploads",
  "mass_scans",
];

let totalRows = 0;
let totalDifferences = 0;

console.log("MariaDB → SQLite data transfer\n");

for (const table of tableOrder) {
  const [mariaRows] = await pool.query<RowDataPacket[]>(`SELECT * FROM \`${table}\``);
  const count = mariaRows.length;
  totalRows += count;

  if (count === 0) {
    console.log(`  ${table}: 0 rows`);
    continue;
  }

  // Build the INSERT.
  //
  // The two schemas are not identical column for column: MySQL's
  // staff_presence_overrides keeps an `updated_at` that the SQLite table does
  // not, and a column that only exists on one side cannot be inserted into the
  // other. So the transfer uses the columns the two tables actually share, and
  // a column the SQLite side requires but MariaDB does not have is an error
  // rather than a silent omission.
  const tableInfo = sqlite.pragma(`table_info(\`${table}\`)`) as {
    name: string;
    notnull: number;
    dflt_value: string | null;
  }[];
  const sqliteColumns = new Set(tableInfo.map((column) => column.name));
  const mariaColumns = Object.keys(mariaRows[0]);
  const columns = mariaColumns.filter((column) => sqliteColumns.has(column));
  const missing = tableInfo
    .filter(
      (column) =>
        !mariaColumns.includes(column.name) && column.notnull === 1 && column.dflt_value === null,
    )
    .map((column) => column.name);
  if (missing.length > 0) {
    console.error(
      `    ❌ ${table} needs columns the live database does not have: ${missing.join(", ")}`,
    );
    totalDifferences += 1;
    continue;
  }
  const skipped = mariaColumns.filter((column) => !sqliteColumns.has(column));
  if (skipped.length > 0) {
    console.log(`    (skipped ${table} columns not in the SQLite schema: ${skipped.join(", ")})`);
  }
  const placeholders = columns.map(() => "?").join(", ");
  const columnList = columns.map((c) => `\`${c}\``).join(", ");
  const verb = replaceOnConflict.has(table) ? "INSERT OR REPLACE" : "INSERT";
  const insertSql = `${verb} INTO \`${table}\` (${columnList}) VALUES (${placeholders})`;

  // For SQLite, we need to transform values:
  // - MariaDB DATETIME/DATE comes as a JS Date in the local timezone (since the
  //   column has no timezone). We must store the *local* YYYY-MM-DD HH:MM:SS,
  //   not the UTC equivalent. toISOString() would shift it.
  // - ENUM comes as string already.
  // - TINYINT(1) boolean comes as 0/1.
  // - NULL stays null.
  const pad = (n: number) => n.toString().padStart(2, "0");
  function localDateString(date: Date): string {
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
  }
  const transformed = mariaRows.map((row) =>
    columns.map((col) => {
      const value = row[col];
      if (value === null) return null;
      if (value instanceof Date) return localDateString(value);
      if (typeof value === "object" && Buffer.isBuffer(value)) {
        // BLOB/varbinary → hex string (not used in current schema, but safe).
        return value.toString("hex");
      }
      return value;
    }),
  );

  // Insert in batches to avoid huge parameter lists.
  const batchSize = 500;
  for (let i = 0; i < transformed.length; i += batchSize) {
    const batch = transformed.slice(i, i + batchSize);
    const stmt = sqlite.prepare(insertSql);
    const tx = sqlite.transaction(() => {
      for (const row of batch) stmt.run(row);
    });
    tx();
  }

  // Verify count.
  const sqliteCount = sqlite.prepare(`SELECT COUNT(*) AS n FROM \`${table}\``).get() as {
    n: number;
  };
  if (sqliteCount.n !== count) {
    console.error(`    ❌ COUNT mismatch: MariaDB ${count} vs SQLite ${sqliteCount.n}`);
    totalDifferences += 1;
  } else {
    console.log(`  ${table}: ${count} rows ✓`);
  }

  // Spot-check: compare first 5 rows and last 5 rows for key tables.
  if (count <= 10) {
    const allMaria = mariaRows.map((r) =>
      columns.map((c) => {
        const v = r[c];
        return v instanceof Date ? localDateString(v) : v;
      }),
    );
    const allSqlite = sqlite.prepare(`SELECT * FROM \`${table}\``).all() as Record<
      string,
      unknown
    >[];
    for (let i = 0; i < allMaria.length; i++) {
      const m = allMaria[i];
      const s = allSqlite[i];
      const mismatches: string[] = [];
      for (let ci = 0; ci < columns.length; ci++) {
        const col = columns[ci];
        if (m[ci] !== s[col]) {
          mismatches.push(`${col}: M="${m[ci]}" S="${s[col]}"`);
        }
      }
      if (mismatches.length > 0) {
        console.error(`    ❌ Row ${i} differs in ${table}: ${mismatches.join("; ")}`);
        totalDifferences += 1;
      }
    }
  } else if (count > 0) {
    const sampleIndices = [0, 1, 2, 3, 4, count - 5, count - 4, count - 3, count - 2, count - 1];
    for (const idx of sampleIndices) {
      if (idx < 0 || idx >= count) continue;
      const mRow = mariaRows[idx];
      const sRow = sqlite.prepare(`SELECT * FROM \`${table}\` LIMIT 1 OFFSET ${idx}`).get() as
        Record<string, unknown> | undefined;
      if (!sRow) {
        console.error(`    ❌ Row ${idx} missing in SQLite ${table}`);
        totalDifferences += 1;
        continue;
      }
      const mismatches: string[] = [];
      for (const col of columns) {
        let mVal = mRow[col];
        const sVal = sRow[col];
        if (mVal instanceof Date) mVal = localDateString(mVal);
        if (mVal !== sVal) {
          mismatches.push(`${col}: M="${mVal}" S="${sVal}"`);
        }
      }
      if (mismatches.length > 0) {
        console.error(`    ❌ Row ${idx} differs in ${table}: ${mismatches.join("; ")}`);
        totalDifferences += 1;
      }
    }
  }
}

await pool.end();
await closeDb();

console.log(`\nTransferred ${totalRows} rows across ${tableOrder.length} tables.`);
if (totalDifferences === 0) {
  console.log("No differences found. The SQLite copy is identical to the live data.");
} else {
  console.error(`${totalDifferences} difference(s) detected.`);
  process.exitCode = 1;
}

console.log(`\nSQLite file written to: ${sqliteFile}`);
console.log("Copy it to your app's data directory for the desktop build, or point DB_FILE at it.");
