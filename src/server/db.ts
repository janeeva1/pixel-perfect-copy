import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import Database from "better-sqlite3";
import type { Database as SqliteDatabase, Statement } from "better-sqlite3";
import { createPool } from "mysql2/promise";
import type { Pool, PoolConnection } from "mysql2/promise";
import { loadServerEnv } from "./env";

/**
 * The database layer speaks two engines behind one small API, because the app
 * has to keep working against the MariaDB install it already has while the
 * desktop build moves to a single local file.
 *
 *   DB_DRIVER=sqlite   (default) one file at DB_FILE. This is the local-first
 *                      database the app and its installer are built around.
 *   DB_DRIVER=mysql    MariaDB, configured by DB_HOST/DB_PORT/DB_USER/
 *                      DB_PASSWORD/DB_NAME. Opt in for a hosted deployment that
 *                      keeps its data in MariaDB.
 *
 * Call sites use `query()` / `queryOne()` / `transaction()` and, where the two
 * engines spell something differently, the `dialect` helpers below. Nothing else
 * in the server knows which engine is underneath.
 *
 * SQLite is opened synchronously and the async surface is a thin wrapper, so the
 * API reads the same at every call site under both engines.
 */

/** One row of a result set. */
export interface RowDataPacket {
  // A result row is a bag of columns whose types are only known per query, so
  // this is the one place an `any` earns its keep; the call sites cast anyway.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  [column: string]: any;
}

/** Values the driver accepts as bind parameters. */
export type SqlParam = string | number | bigint | boolean | Date | Buffer | Uint8Array | null;

type SqlParams = SqlParam[];

export type Driver = "mysql" | "sqlite";

/**
 * Which engine to use. SQLite unless `DB_DRIVER` says otherwise, because the
 * app is local-first and an installed copy must work with no database server.
 * A hosted deployment that already keeps its accounts and history in MariaDB
 * opts in with `DB_DRIVER=mysql`.
 */
export function activeDriver(): Driver {
  loadServerEnv();
  const configured = (process.env["DB_DRIVER"] ?? "sqlite").toLowerCase();
  return configured === "mysql" ? "mysql" : "sqlite";
}

function usingSqlite(): boolean {
  return activeDriver() === "sqlite";
}

// Dialect ------------------------------------------------------------------

/**
 * The handful of places the two engines spell the same thing differently.
 *
 * These are functions rather than constants because the driver is read from the
 * environment at call time, and because a packaged build and a dev server can
 * differ without a rebuild.
 */
export const dialect = {
  /** `INSERT IGNORE` and `INSERT OR IGNORE` both skip rows that clash. */
  get insertIgnore(): string {
    return usingSqlite() ? "INSERT OR IGNORE INTO" : "INSERT IGNORE INTO";
  },

  /**
   * Upsert on a unique key. The columns are the ones a re-upload is allowed to
   * change; the key itself and the row id are left alone, exactly as the MySQL
   * `ON DUPLICATE KEY UPDATE` form did.
   *
   * The key may be several columns, for the composite-keyed junction tables. It
   * has to name every column of the primary key: SQLite rejects an `ON CONFLICT`
   * target that is not a unique index, and naming one half of
   * `(event_id, department_code)` is exactly that. MySQL ignores the target and
   * takes whichever key was violated, so the two agree on the same table.
   */
  upsert(key: string | string[], columns: string[]): string {
    const assignments = columns.map((column) => `${column} = VALUES(${column})`);
    if (usingSqlite()) {
      const excluded = columns.map((column) => `${column} = excluded.${column}`);
      const target = Array.isArray(key) ? key.join(", ") : key;
      return `ON CONFLICT(${target}) DO UPDATE SET ${excluded.join(", ")}`;
    }
    return `ON DUPLICATE KEY UPDATE ${assignments.join(", ")}`;
  },

  /** A DATETIME rendered the way the UI reads it back: `2026-03-04T05:06:07`. */
  dateTime(column: string): string {
    return usingSqlite()
      ? `strftime('%Y-%m-%dT%H:%M:%S', ${column})`
      : `DATE_FORMAT(${column}, '%Y-%m-%dT%H:%i:%s')`;
  },

  /** A DATE rendered as `2026-03-04`. */
  date(column: string): string {
    return usingSqlite() ? `date(${column})` : `DATE_FORMAT(${column}, '%Y-%m-%d')`;
  },

  /**
   * Comma-joined values. MariaDB truncates at `group_concat_max_len` (1MB on
   * this server) and SQLite has no limit, so this is only safe for short lists
   * such as a user's roles or one event's departments.
   *
   * Neither engine orders the result without an explicit `ORDER BY`, so the
   * caller must not depend on the order; splitting on the separator is the
   * only thing done with the result.
   */
  groupConcat(column: string, separator = ","): string {
    return usingSqlite()
      ? `GROUP_CONCAT(${column}, '${separator}')`
      : `GROUP_CONCAT(${column} SEPARATOR '${separator}')`;
  },

  /** Numeric ordering for a column stored as text, e.g. a student's level. */
  intCast(column: string): string {
    return usingSqlite() ? `CAST(${column} AS INTEGER)` : `CAST(${column} AS UNSIGNED)`;
  },

  /**
   * Trailing clause for a `LIKE` whose pattern came from `likeTerm()`.
   *
   * MariaDB treats backslash as the default escape character, so `a\%b` matches a
   * literal `%`. SQLite has no default, so the same pattern needs the escape
   * character stated or a search for `100%` would match everything.
   */
  get likeEscape(): string {
    return usingSqlite() ? " ESCAPE '\\'" : "";
  },
};

