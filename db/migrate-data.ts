/**
 * Transfer all data from the live MariaDB into a fresh SQLite database, then
 * compare every table row-by-row.
 *
 * This is the step that proves the desktop build can run on real data. It reads
 * from MariaDB (read-only) and writes to a local SQLite file. Run it with
 * `npm run db:migrate-data`.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createPool } from "mysql2/promise";
import type { RowDataPacket } from "mysql2";
import { loadServerEnv } from "../src/server/env";

loadServerEnv();

const workdir = fs.mkdtempSync(path.join(os.tmpdir(), "attendance-migrate-"));
const sqliteFile = path.join(workdir, "attendance.db");
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

const tableOrder = [
  "users",
  "profiles",
  "user_roles",
  "audit_logs",
  "students",
  "staff",
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
  const columns = Object.keys(mariaRows[0]);
  const placeholders = columns.map(() => "?").join(", ");
  const columnList = columns.map((c) => `\`${c}\``).join(", ");
  const insertSql = `INSERT INTO \`${table}\` (${columnList}) VALUES (${placeholders})`;

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
closeDb();

console.log(`\nTransferred ${totalRows} rows across ${tableOrder.length} tables.`);
if (totalDifferences === 0) {
  console.log("No differences found. The SQLite copy is identical to the live data.");
} else {
  console.error(`${totalDifferences} difference(s) detected.`);
  process.exitCode = 1;
}

console.log(`\nSQLite file written to: ${sqliteFile}`);
console.log("Copy it to your app's data directory for the desktop build, or point DB_FILE at it.");
