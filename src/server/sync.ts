// Offline-first hub synchronization.
//
// Every installed copy of the desktop app has its own SQLite file and works
// fully offline. When an operator clicks Synchronize, this module talks to the
// shared MariaDB instance the office already runs, which is used *only* as a
// rendezvous: neither side is read live from the other, each machine pushes
// what it has and pulls what it lacks, and then both carry on working offline.
//
// Rules, kept deliberately small:
//
//   * Last write wins. Replaceable rows carry an `updated_at`
//     (db/migrations/003_sync_metadata.sql + the write paths it feeds), and the
//     row whose stamp is newer wins. Equal stamps mean nobody edited since they
//     last agreed, so nothing moves.
//   * Scans and uploads are append-only, keyed by a globally unique uuid. Two
//     machines can never collide on one of those ids, so they merge by missing
//     id without looking at stamps.
//   * Recurring templates travel. student_events carries `template_id` and
//     `schedule_id`, so leaving the templates behind left the hub pointing at
//     rows nobody there had.
//   * It is a manual, whole-database action. There is no live subscription: a
//     machine offline all day when a volunteer adds a Mass simply picks it up
//     the next time someone clicks Synchronize.
//   * Deletes do not travel in this version. Removing an event or a user is a
//     decision about one machine's history and is left to each machine. The
//     shared record is the sum of what everyone added, not a tombstone ledger.
//
// `updated_at` is written explicitly by the same code that edits a row, in the
// same UTC text format, so the two engines compare equal strings. The hub's
// DATETIME(3) columns are read with `dateStrings: true` for the same reason:
// see hubPool() below.
//
// Two situations cannot be resolved by comparing stamps, and both are counted and
// reported rather than decided silently. See `pushTable` and `pullTable`:
//
//   * A row and its neighbour hold the same stamp but different content. Neither
//     side is provably newer, so both keep what they have. This used to be
//     asymmetric — push kept the hub, pull overwrote local with the hub — which
//     meant an edit could be silently dropped.
//   * The same person arrives under two different ids, because they were created
//     independently on two machines. The id is never rewritten to paper over
//     this: `staff_scans.staff_id` and `student_scans.student_id` point at it,
//     and moving it would orphan every one of those rows. It is reported and a
//     person fixes it in the master list, which is the only place it can be
//     fixed correctly.

import { randomUUID } from "node:crypto";
import { createPool, type Pool, type RowDataPacket } from "mysql2/promise";
import type { SqlParam } from "@/server/db";
import { dialect, query } from "@/server/db";
import { HttpError } from "@/server/http";

// Hub configuration --------------------------------------------------------

export type SyncSettings = {
  host: string;
  port: number;
  user: string;
  password: string;
  database: string;
};

/** The hub, only when the operator has configured one. */
export function syncSettings(): SyncSettings | null {
  const host = process.env["SYNC_DB_HOST"];
  if (!host) return null;
  const database = process.env["SYNC_DB_NAME"];
  if (!database) return null;
  return {
    host,
    port: Number.parseInt(process.env["SYNC_DB_PORT"] ?? "3306", 10),
    user: process.env["SYNC_DB_USER"] ?? "root",
    password: process.env["SYNC_DB_PASSWORD"] ?? "",
    database,
  };
}

/**
 * MariaDB DDL for the shared tables. Only a mirror of what the local app has,
 * plus the hub's own book-keeping tables. `updated_at` is declared here for the
 * tables the local app gained it on, so both ends compare the same column. Every
 * statement is IF NOT EXISTS: sync can be run any number of times without a fuss.
 *
 * The natural keys are deliberately inconsistent, and the reason matters.
 *
 * `users.email` and `students.matric_no` carry a UNIQUE key because both are
 * guaranteed present and unique within one machine (see AGENTS.md on natural
 * keys), so a duplicate on the hub is always the same person arriving twice.
 *
 * `staff.staff_no` carries none, because 64 staff numbers are shared by more
 * than one row in the registrar's file and that is real data, not corruption.
 * Putting a UNIQUE key there would make the second person overwrite the first.
 * That is left as a conflict to report instead.
 */