/** Escape the LIKE wildcards so a search for "100%" does not match everything. */
export function likeTerm(value: string): string {
  return `%${value.replace(/[\\%_]/g, (match) => `\\${match}`)}%`;
}

// Parameter coercion -------------------------------------------------------

/** MySQL's DATETIME(3) text form, which is what every timestamp column holds. */
function toSqlDateTime(value: Date): string {
  return value.toISOString().replace("T", " ").slice(0, 23);
}

/**
 * "Now" as the UTC text both engines store, for the `updated_at` stamps that
 * hub synchronization compares. Never local time: two machines in different
 * offsets have to agree on which string is newer, and only UTC strings do.
 */
export function utcStamp(date = new Date()): string {
  return toSqlDateTime(date);
}

/**
 * MySQL's driver accepts booleans, `undefined` and `Date`; SQLite's accepts
 * only null/number/bigint/string/buffer. Converting here keeps every call site
 * writing the natural thing.
 */
function toSqliteParam(value: SqlParam | undefined): null | number | bigint | string | Buffer {
  if (value === undefined || value === null) return null;
  if (typeof value === "boolean") return value ? 1 : 0;
  if (value instanceof Date) return toSqlDateTime(value);
  if (value instanceof Uint8Array) return Buffer.from(value);
  return value;
}

/** `undefined` is not a bindable value; everything else the driver already has. */
function toMysqlParam(value: SqlParam | undefined): Exclude<SqlParam, undefined> | null {
  if (value === undefined) return null;
  return value;
}

// Shared handles -----------------------------------------------------------

/**
 * The pool and the SQLite handle are parked on `globalThis`, not in module
 * scope. Vite re-evaluates this module whenever a server file changes, which
 * resets a module-level cache and opens a *second* connection while the first
 * one's file handle or pool is still open; the MySQL version of this file leaked
 * a whole pool of connections per edit until the database refused new ones with
 * "Too many connections". `globalThis` outlives the module, so each is created
 * once per process.
 */
const store = globalThis as typeof globalThis & {
  __attendancePool: Pool | undefined;
  __attendanceSqlite: SqliteDatabase | undefined;
  __attendanceStatements: Map<string, Statement> | undefined;
  /**
   * What opening the handle migrated, kept only until a `migrate()` call has
   * reported it. Opening migrates because an installed app has no console to run
   * a migration in, which would otherwise leave `migrate()` with nothing to say.
   */
  __attendanceMigrations: { applied: string[]; version: number } | undefined;
};

function pool(): Pool {
  store.__attendancePool ??= createPool({
    host: process.env["DB_HOST"] ?? "127.0.0.1",
    port: Number.parseInt(process.env["DB_PORT"] ?? "3306", 10),
    user: process.env["DB_USER"] ?? "root",
    password: process.env["DB_PASSWORD"] ?? "",
    database: process.env["DB_NAME"] ?? "attendance",
    waitForConnections: true,
    connectionLimit: Number.parseInt(process.env["DB_POOL_SIZE"] ?? "10", 10),
    connectTimeout: 10_000,
  });
  return store.__attendancePool;
}

