/**
 * Compare the live MariaDB schema with a freshly migrated SQLite one.
 *
 * The desktop build runs on SQLite while a hosted install runs on MariaDB, and
 * the same code has to work on both. That is only safe if the two schemas hold
 * the same things, so this checks what a transfer would otherwise quietly lose:
 *
 *   - every table, and every column in it
 *   - which columns may be null, and what they default to
 *   - primary keys, unique keys and the columns they cover
 *   - foreign keys, including what happens on delete
 *   - the allowed values of a column, whether MariaDB enforces them with an
 *     ENUM and SQLite with a CHECK
 *
 * It compares the rule, not the spelling. MariaDB says `status
 * ENUM('draft','finalized')` where SQLite says `CHECK (status IN ('draft',
 * 'finalized'))`; those are the same rule, and a diff of the SQL text would
 * report every one of them as a difference.
 *
 * Read-only: it reads MariaDB and builds a throwaway SQLite file, and writes
 * nothing to either. Run it with `npm run db:audit-schema`.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createPool } from "mysql2/promise";
import type { RowDataPacket } from "mysql2";
import { loadServerEnv } from "../src/server/env";

type Column = {
  name: string;
  nullable: boolean;
  type: string;
  /** Allowed values when MariaDB enforces the set with an ENUM. */
  enumValues: string[] | null;
  default: string | null;
  ordinal: number;
};
type Index = { name: string; unique: boolean; columns: string[] };
type ForeignKey = { from: string; table: string; to: string; onDelete: string };
type Table = {
  name: string;
  columns: Column[];
  indexes: Index[];
  foreignKeys: ForeignKey[];
  /** CHECK clauses that are not a plain `column IN (...)` list. */
  checks: string[];
};

const problems: string[] = [];
const notes: string[] = [];

function fail(message: string): void {
  problems.push(message);
}

/**
 * Put a declared default into a form both engines can be compared on.
 *
 * MariaDB reports an explicit `DEFAULT NULL` as the four-character string
 * "NULL", and SQLite has no such thing: a nullable column with no DEFAULT
 * clause already defaults to NULL. Comparing the raw text would call those a
 * difference, so both are folded to null here.
 */
function normaliseDefault(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  const text = String(value).trim();
  if (text === "" || text.toLowerCase() === "null") return null;
  return text
    .replace(/^'(.*)'$/s, "$1")
    .replace(/\(\d+\)/g, "")
    .toLowerCase();
}