const HUB_DDL = `
CREATE TABLE IF NOT EXISTS users (
  id CHAR(36) NOT NULL PRIMARY KEY,
  email VARCHAR(255) NOT NULL,
  password_hash VARCHAR(255) NOT NULL,
  full_name VARCHAR(120) NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  UNIQUE KEY hub_users_email_unique (email)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS profiles (
  id CHAR(36) NOT NULL PRIMARY KEY,
  full_name VARCHAR(120) NULL,
  email VARCHAR(255) NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS user_roles (
  id CHAR(36) NOT NULL PRIMARY KEY,
  user_id CHAR(36) NOT NULL,
  role ENUM('admin', 'operator', 'viewer') NOT NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  UNIQUE KEY hub_user_roles_user_role_unique (user_id, role),
  KEY hub_user_roles_role_idx (role)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS students (
  id CHAR(36) NOT NULL,
  matric_no VARCHAR(64) NOT NULL,
  last_name VARCHAR(80) NULL,
  first_name VARCHAR(80) NULL,
  middle_name VARCHAR(80) NULL,
  level VARCHAR(64) NULL,
  department VARCHAR(120) NULL,
  marital_status VARCHAR(32) NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  UNIQUE KEY hub_students_matric_unique (matric_no)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- A hub created before the registrar's department name and marital status were
-- kept would otherwise reject the rows a device pushes with those columns.
ALTER TABLE students ADD COLUMN IF NOT EXISTS department VARCHAR(120) NULL;
ALTER TABLE students ADD COLUMN IF NOT EXISTS marital_status VARCHAR(32) NULL;

CREATE TABLE IF NOT EXISTS staff (
  id CHAR(36) NOT NULL PRIMARY KEY,
  staff_no VARCHAR(64) NULL,
  last_name VARCHAR(80) NULL,
  first_name VARCHAR(80) NULL,
  middle_name VARCHAR(80) NULL,
  faculty VARCHAR(120) NULL,
  department VARCHAR(120) NULL,
  admin_department VARCHAR(120) NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS student_events (
  id CHAR(36) NOT NULL PRIMARY KEY,
  title VARCHAR(160) NOT NULL,
  event_date DATE NOT NULL,
  start_time TIME NULL,
  end_time TIME NULL,
  student_category ENUM('undergraduate', 'postgraduate') NULL,
  level VARCHAR(64) NULL,
  department_code VARCHAR(120) NULL,
  notes TEXT NULL,
  status ENUM('draft', 'finalized') NOT NULL DEFAULT 'draft',
  created_by CHAR(36) NULL,
  finalized_at DATETIME(3) NULL,
  event_category ENUM('community_mass', 'other') NOT NULL DEFAULT 'other',
  template_id CHAR(36) NULL,
  schedule_id CHAR(36) NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS staff_events (
  id CHAR(36) NOT NULL PRIMARY KEY,
  title VARCHAR(160) NOT NULL,
  event_date DATE NOT NULL,
  start_time TIME NULL,
  end_time TIME NULL,
  notes TEXT NULL,
  status ENUM('draft', 'finalized') NOT NULL DEFAULT 'draft',
  created_by CHAR(36) NULL,
  finalized_at DATETIME(3) NULL,
  event_category ENUM('community_mass', 'other') NOT NULL DEFAULT 'other',
  template_id CHAR(36) NULL,
  schedule_id CHAR(36) NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Recurring templates. student_events points at these, so a hub without them
-- holds events whose template_id and schedule_id resolve to nothing. The
-- schedule rows carry no stamp: saving a template replaces its schedules
-- wholesale, so there is no per-row edit to arbitrate.
CREATE TABLE IF NOT EXISTS recurring_templates (
  id CHAR(36) NOT NULL PRIMARY KEY,
  name VARCHAR(160) NOT NULL,
  description TEXT NULL,
  group_kind ENUM('student', 'staff') NOT NULL DEFAULT 'student',
  start_date DATE NOT NULL,
  end_date DATE NOT NULL,
  event_title_template VARCHAR(160) NOT NULL,
  start_time TIME NULL,
  end_time TIME NULL,
  notes TEXT NULL,
  event_category ENUM('community_mass', 'other') NOT NULL DEFAULT 'other',
  created_by CHAR(36) NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS recurring_schedules (
  id CHAR(36) NOT NULL PRIMARY KEY,
  template_id CHAR(36) NOT NULL,
  day_of_week TINYINT UNSIGNED NOT NULL,
  student_category ENUM('undergraduate', 'postgraduate') NULL,
  level VARCHAR(64) NULL,
  title_suffix VARCHAR(80) NULL,
  department_code VARCHAR(120) NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Append-only tables: globally unique uuids, no stamp, merged by missing id.
CREATE TABLE IF NOT EXISTS student_event_uploads (
  id CHAR(36) NOT NULL PRIMARY KEY,
  event_id CHAR(36) NOT NULL,
  file_name VARCHAR(255) NOT NULL,
  label VARCHAR(80) NULL,
  row_count INT NOT NULL DEFAULT 0,
  present_count INT NOT NULL DEFAULT 0,
  out_of_scope_count INT NOT NULL DEFAULT 0,
  unmatched_count INT NOT NULL DEFAULT 0,
  uploaded_by CHAR(36) NULL,
  uploaded_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS staff_event_uploads (
  id CHAR(36) NOT NULL PRIMARY KEY,
  event_id CHAR(36) NOT NULL,
  file_name VARCHAR(255) NOT NULL,
  label VARCHAR(80) NULL,
  row_count INT NOT NULL DEFAULT 0,
  present_count INT NOT NULL DEFAULT 0,
  out_of_scope_count INT NOT NULL DEFAULT 0,
  unmatched_count INT NOT NULL DEFAULT 0,
  uploaded_by CHAR(36) NULL,
  uploaded_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS student_scans (
  id CHAR(36) NOT NULL PRIMARY KEY,
  event_id CHAR(36) NOT NULL,
  upload_id CHAR(36) NOT NULL,
  scan_number VARCHAR(64) NULL,
  scanned_name VARCHAR(200) NULL,
  scanned_at DATETIME(3) NOT NULL,
  student_id CHAR(36) NULL,
  match_method ENUM('number', 'name', 'none') NOT NULL DEFAULT 'none',
  in_scope TINYINT(1) NOT NULL DEFAULT 0,
  outside_window TINYINT(1) NOT NULL DEFAULT 0
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS staff_scans (
  id CHAR(36) NOT NULL PRIMARY KEY,
  event_id CHAR(36) NOT NULL,
  upload_id CHAR(36) NOT NULL,
  scan_number VARCHAR(64) NULL,
  scanned_name VARCHAR(200) NULL,
  scanned_at DATETIME(3) NOT NULL,
  staff_id CHAR(36) NULL,
  match_method ENUM('number', 'name', 'none') NOT NULL DEFAULT 'none',
  in_scope TINYINT(1) NOT NULL DEFAULT 0,
  outside_window TINYINT(1) NOT NULL DEFAULT 0
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS recurring_schedule_departments (
  schedule_id CHAR(36) NOT NULL,
  department VARCHAR(120) NOT NULL,
  PRIMARY KEY (schedule_id, department)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS student_event_departments (
  event_id CHAR(36) NOT NULL,
  department_code VARCHAR(180) NOT NULL,
  PRIMARY KEY (event_id, department_code)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS staff_event_departments (
  event_id CHAR(36) NOT NULL,
  department VARCHAR(180) NOT NULL,
  PRIMARY KEY (event_id, department)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS staff_presence_overrides (
  scan_number VARCHAR(64) NOT NULL PRIMARY KEY,
  reason TEXT NOT NULL,
  is_builtin TINYINT(1) NOT NULL DEFAULT 0,
  created_by CHAR(36) NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Which device last wrote what, so the hub can be inspected.
CREATE TABLE IF NOT EXISTS hub_devices (
  device_id CHAR(36) NOT NULL PRIMARY KEY,
  last_seen_at DATETIME(3) NOT NULL,
  last_synced_at DATETIME(3) NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
`;