function databaseFile(): string {
  loadServerEnv();
  // A packaged desktop build sets this to a file inside the user's own data
  // directory, so the same code runs in development and when installed.
  const configured = process.env["DB_FILE"];
  if (configured) return path.resolve(configured);
  return path.resolve(process.cwd(), "db", "attendance.db");
}

/** The SQLite handle, opened and migrated on first use. */
export function getDb(): SqliteDatabase {
  if (store.__attendanceSqlite) return store.__attendanceSqlite;
  const file = databaseFile();
  fs.mkdirSync(path.dirname(file), { recursive: true });

  const db = new Database(file);
  // Foreign keys are what make `DELETE FROM student_events` take its uploads,
  // scans and department rows with it. The old code relies on that cascade
  // without ever deleting the children.
  db.pragma("foreign_keys = ON");
  // WAL lets a report read while an upload is writing. Without it, a long read
  // blocks the write that the person waiting on the upload is waiting for.
  db.pragma("journal_mode = WAL");
  // Wait rather than fail when another process (a second app window, a backup)
  // holds the write lock.
  db.pragma("busy_timeout = 5000");

  registerFunctions(db);
  store.__attendanceStatements = new Map();
  store.__attendanceSqlite = db;
  // Apply anything this database has not had yet, here, while the handle is
  // being built. An installed app has no console to run a migration in, so an
  // empty database has to become a usable one on first open.
  store.__attendanceMigrations = applyMigrations(db);
  return db;
}

/**
 * Close whichever handle is open. Used by the CLI scripts on the way out.
 *
 * The MySQL pool holds open sockets, so a script that only closed the SQLite
 * handle would keep the process alive after it had finished its work. Both are
 * closed here, and the function waits for the pool to let go of its
 * connections so the script can exit as soon as it returns.
 */
export async function closeDb(): Promise<void> {
  store.__attendanceSqlite?.close();
  store.__attendanceSqlite = undefined;
  store.__attendanceStatements = undefined;
  store.__attendanceMigrations = undefined;
  const pool = store.__attendancePool;
  store.__attendancePool = undefined;
  if (pool) await pool.end();
}

// SQLite compatibility functions -------------------------------------------

/**
 * MySQL's SUBSTRING_INDEX, which SQLite does not have and which the scan-number
 * derivations (studentScanNumberSql, staffScanNumberSql) rely on to read the
 * printed number out of a matric or staff number. Registered as a real SQL
 * function rather than rewritten as a pile of nested REPLACE() calls, because
 * the callers should not have to care.
 *
 * A count is a number of separators to keep, not an index into the pieces: a
 * positive count returns everything up to and including that separator, a
 * negative one returns everything after it counting from the right, and a count
 * larger than the number of separators returns the whole string.
 */
function substringIndex(value: unknown, delimiter: unknown, position: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (delimiter === null || delimiter === undefined) return null;
  const text = String(value);
  const separator = String(delimiter);
  const index = Number(position);
  if (!Number.isFinite(index) || separator === "") return null;
  if (index === 0) return "";

  const parts = text.split(separator);
  if (index > 0) {
    if (index >= parts.length) return text;
    return parts.slice(0, index).join(separator);
  }
  const fromEnd = -index;
  if (fromEnd >= parts.length) return text;
  return parts.slice(parts.length - fromEnd).join(separator);
}

/**
 * The characters a `[...]` class names. A range like `0-9` has to be expanded:
 * `new Set("0-9")` would be the three characters `0`, `-` and `9`, which would
 * quietly delete nothing and match the wrong people.
 */
function characterClassMembers(body: string): Set<string> {
  const members = new Set<string>();
  for (let index = 0; index < body.length; index += 1) {
    const start = body[index] as string;
    // `x-y` is a range only when something follows the dash; a trailing `-`, as
    // in `[a-]`, is a literal dash.
    if (body[index + 1] === "-" && index + 2 < body.length) {
      const end = body[index + 2] as string;
      for (let code = start.charCodeAt(0); code <= end.charCodeAt(0); code += 1) {
        members.add(String.fromCharCode(code));
      }
      index += 2;
      continue;
    }
    members.add(start);
  }
  return members;
}

/**
 * MySQL 8 / MariaDB 10.4 REGEXP_REPLACE, used once to take the digits out of a
 * staff number. SQLite has no regex at all, so this is a deliberately small
 * subset: one character class, optionally negated, and an empty replacement,
 * which is the only shape the app calls it with. Anything else it is handed
 * returns the input unchanged rather than a wrong answer.
 */