/** Collapse whitespace and quoting so a clause can be compared across engines. */
function tidy(text: string): string {
  return text
    .replace(/\s+/g, " ")
    .replace(/[`"'[\]]/g, "")
    .trim()
    .toLowerCase();
}

/** The values out of an `ENUM('a','b')` type declaration. */
function enumValues(columnType: string): string[] | null {
  if (!/^enum\(/i.test(columnType)) return null;
  const inside = columnType.slice(columnType.indexOf("(") + 1, columnType.lastIndexOf(")"));
  return inside.split(",").map((value) => value.trim().replace(/^'(.*)'$/s, "$1"));
}

/**
 * The CHECK clauses in a SQLite CREATE TABLE body, split into the `column IN
 * (...)` form and everything else.
 */
function sqliteChecks(ddl: string): { lists: Map<string, string[]>; other: string[] } {
  const lists = new Map<string, string[]>();
  const other: string[] = [];
  const pattern = /CHECK\s*\(/gi;
  for (let match = pattern.exec(ddl); match; match = pattern.exec(ddl)) {
    const start = match.index + match[0].length;
    let depth = 1;
    let index = start;
    for (; index < ddl.length; index += 1) {
      const character = ddl[index];
      if (character === "(") depth += 1;
      else if (character === ")") {
        depth -= 1;
        if (depth === 0) break;
      }
    }
    const clause = tidy(ddl.slice(start, index));
    // Both engines pass a CHECK whose result is NULL, so `x IS NULL OR <rule>`
    // says the same thing as a bare `<rule>`. MariaDB relies on that and writes
    // the shorter form, so the prefix is dropped before the two are compared.
    const withoutNullGuard = clause.replace(/^\w+\s+is\s+null\s+or\s+/, "");
    const list = /^(\w+)\s+in\s*\((.*)\)$/.exec(withoutNullGuard);
    if (list) {
      lists.set(
        list[1],
        list[2]
          .split(",")
          .map((value) => value.trim())
          .filter(Boolean),
      );
    } else {
      other.push(withoutNullGuard);
    }
  }
  return { lists, other: other.sort() };
}

async function readMariaDb(): Promise<Map<string, Table>> {
  const pool = createPool({
    host: process.env["DB_HOST"] ?? "127.0.0.1",
    port: Number.parseInt(process.env["DB_PORT"] ?? "3306", 10),
    user: process.env["DB_USER"] ?? "root",
    password: process.env["DB_PASSWORD"] ?? "",
    database: process.env["DB_NAME"] ?? "attendance",
    connectTimeout: 10_000,
  });
  const tables = new Map<string, Table>();
  try {
    const columns = await pool.query<RowDataPacket[]>(
      `SELECT table_name, column_name, is_nullable, column_default, column_type, ordinal_position
         FROM information_schema.columns
        WHERE table_schema = DATABASE()
        ORDER BY table_name, ordinal_position`,
    );
    for (const row of columns[0]) {
      const name = row.table_name as string;
      const table = tables.get(name) ?? {
        name,
        columns: [],
        indexes: [],
        foreignKeys: [],
        checks: [],
      };
      const columnType = String(row.column_type);
      table.columns.push({
        name: row.column_name as string,
        nullable: (row.is_nullable as string) === "YES",
        type: columnType,
        enumValues: enumValues(columnType),
        default: normaliseDefault(row.column_default),
        ordinal: Number(row.ordinal_position),
      });
      tables.set(name, table);
    }

    // A unique key that is not the primary key still has to exist in SQLite, or
    // a re-upload of the same file would insert a second copy of a person.
    const indexes = await pool.query<RowDataPacket[]>(
      `SELECT table_name, index_name, non_unique, column_name
         FROM information_schema.statistics
        WHERE table_schema = DATABASE()
        ORDER BY table_name, index_name, seq_in_index`,
    );
    const grouped = new Map<string, Index>();
    for (const row of indexes[0]) {
      const key = `${String(row.table_name)} ${String(row.index_name)}`;
      const index = grouped.get(key) ?? {
        name: row.index_name as string,
        unique: Number(row.non_unique) === 0,
        columns: [],
      };
      index.columns.push(row.column_name as string);
      grouped.set(key, index);
    }
    for (const [key, index] of grouped) {
      const [tableName] = key.split(" ");
      tables.get(tableName)?.indexes.push(index);
    }

    // The delete rule matters as much as the link: MariaDB relies on ON DELETE
    // CASCADE to take an event's uploads, scans and department rows with it, and
    // on SET NULL to keep a row whose author was deleted.
    const foreignKeys = await pool.query<RowDataPacket[]>(
      `SELECT k.table_name, k.column_name, k.referenced_table_name, k.referenced_column_name,
              r.delete_rule
         FROM information_schema.key_column_usage k
         JOIN information_schema.referential_constraints r
           ON r.constraint_schema = k.constraint_schema
          AND r.constraint_name = k.constraint_name
        WHERE k.table_schema = DATABASE() AND k.referenced_table_name IS NOT NULL
        ORDER BY k.table_name, k.column_name`,
    );
    for (const row of foreignKeys[0]) {
      tables.get(row.table_name as string)?.foreignKeys.push({
        from: row.column_name as string,
        table: row.referenced_table_name as string,
        to: row.referenced_column_name as string,
        onDelete: String(row.delete_rule),
      });
    }

    const checks = await pool.query<RowDataPacket[]>(
      `SELECT tc.table_name, cc.check_clause
         FROM information_schema.check_constraints cc
         JOIN information_schema.table_constraints tc
           ON tc.constraint_schema = cc.constraint_schema
          AND tc.constraint_name = cc.constraint_name
        WHERE tc.table_schema = DATABASE() AND tc.constraint_type = 'CHECK'
        ORDER BY tc.table_name, cc.check_clause`,
    );
    for (const row of checks[0]) {
      tables.get(row.table_name as string)?.checks.push(tidy(String(row.check_clause)));
    }
    for (const table of tables.values()) table.checks.sort();
  } finally {
    await pool.end();
  }
  return tables;
}

/** The slice of the SQLite handle this script reads the schema through. */
type SqliteLike = {
  prepare: (sql: string) => { all: (...params: unknown[]) => unknown[] };
  pragma: (source: string) => unknown;
};

function readSqlite(db: SqliteLike): Map<string, Table> {
  const tables = new Map<string, Table>();
  const names = (
    db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'")
      .all() as Array<{ name: string }>
  ).map((row) => row.name);

  for (const name of names) {
    const table: Table = { name, columns: [], indexes: [], foreignKeys: [], checks: [] };

    const columns = db.pragma(`table_info("${name}")`) as Array<{
      name: string;
      notnull: number;
      dflt_value: string | null;
      type: string;
    }>;
    table.columns = columns.map((column, index) => ({
      name: column.name,
      nullable: column.notnull === 0,
      type: column.type,
      enumValues: null,
      default: normaliseDefault(column.dflt_value),
      ordinal: index,
    }));

    // The allowed values are inline in the DDL, so they have to be read out of
    // the stored CREATE TABLE rather than asked for by name.
    const ddl = (
      db
        .prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?")
        .all(name) as Array<{ sql: string | null }>
    )[0]?.sql;
    const { lists, other } = sqliteChecks(ddl ?? "");
    table.checks = other;
    for (const [column, values] of lists) {
      const found = table.columns.find((candidate) => candidate.name === column);
      if (found) found.enumValues = values;
      else table.checks.push(`${column} in (${values.join(",")})`);
    }

    const indexList = db.pragma(`index_list("${name}")`) as Array<{
      name: string;
      unique: number;
    }>;
    for (const entry of indexList) {
      const info = db.pragma(`index_info("${entry.name}")`) as Array<{ name: string | null }>;
      table.indexes.push({
        name: entry.name,
        unique: entry.unique === 1,
        columns: info.map((column) => column.name ?? ""),
      });
    }

    const foreignKeys = db.pragma(`foreign_key_list("${name}")`) as Array<{
      table: string;
      from: string;
      to: string | null;
      on_delete: string;
    }>;
    for (const key of foreignKeys) {
      table.foreignKeys.push({
        from: key.from,
        table: key.table,
        to: key.to ?? "",
        onDelete: key.on_delete,
      });
    }

    tables.set(name, table);
  }
  return tables;
}

loadServerEnv();

const workdir = fs.mkdtempSync(path.join(os.tmpdir(), "attendance-audit-"));
process.env["DB_DRIVER"] = "sqlite";
process.env["DB_FILE"] = path.join(workdir, "audit.db");

const [{ getDb, closeDb }, maria] = await Promise.all([import("../src/server/db"), readMariaDb()]);

let sqlite: Map<string, Table>;
try {
  sqlite = readSqlite(getDb() as unknown as SqliteLike);
} finally {
  await closeDb();
  fs.rmSync(workdir, { recursive: true, force: true });
}

const allTables = [...new Set([...maria.keys(), ...sqlite.keys()])].sort();
for (const name of allTables) {
  const left = maria.get(name);
  const right = sqlite.get(name);
  if (!left) {
    fail(`${name}: in SQLite but not in MariaDB`);
    continue;
  }
  if (!right) {
    fail(`${name}: in MariaDB but not in SQLite - its rows cannot be transferred`);
    continue;
  }

  const leftColumns = new Set(left.columns.map((column) => column.name));
  const rightColumns = new Set(right.columns.map((column) => column.name));
  for (const column of leftColumns) {
    if (!rightColumns.has(column)) fail(`${name}.${column}: column missing from SQLite`);
  }
  for (const column of rightColumns) {
    if (!leftColumns.has(column)) notes.push(`${name}.${column}: extra column in SQLite`);
  }

  for (const column of left.columns) {
    const other = right.columns.find((candidate) => candidate.name === column.name);
    if (!other) continue;
    if (column.nullable !== other.nullable) {
      fail(
        `${name}.${column.name}: nullability differs (MariaDB ${column.nullable ? "nullable" : "NOT NULL"}, SQLite ${other.nullable ? "nullable" : "NOT NULL"})`,
      );
    }
    // A different default is a real difference: an insert that leaves the column
    // out gets a different value, or fails outright on the stricter engine.
    if (column.default !== other.default) {
      fail(
        `${name}.${column.name}: default differs (MariaDB ${column.default ?? "none"}, SQLite ${other.default ?? "none"})`,
      );
    }
    // The same allowed values, enforced a different way, is parity. A set only
    // one engine knows about is a rule one of them will quietly not enforce.
    if (JSON.stringify(column.enumValues) !== JSON.stringify(other.enumValues)) {
      fail(
        `${name}.${column.name}: allowed values differ (MariaDB ${JSON.stringify(column.enumValues)}, SQLite ${JSON.stringify(other.enumValues)})`,
      );
    }
  }

  for (const check of left.checks) {
    if (!right.checks.includes(check)) {
      fail(`${name}: enforced in MariaDB but not in SQLite: ${check}`);
    }
  }
  for (const check of right.checks) {
    if (!left.checks.includes(check)) {
      fail(`${name}: enforced in SQLite but not in MariaDB: ${check}`);
    }
  }

  // The index names are allowed to differ, but the uniqueness is not: a unique
  // key that exists on only one side lets a re-upload duplicate a person there.
  const uniqueKeys = (indexes: Index[]) =>
    indexes
      .filter((index) => index.unique)
      .map((index) => [...index.columns].sort().join(","))
      .sort();
  const mariaUnique = uniqueKeys(left.indexes);
  const sqliteUnique = uniqueKeys(right.indexes);
  for (const key of mariaUnique) {
    if (!sqliteUnique.includes(key)) {
      fail(`${name}: unique key (${key}) in MariaDB but not in SQLite - duplicates could slip in`);
    }
  }
  for (const key of sqliteUnique) {
    if (!mariaUnique.includes(key)) notes.push(`${name}: unique key (${key}) only in SQLite`);
  }

  const foreignKeyText = (keys: ForeignKey[]) =>
    keys
      .map((key) => `${key.from}->${key.table}.${key.to}:${key.onDelete}`)
      .sort()
      .join("; ");
  if (foreignKeyText(left.foreignKeys) !== foreignKeyText(right.foreignKeys)) {
    fail(
      `${name}: foreign keys differ (MariaDB [${foreignKeyText(left.foreignKeys)}], SQLite [${foreignKeyText(right.foreignKeys)}])`,
    );
  }
}

const columns = [...maria.values()].reduce((total, table) => total + table.columns.length, 0);
console.log(`Compared ${allTables.length} tables and ${columns} MariaDB columns with SQLite.`);
if (notes.length > 0) {
  console.log(`\n${notes.length} difference(s) that do not lose data or a rule:`);
  for (const note of notes) console.log(`  - ${note}`);
}
if (problems.length > 0) {
  console.error(`\n${problems.length} problem(s) that would lose data or drop a rule:`);
  for (const problem of problems) console.error(`  - ${problem}`);
  process.exitCode = 1;
} else {
  console.log("\nParity: no difference that could lose data or drop a rule.");
}