// Table manifest ------------------------------------------------------------

/** A row is replaceable when edits to it should travel, append-only when not. */
type SyncTable = {
  table: string;
  /** Primary key. Every local table keys on one column, or a composite pair. */
  key: string;
  /** Second half of a composite key, for the department junctions. */
  key2?: string;
  /** LWW by this column for replaceable rows; null means append-only. */
  stamp: string | null;
  /**
   * A column that names the same person across machines. Reported as a conflict
   * when the same value turns up under two ids; never used to rewrite one.
   */
  natural?: string;
};

/**
 * The identity of one row, for use as a Map key only.
 *
 * The composite halves are pinned together with a NUL so "event X, dept AB" can
 * never be confused with "event XA, dept B". This is deliberately never
 * interpolated into SQL: the key columns go to the engine as separate bound
 * parameters, because a NUL byte is not a legal character in a MySQL string and
 * the previous `WHERE event_id = ?` form could only ever fail to match.
 */
function rowKey(row: HubRow, table: SyncTable): string {
  const first = String(row[table.key] ?? "");
  return table.key2 ? `${first}\u0000${String(row[table.key2] ?? "")}` : first;
}

/** The key columns as bound parameters, which is how SQL must receive them. */
function keyValues(row: HubRow, table: SyncTable): SqlParam[] {
  const values: SqlParam[] = [row[table.key] ?? null];
  if (table.key2) values.push(row[table.key2] ?? null);
  return values;
}