function regexpReplace(value: unknown, pattern: unknown, replacement: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (pattern === null || pattern === undefined) return null;
  const text = String(value);
  const source = String(pattern);
  const replacementText =
    replacement === null || replacement === undefined ? "" : String(replacement);
  if (replacementText !== "") return text;

  const characterClass = /^\[\^?([^\]]*)\]$/.exec(source);
  if (!characterClass) return text;
  const negated = source.startsWith("[^");
  const members = characterClassMembers(characterClass[1] ?? "");

  let out = "";
  for (const character of text) {
    // `[^0-9]` matches every character that is not a digit, so those are the
    // ones dropped; `[0-9]` matches the digits themselves.
    if (negated ? !members.has(character) : members.has(character)) continue;
    out += character;
  }
  return out;
}

function registerFunctions(db: SqliteDatabase): void {
  // `deterministic` lets SQLite use these in indexes and generated columns.
  db.function("SUBSTRING_INDEX", { deterministic: true }, substringIndex);
  db.function("REGEXP_REPLACE", { deterministic: true }, regexpReplace);
}

function statementFor(sql: string): Statement {
  const cache = (store.__attendanceStatements ??= new Map());
  let statement = cache.get(sql);
  if (!statement) {
    // `db.prepare` throws on invalid SQL, which is the behaviour the MySQL
    // driver had, so a typo in a query still fails loudly and immediately.
    statement = getDb().prepare(sql);
    cache.set(sql, statement);
  }
  return statement;
}

/**
 * Run one statement and return its rows, if it has any.
 *
 * INSERT/UPDATE/DELETE are executed here too and simply return nothing. They
 * have to be: a statement that reports no rows is still a statement that has to
 * run, and `query()` is what the call sites use for writes as well as reads.
 */
function runStatement(sql: string, params: SqlParams = []): RowDataPacket[] {
  const statement = statementFor(sql);
  const bound = params.map(toSqliteParam);
  // `reader` is false for INSERT/UPDATE/DELETE. Calling .all() on one of those
  // throws, so the two paths are kept apart.
  if (!statement.reader) {
    statement.run(...bound);
    return [];
  }
  return statement.all(...bound) as RowDataPacket[];
}

/**
 * SQLite allows one writer at a time, so write transactions are queued rather
 * than run concurrently. This also keeps transaction boundaries intact: MySQL
 * gives each transaction its own pooled connection, so two overlapping `await`s
 * cannot land in the same transaction. With a single shared SQLite handle they
 * could, and an interleaved COMMIT would commit half of somebody else's work.
 * Queueing makes that impossible.
 */
let writeQueue: Promise<unknown> = Promise.resolve();

function enqueueWrite<T>(work: () => Promise<T>): Promise<T> {
  const result = writeQueue.then(work, work);
  // Swallow rejections on the chain itself so one failed transaction does not
  // reject every transaction queued behind it.
  writeQueue = result.then(
    () => undefined,
    () => undefined,
  );
  return result;
}

// Connection handed to `transaction()` --------------------------------------

/**
 * A handle shaped like the connection the call sites already expect. Both
 * methods return `[rows, fields]`, so the existing
 * `const [rows] = await connection.execute(...)` destructuring keeps working.
 *
 * The type parameter is the whole result, not the row type, which is how the
 * MySQL driver behaved: `execute<CountRow>()` yielded a single `CountRow` and
 * `execute<CountRow[]>()` yielded the array.
 */
export class DbConnection {
  private readonly sqlite: SqliteDatabase | null;
  private readonly mysql: PoolConnection | null;

  constructor(handle: SqliteDatabase | PoolConnection) {
    if (handle instanceof Database) {
      this.sqlite = handle;
      this.mysql = null;
    } else {
      this.sqlite = null;
      this.mysql = handle;
    }
  }

  async execute<T = RowDataPacket[]>(sql: string, params: SqlParams = []): Promise<[T, unknown]> {
    if (this.sqlite) return [runStatement(sql, params) as T, undefined];
    const [rows, fields] = await this.mysql!.execute(sql, params.map(toMysqlParam));
    return [rows as T, fields];
  }