/** `WHERE key = ?` or `WHERE key = ? AND key2 = ?`. */
function keyPredicate(table: SyncTable): string {
  return table.key2 ? `${table.key} = ? AND ${table.key2} = ?` : `${table.key} = ?`;
}

const REPLACE: SyncTable[] = [
  { table: "users", key: "id", stamp: "updated_at", natural: "email" },
  { table: "profiles", key: "id", stamp: "updated_at" },
  { table: "user_roles", key: "id", stamp: "updated_at" },
  { table: "students", key: "id", stamp: "updated_at", natural: "matric_no" },
  { table: "staff", key: "id", stamp: "updated_at", natural: "staff_no" },
  { table: "student_events", key: "id", stamp: "updated_at" },
  { table: "staff_events", key: "id", stamp: "updated_at" },
  { table: "staff_presence_overrides", key: "scan_number", stamp: "updated_at" },
  { table: "recurring_templates", key: "id", stamp: "updated_at" },
];

// Parents before children, and a stamped row before the rows that point at it:
// student_events and recurring_schedules reference users and recurring_templates.
const APPEND: SyncTable[] = [
  { table: "student_event_uploads", key: "id", stamp: null },
  { table: "staff_event_uploads", key: "id", stamp: null },
  { table: "recurring_schedules", key: "id", stamp: null },
  { table: "student_scans", key: "id", stamp: null },
  { table: "staff_scans", key: "id", stamp: null },
  { table: "recurring_schedule_departments", key: "schedule_id", key2: "department", stamp: null },
  { table: "student_event_departments", key: "event_id", key2: "department_code", stamp: null },
  { table: "staff_event_departments", key: "event_id", key2: "department", stamp: null },
];

// Hub pool ------------------------------------------------------------------

const syncStore = globalThis as typeof globalThis & {
  __attendanceSyncPool: Pool | undefined;
};

function hubPool(settings: SyncSettings): Pool {
  syncStore.__attendanceSyncPool ??= createPool({
    host: settings.host,
    port: settings.port,
    user: settings.user,
    password: settings.password,
    database: settings.database,
    multipleStatements: true,
    waitForConnections: true,
    connectionLimit: 2,
    connectTimeout: 10_000,
    // The app stores every timestamp as 'YYYY-MM-DD HH:MM:SS[.mmm]' text and
    // compares rows by their strings. If the driver converted hub DATETIME
    // columns back to Date objects, a pulled row would carry a JS Date where
    // the rest of the app sees text, and the loose string comparison in
    // sameRow() would never settle. Keep them as the strings the wire sends.
    dateStrings: true,
  });
  return syncStore.__attendanceSyncPool;
}

/**
 * Errors that mean the hub is unreachable, as opposed to a mistake in the SQL.
 *
 * Only these become a 502. Everything else used to be reported the same way,
 * which sent whoever was reading the screen to check SYNC_DB_* over a bug that
 * had nothing to do with the network — a junction table with the wrong conflict
 * target reads as "Could not reach the sync database" and nothing else.
 */
const CONNECTION_CODES = new Set([
  "ECONNREFUSED",
  "ECONNRESET",
  "EHOSTUNREACH",
  "ENETUNREACH",
  "ENOTFOUND",
  "ETIMEDOUT",
  "EPIPE",
  "ER_ACCESS_DENIED_ERROR",
  "ER_BAD_DB_ERROR",
  "ER_CON_COUNT_ERROR",
  "PROTOCOL_CONNECTION_LOST",
]);

async function withCheck<T>(work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (error) {
    if (error instanceof HttpError) throw error;
    const code = (error as { code?: string }).code;
    const message = (error as { message?: string }).message ?? String(error);
    if (code && CONNECTION_CODES.has(code)) {
      throw new HttpError(502, `Could not reach the sync database.(${code}) Check SYNC_DB_*.`);
    }
    // A query or programming error. Naming it as such is the whole point: it is
    // not a network problem and retrying will not help.
    throw new HttpError(500, `Synchronization failed: ${message}`);
  }
}

/** Bring the shared database up to its mirror + bookkeeping shape. */
async function ensureHubSchema(pool: Pool): Promise<void> {
  await pool.query(HUB_DDL);
}

// Row helpers ---------------------------------------------------------------

type HubRow = RowDataPacket & Record<string, SqlParam | null>;

/**
 * The same instant written in two different ways.
 *
 * SQLite's CURRENT_TIMESTAMP has no milliseconds, so a row the app inserts
 * without a stamp reads back as "2026-10-22 11:39:01", while the hub's
 * DATETIME(3) column reads back as "2026-10-22 11:39:01.000". They are the
 * same moment, but the engine compares rows as text, so every seeded row used
 * to look like a row the two sides disagreed about. A first synchronization
 * then reported every one of them as an unresolved conflict.
 *
 * Stamps are put into the one shape the hub's column can hold before they are
 * compared or written, so the two sides speak the same language.
 */
const TIMESTAMP_TEXT = /^(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2})(?:\.(\d+))?$/;

/** One timestamp in the shared shape. Anything else is left exactly as it is. */
function canonicalTimestamp(value: SqlParam | null): SqlParam | null {
  if (typeof value !== "string") return value;
  const match = TIMESTAMP_TEXT.exec(value);
  if (!match) return value;
  // The hub keeps milliseconds; anything finer is dropped, as the column would.
  const millis = (match[2] ?? "").slice(0, 3).padEnd(3, "0");
  return `${match[1]}.${millis}`;
}

/** A row with every timestamp in the shared shape. */
function canonicalRow(row: HubRow): HubRow {
  const out = {} as HubRow;
  for (const [name, value] of Object.entries(row)) {
    out[name] = canonicalTimestamp(value);
  }
  return out;
}

/** Read every row of one hub table. `table` is from the manifest above. */
async function hubAll(pool: Pool, table: string): Promise<HubRow[]> {
  const [rows] = await pool.query<HubRow[]>(`SELECT * FROM \`${table}\``);
  return rows.map(canonicalRow);
}

/** Read every row of one local table. `query` is engine-agnostic. */
function localAll(table: string): Promise<HubRow[]> {
  return query<HubRow>(`SELECT * FROM ${table}`).then((rows) => rows.map(canonicalRow));
}

/** The columns and values of a row. */
function columns(row: HubRow): { names: string[]; values: SqlParam[] } {
  const names = Object.keys(row);
  return { names, values: names.map((name) => canonicalTimestamp(row[name] ?? null)) };
}

/** Keyed by rowKey, so both directions look a row up in constant time. */
function byRowKey(rows: HubRow[], table: SyncTable): Map<string, HubRow> {
  const map = new Map<string, HubRow>();
  for (const row of rows) map.set(rowKey(row, table), row);
  return map;
}

/**
 * Keyed by the natural key, for spotting one person arriving under two ids.
 * Values that are null or blank are left out: `staff_no` is legitimately absent
 * on a couple of rows, and "both blank" is not a collision.
 */