  async query<T = RowDataPacket[]>(sql: string, params: SqlParams = []): Promise<[T, unknown]> {
    if (this.sqlite) return [runStatement(sql, params) as T, undefined];
    const [rows, fields] = await this.mysql!.query(sql, params.map(toMysqlParam));
    return [rows as T, fields];
  }
}

// Public API ----------------------------------------------------------------

export async function query<T = RowDataPacket>(sql: string, params: SqlParams = []): Promise<T[]> {
  if (usingSqlite()) return runStatement(sql, params) as T[];
  const [rows] = await pool().query(sql, params.map(toMysqlParam));
  return rows as T[];
}

export async function queryOne<T = RowDataPacket>(
  sql: string,
  params: SqlParams = [],
): Promise<T | null> {
  if (usingSqlite()) return (runStatement(sql, params) as T[])[0] ?? null;
  const [rows] = await pool().query(sql, params.map(toMysqlParam));
  return (rows as T[])[0] ?? null;
}

/** Run `work` inside a write transaction, rolling back on any thrown error. */
export function transaction<T>(work: (connection: DbConnection) => Promise<T>): Promise<T> {
  if (!usingSqlite()) {
    return (async () => {
      const connection = await pool().getConnection();
      try {
        await connection.beginTransaction();
        const result = await work(new DbConnection(connection));
        await connection.commit();
        return result;
      } catch (error) {
        try {
          await connection.rollback();
        } catch {
          // The original error is the one worth reporting.
        }
        throw error;
      } finally {
        connection.release();
      }
    })();
  }
  return enqueueWrite(async () => {
    const handle = getDb();
    const connection = new DbConnection(handle);
    // IMMEDIATE takes the write lock up front instead of upgrading mid-
    // transaction, which is what turns two overlapping writers into a busy
    // timeout rather than a deadlock.
    handle.exec("BEGIN IMMEDIATE");
    try {
      const result = await work(connection);
      handle.exec("COMMIT");
      return result;
    } catch (error) {
      try {
        handle.exec("ROLLBACK");
      } catch {
        // A rollback can fail if the transaction was already aborted by SQLite.
      }
      throw error;
    }
  });
}

// Migrations ----------------------------------------------------------------

/**
 * Where the `.sql` files live.
 *
 * `process.cwd()` is the project root in development but is wherever the
 * executable happened to be launched from once installed, so it cannot be the
 * only answer. The order is: an explicit override (a packaged build points this
 * at the SQL shipped beside it), then the project root, then beside this module.
 */
function migrationsDirectory(): string {
  const override = process.env["DB_MIGRATIONS_DIR"];
  if (override) return path.resolve(override);
  const candidates = [
    path.resolve(process.cwd(), "db", "migrations"),
    path.resolve(import.meta.dirname, "..", "..", "db", "migrations"),
  ];
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) return candidate;
  }
  // Nothing found: return the first so the error below names the expected path.
  return candidates[0]!;
}

function migrationFiles(): string[] {
  const directory = migrationsDirectory();
  if (!fs.existsSync(directory)) return [];
  return fs
    .readdirSync(directory)
    .filter((name) => name.endsWith(".sql"))
    .sort((a, b) => a.localeCompare(b, "en"));
}

/**
 * Apply any migration this SQLite database has not had yet, and record it in the
 * database's own `user_version`.
 *
 * MySQL had no equivalent: `db/migrate.mjs` re-ran the whole of `db/schema.sql`
 * on every invocation and relied on every statement being `IF NOT EXISTS`. SQLite
 * cannot do `ADD COLUMN IF NOT EXISTS`, so "re-run and ignore failures" is not
 * an option, and an installed app needs a way to tell what it already has.
 * A number in the file name is that way: 001 is applied and user_version becomes
 * 1, so 002 is the next one to run and is never run twice.
 *
 * This runs automatically the first time a connection is opened, so installing
 * the app needs no separate setup step.
 */