function byNaturalKey(rows: HubRow[], table: SyncTable): Map<string, HubRow> | null {
  if (!table.natural) return null;
  const map = new Map<string, HubRow>();
  for (const row of rows) {
    const value = String(row[table.natural] ?? "").trim();
    if (value) map.set(value, row);
  }
  return map;
}

/** The single hub upsert that both replace and append paths end at. */
async function hubUpsert(pool: Pool, table: SyncTable, row: HubRow): Promise<void> {
  const { names, values } = columns(row);
  const marked = names.map((name) => "`" + name + "`").join(", ");
  const place = names.map(() => "?").join(", ");
  // The key columns are excluded from the assignment list. If the row lands on
  // an existing hub row by way of `users.email` or `students.matric_no`, every
  // other column is brought up to date but the id is left exactly as it was:
  // rewriting it would strand every student_scans.student_id and
  // staff_scans.staff_id that points there. That is the row the local machine
  // keeps too, so the two sides stay consistent about who owns the id.
  const keys = new Set([table.key, table.key2].filter((k): k is string => Boolean(k)));
  const assignments = names
    .filter((name) => !keys.has(name))
    .map((name) => `\`${name}\` = VALUES(\`${name}\`)`);
  // A junction row can be nothing but its composite key (student_event_departments
  // is exactly (event_id, department_code)). With no other column to bring up to
  // date the list would be empty and "ON DUPLICATE KEY UPDATE " is a syntax
  // error, so assign the key to itself: a deliberate no-op that still lets the
  // duplicate row be swallowed.
  const assign =
    assignments.length > 0 ? assignments.join(", ") : `\`${table.key}\` = \`${table.key}\``;
  await pool.query(
    `INSERT INTO \`${table.table}\` (${marked}) VALUES (${place})
     ON DUPLICATE KEY UPDATE ${assign}`,
    values,
  );
}

/** Local upsert, engine-agnostic through `dialect`. */
async function localUpsert(table: SyncTable, row: HubRow): Promise<void> {
  const { names, values } = columns(row);
  const marked = names.join(", ");
  const place = names.map(() => "?").join(", ");
  await query(
    `INSERT INTO ${table.table} (${marked}) VALUES (${place})
     ${dialect.upsert(table.key2 ? [table.key, table.key2] : table.key, names)}`,
    values,
  );
}

/** True when every value of two rows agrees. */
function sameRow(a: HubRow, b: HubRow): boolean {
  const all = new Set([...Object.keys(a), ...Object.keys(b)]);
  for (const name of all) {
    const left = a[name] ?? null;
    const right = b[name] ?? null;
    // Numbers come back from MariaDB as strings on some drivers; compare loosely
    // rather than let "1500" and 1500 claim to differ.
    if (String(left) !== String(right)) return false;
  }
  return true;
}

/**
 * One table's outcome, so a conflict can be counted without a second pass.
 *
 * `reported` holds the clashes already counted for this table, so the pull
 * direction does not count the same clash again. A row the two sides disagree
 * about is seen twice in a run - once when the push meets it and once when the
 * pull meets it - and it is one disagreement, not two. The key says which
 * disagreement it is: `n:` for two ids claiming one person, `r:` for one row
 * whose contents differ.
 */
type TableOutcome = { moved: number; conflicts: number; reported: Set<string> };

const NOTHING: TableOutcome = { moved: 0, conflicts: 0, reported: new Set<string>() };

// The two directions -------------------------------------------------------

async function pushTable(pool: Pool, table: SyncTable): Promise<TableOutcome> {
  const local = await localAll(table.table);
  if (local.length === 0) return NOTHING;
  const stamp = table.stamp;

  const localByKey = byRowKey(local, table);
  const hubByKey = byRowKey(await hubAll(pool, table.table), table);
  const hubByNatural = byNaturalKey([...hubByKey.values()], table);

  let moved = 0;
  let conflicts = 0;
  const reported = new Set<string>();
  for (const [keyValue, row] of localByKey) {
    const natural = table.natural ? String(row[table.natural] ?? "").trim() : "";
    const existing = hubByKey.get(keyValue);
    if (!existing) {
      // A new id for a person the hub already knows under another one. Report it
      // and leave the hub row alone: see the note at the top of this file.
      if (natural && hubByNatural?.has(natural)) {
        conflicts += 1;
        reported.add(`n:${natural}`);
        continue;
      }
      await hubUpsert(pool, table, row);
      hubByKey.set(keyValue, row);
      if (natural && hubByNatural) hubByNatural.set(natural, row);
      moved += 1;
      continue;
    }
    if (stamp === null) continue; // append-only: the id is already there
    // The natural key itself was edited here, to a value some *other* hub row
    // already holds. Writing it would fail the hub's UNIQUE index and abort the
    // whole run, so it is reported instead. Both copies are left untouched and a
    // person decides which matric number is right.
    if (natural && hubByNatural?.has(natural) && hubByNatural.get(natural) !== existing) {
      conflicts += 1;
      reported.add(`n:${natural}`);
      continue;
    }
    const localStamp = String(row[stamp] ?? "");
    const hubStamp = String(existing[stamp] ?? "");
    if (localStamp > hubStamp) {
      await hubUpsert(pool, table, row);
      hubByKey.set(keyValue, row);
      if (natural && hubByNatural) hubByNatural.set(natural, row);
      moved += 1;
    } else if (localStamp === hubStamp && !sameRow(row, existing)) {
      // Same stamp, different content: nobody can prove who is right, so
      // neither side moves. Reported to the operator instead.
      conflicts += 1;
      reported.add(`r:${keyValue}`);
    }
  }
  return { moved, conflicts, reported };
}

async function pullTable(
  pool: Pool,
  table: SyncTable,
  reported: Set<string>,
): Promise<TableOutcome> {
  const hub = await hubAll(pool, table.table);
  if (hub.length === 0) return NOTHING;
  const stamp = table.stamp;

  const localByKey = byRowKey(await localAll(table.table), table);
  const localByNatural = byNaturalKey([...localByKey.values()], table);

  let moved = 0;
  let conflicts = 0;
  for (const row of hub) {
    const natural = table.natural ? String(row[table.natural] ?? "").trim() : "";
    const existing = localByKey.get(rowKey(row, table));
    if (!existing) {
      // Inserting a row whose natural key is already held locally would trip the
      // local UNIQUE index and abort the whole run, so it is reported instead.
      if (natural && localByNatural?.has(natural)) {
        // The push met this same disagreement first, and counted it there.
        if (!reported.has(`n:${natural}`)) {
          conflicts += 1;
          reported.add(`n:${natural}`);
        }
        continue;
      }
      await localUpsert(table, row);
      localByKey.set(rowKey(row, table), row);
      if (natural && localByNatural) localByNatural.set(natural, row);
      moved += 1;
      continue;
    }
    if (stamp === null) continue;
    // The hub changed this row's natural key to a value another local row holds.
    // Writing it would fail the local UNIQUE index, so it is reported instead.
    if (natural && localByNatural?.has(natural) && localByNatural.get(natural) !== existing) {
      if (!reported.has(`n:${natural}`)) {
        conflicts += 1;
        reported.add(`n:${natural}`);
      }
      continue;
    }
    const hubStamp = String(row[stamp] ?? "");
    const localStamp = String(existing[stamp] ?? "");
    if (hubStamp > localStamp) {
      await localUpsert(table, row);
      localByKey.set(rowKey(row, table), row);
      if (natural && localByNatural) localByNatural.set(natural, row);
      moved += 1;
    } else if (hubStamp === localStamp && !sameRow(row, existing)) {
      // The same condition pushTable refuses to resolve, refused here too. It
      // used to overwrite local with the hub, which meant an edit made on this
      // machine could be discarded by its own synchronization.
      const key = rowKey(row, table);
      if (!reported.has(`r:${key}`)) {
        conflicts += 1;
        reported.add(`r:${key}`);
      }
    }
  }
  return { moved, conflicts, reported };
}

// Device identity -----------------------------------------------------------