function applyMigrations(db: SqliteDatabase): { applied: string[]; version: number } {
  const directory = migrationsDirectory();
  const current = Number(db.pragma("user_version", { simple: true }) ?? 0);
  const files = numberedMigrations(migrationFiles());

  // A database that has already been migrated is fine with the files being
  // absent, because there is nothing left to apply. An empty one is not: that
  // means the SQL was not shipped, and every later query would fail with
  // "no such table". Say so now rather than three queries later.
  if (files.length === 0 && current === 0) {
    throw new Error(
      `no migrations found in ${directory}, so the empty database at ${databaseFile()} ` +
        `cannot be set up. Set DB_MIGRATIONS_DIR to the directory holding the .sql files.`,
    );
  }

  const pending = files.filter((file) => file.version > current);
  if (pending.length > 0) backupBeforeMigrating(db, current, pending[pending.length - 1]!.version);

  const applied: string[] = [];
  for (const { name, version } of pending) {
    const sql = fs.readFileSync(path.join(directory, name), "utf8");
    // One transaction per file: a migration either lands whole or not at all,
    // and user_version only moves once it has.
    db.exec("BEGIN IMMEDIATE");
    try {
      db.exec(sql);
      db.pragma(`user_version = ${version}`);
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw new Error(`migration ${name} failed: ${(error as Error).message}`, { cause: error });
    }
    applied.push(name);
  }

  return { applied, version: Number(db.pragma("user_version", { simple: true }) ?? 0) };
}

/**
 * The version of each migration comes from the number in its file name
 * (`014_something.sql` is version 14), not from where it happens to sort.
 *
 * Installed databases record the last version they applied, so the numbers must
 * run 1, 2, 3, ... with no gap and no repeat. A gap or a repeat means a file was
 * renamed, lost or added twice, and applying anything on top of that would skip
 * or re-run a migration, so it is refused with a message naming the problem.
 */
function numberedMigrations(names: string[]): Array<{ name: string; version: number }> {
  const numbered = names.map((name) => {
    const match = /^(\d+)_/.exec(name);
    if (!match) {
      throw new Error(`migration file ${name} must start with its number, e.g. 014_${name}`);
    }
    return { name, version: Number(match[1]) };
  });
  numbered.sort((a, b) => a.version - b.version);
  numbered.forEach((file, index) => {
    if (file.version !== index + 1) {
      throw new Error(
        `migration numbering is broken at ${file.name}: expected version ${index + 1}. ` +
          "Migrations must be numbered 001, 002, 003, ... with no gaps or repeats.",
      );
    }
  });
  return numbered;
}

const MIGRATION_BACKUPS_KEPT = 10;

/**
 * Copy the database aside before changing its schema, so a migration that goes
 * wrong on someone's machine can be undone by putting the file back. Backups go
 * to a `backups` folder beside the database and only the newest few are kept.
 *
 * A brand-new database has nothing worth keeping, so it is not copied. A backup
 * that cannot be written is reported but does not stop the app from starting:
 * the migration itself still runs inside a transaction.
 */
function backupBeforeMigrating(db: SqliteDatabase, fromVersion: number, toVersion: number): void {
  if (fromVersion === 0) return;
  const file = databaseFile();
  if (!fs.existsSync(file)) return;
  try {
    const directory = path.join(path.dirname(file), "backups");
    fs.mkdirSync(directory, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const target = path.join(
      directory,
      `attendance-v${fromVersion}-before-v${toVersion}-${stamp}.db`,
    );
    db.exec(`VACUUM INTO '${target.replace(/'/g, "''")}'`);

    const old = fs
      .readdirSync(directory)
      .filter((name) => name.startsWith("attendance-v") && name.endsWith(".db"))
      .map((name) => ({ name, time: fs.statSync(path.join(directory, name)).mtimeMs }))
      .sort((a, b) => b.time - a.time)
      .slice(MIGRATION_BACKUPS_KEPT)
      .map((entry) => entry.name);
    for (const name of old) fs.rmSync(path.join(directory, name), { force: true });
  } catch (error) {
    console.error(`Could not back up the database before migrating: ${(error as Error).message}`);
  }
}

/**
 * Bring the database up to date, for the CLI scripts and the tests.
 *
 * Under MySQL this is a no-op and says so: that schema is `db/schema.sql`,
 * applied by `npm run db:migrate:mysql`, and it has no version to report. Under
 * SQLite it applies the numbered files in `db/migrations`.
 *
 * Opening the handle migrates as well, so the first call against a fresh file
 * has nothing left to apply. It still reports what that open did, and only
 * once, so a caller is not told "nothing to do" about a schema it just built.
 */
export function migrate(): { applied: string[]; version: number } {
  if (!usingSqlite()) return { applied: [], version: 0 };
  const db = getDb();
  const opened = store.__attendanceMigrations;
  if (opened && opened.applied.length > 0) {
    store.__attendanceMigrations = { applied: [], version: opened.version };
    return opened;
  }
  return applyMigrations(db);
}