async function deviceId(): Promise<string> {
  // `key` is quoted because it is a MySQL reserved word; SQLite accepts the
  // same backticks, so one string serves both engines.
  const rows = await query<{ key: string; value: string }>(
    "SELECT `key`, value FROM sync_meta WHERE `key` = 'device_id'",
  );
  if (rows[0]) return rows[0].value;
  const id = randomUUID();
  await query("INSERT INTO sync_meta (`key`, value) VALUES ('device_id', ?)", [id]);
  return id;
}

async function syncMetaValue(key: string): Promise<string | null> {
  const rows = await query<{ value: string }>("SELECT value FROM sync_meta WHERE `key` = ?", [key]);
  return rows[0]?.value ?? null;
}

async function setSyncMeta(key: string, value: string): Promise<void> {
  await query(
    `INSERT INTO sync_meta (\`key\`, value) VALUES (?, ?)
     ${dialect.upsert("key", ["value"])}`,
    [key, value],
  );
}

// Public API ----------------------------------------------------------------

export type SyncResult = {
  configured: boolean;
  message: string;
  pushed: number;
  pulled: number;
  /**
   * Rows both sides could not agree on: same stamp and different content, or the
   * same person under two ids. Nothing was moved for these, so a non-zero count
   * means part of the database did not synchronize and a person has to look.
   */
  conflicts: number;
  lastSyncedAt: string | null;
};

/** Tear the hub pool down, so a process can end after a test run. */
export async function closeHubPool(): Promise<void> {
  await syncStore.__attendanceSyncPool?.end();
  syncStore.__attendanceSyncPool = undefined;
}

export function syncStatus(): { configured: boolean } {
  return { configured: syncSettings() !== null };
}

/**
 * Run a full synchronization and report what moved. Throws HttpError when the
 * hub is not configured or cannot be reached, so the API can answer honestly.
 */
export async function runSync(): Promise<SyncResult> {
  const settings = syncSettings();
  if (!settings) {
    throw new HttpError(
      503,
      "Synchronization is not configured on this computer. Set SYNC_DB_HOST and SYNC_DB_NAME to point at the shared database, then try again.",
    );
  }

  const pool = hubPool(settings);
  const id = await deviceId();
  const now = new Date().toISOString().replace("T", " ").slice(0, 23);

  await withCheck(async () => {
    await ensureHubSchema(pool);
    await pool.query(
      `INSERT INTO hub_devices (device_id, last_seen_at)
       VALUES (?, ?)
       ON DUPLICATE KEY UPDATE last_seen_at = VALUES(last_seen_at)`,
      [id, now],
    );
  });

  let pushed = 0;
  let pulled = 0;
  let conflicts = 0;
  await withCheck(async () => {
    for (const table of REPLACE.concat(APPEND)) {
      const out = await pushTable(pool, table);
      pushed += out.moved;
      conflicts += out.conflicts;

      const back = await pullTable(pool, table, out.reported);
      pulled += back.moved;
      conflicts += back.conflicts;
    }
    await pool.query(`UPDATE hub_devices SET last_synced_at = ? WHERE device_id = ?`, [now, id]);
  });

  const prev = await syncMetaValue("last_synced_at");
  await setSyncMeta("last_synced_at", now);
  await query(
    `INSERT INTO sync_log (id, synced_at, device_id, pushed, pulled, notes) VALUES (?, ?, ?, ?, ?, ?)`,
    [randomUUID(), now, id, pushed, pulled, conflicts ? `${conflicts} unresolved` : null],
  );

  return {
    configured: true,
    message: syncMessage(pushed, pulled, conflicts),
    pushed,
    pulled,
    conflicts,
    lastSyncedAt: prev,
  };
}

/** What the run did, said plainly. A conflict is never folded into a success. */
function syncMessage(pushed: number, pulled: number, conflicts: number): string {
  if (pushed === 0 && pulled === 0 && conflicts === 0) {
    return "Nothing to synchronize — the two sides already agree.";
  }
  const parts: string[] = [];
  if (pushed) parts.push(`pushed ${pushed}`);
  if (pulled) parts.push(`pulled ${pulled}`);
  let message = `Synchronized: ${parts.join(", ")} row(s).`;
  if (conflicts) {
    message += ` ${conflicts} row(s) could not be reconciled and were left alone on both sides.`;
  }
  return message;
}
