/**
 * End-to-end check of hub synchronization against a real MariaDB.
 *
 * The office hub is the existing MariaDB instance (127.0.0.1:3306 by default),
 * used here on a throwaway database so the real `attendance` database is never
 * touched. The run is explicitly refused if it would point at the live one.
 *
 * Run with: npx tsx --test db/verify-sync.ts
 *
 * When MariaDB is not running (or the credentials are wrong) the test skips
 * itself and reports a pass; this file gates the sync engine, not your internet.
 *
 * Credentials, all optional:
 *   SYNC_DB_HOST   (default 127.0.0.1)
 *   SYNC_DB_PORT   (default 3306)
 *   SYNC_DB_USER   (default root)
 *   SYNC_DB_PASSWORD (default empty)
 *   SYNC_DB_NAME   When set, that database is used as-is (point it at a testing
 *                  database; never at `attendance`). Otherwise a throwaway
 *                  attendance_sync_test_* database is created and dropped.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { after, describe, it } from "node:test";
import { createConnection } from "mysql2/promise";

// Two independent machines, each its own SQLite file. The swap happens by
// closing the handle and pointing DB_FILE elsewhere, exactly like the app's own
// CLI scripts do.
const dirA = fs.mkdtempSync(path.join(os.tmpdir(), "attendance-sync-a-"));
const dirB = fs.mkdtempSync(path.join(os.tmpdir(), "attendance-sync-b-"));
const fileA = path.join(dirA, "attendance.db");
const fileB = path.join(dirB, "attendance.db");

process.env["DB_DRIVER"] = "sqlite";
process.env["DB_FILE"] = fileA;

const { closeDb, dialect, getDb, query } = await import("../src/server/db");
const { createEvent, updateEvent } = await import("../src/server/events");
const { closeHubPool, runSync } = await import("../src/server/sync");

// Hub settings, resolved before the sync module reads them.
const HOST = process.env["SYNC_DB_HOST"] ?? "127.0.0.1";
const PORT = Number.parseInt(process.env["SYNC_DB_PORT"] ?? "3306", 10);
const USER = process.env["SYNC_DB_USER"] ?? "root";
const PASSWORD = process.env["SYNC_DB_PASSWORD"] ?? "";
const givenDatabase = process.env["SYNC_DB_NAME"]?.trim();
const HUB_DATABASE =
  givenDatabase ?? `attendance_sync_test_${randomUUID().replace(/-/g, "").slice(0, 12)}`;

// Refuse to aim the sync at the real database, whatever the environment says.
assert.notEqual(HUB_DATABASE, "attendance", "Never test against the live attendance database.");

// Column set for direct inserts. updated_at is supplied on purpose: the 003
// migration's DEFAULT is only a placeholder for rows that existed at alter
// time; new rows are stamped by the app's write paths, and this test mimics
// the app rather than relying on the placeholder.
const STAFF_ROW = (id: string, staffNo: string, name: string, stamp: string) =>
  `INSERT INTO staff (id, staff_no, last_name, first_name, updated_at)
   VALUES ('${id}', '${staffNo}', '${name}', 'Staff', '${stamp}')`;

// createEvent() foreign-keys created_by to users, so the actor has to exist
// on the machine that makes the event, exactly as a logged-in app would have.
async function seedUser(id: string, stamp: string): Promise<void> {
  await query(
    `INSERT INTO users (id, email, password_hash, full_name, updated_at)
     VALUES (?, ?, ?, ?, ?)`,
    [
      id,
      `${id}@test.local`,
      "$2a$10$testhash000000000000000000000000000000000000000",
      "Test User",
      stamp,
    ],
  );
}

async function useMachine(file: string): Promise<void> {
  await closeDb();
  process.env["DB_FILE"] = file;
  await import("../src/server/db"); // re-registers global functions for the new handle
  getDb(); // opens + migrates the new file
}

async function localStaff(): Promise<{ id: string; lastName: string; updatedAt: string }[]> {
  return query<{ id: string; lastName: string; updatedAt: string }>(
    "SELECT id, last_name AS lastName, updated_at AS updatedAt FROM staff",
  );
}

describe("junction tables on SQLite", () => {
  // No hub needed: this is the half of sync that runs against the local engine,
  // and it is the half that was broken. `student_event_departments` and the
  // staff equivalent key on (event_id, department), so the upsert sync issues has
  // to name both columns in its conflict target. Naming only the first produced
  // "ON CONFLICT clause does not match any PRIMARY KEY or UNIQUE constraint",
  // which withCheck() reported as "Could not reach the sync database" — after
  // every other table had already been pushed.
  it("upserts a composite-key row and is a no-op the second time", async () => {
    await useMachine(fileA);
    const eventId = randomUUID();
    await query(`INSERT INTO student_events (id, title, event_date) VALUES (?, ?, ?)`, [
      eventId,
      "Junction test",
      "2026-09-28",
    ]);

    const insert = async (department: string) =>
      query(
        `INSERT INTO student_event_departments (event_id, department_code) VALUES (?, ?)
         ${dialect.upsert(["event_id", "department_code"], ["event_id", "department_code"])}`,
        [eventId, department],
      );

    await insert("CSC");
    await insert("ECO");
    // Twice more: the upsert path, not the insert path. This is what pullTable
    // does for a row the hub holds and this machine has never seen.
    await insert("CSC");
    await insert("ECO");

    const rows = await query<{ department_code: string }>(
      "SELECT department_code FROM student_event_departments WHERE event_id = ? ORDER BY department_code",
      [eventId],
    );
    assert.deepEqual(
      rows.map((r) => r.department_code),
      ["CSC", "ECO"],
      "both departments present exactly once",
    );

    // The old lookup fed the composite key to the engine as one bound value.
    // Guard the reason it could never match, so it cannot come back.
    const single = await query<{ c: number }>(
      "SELECT COUNT(*) AS c FROM student_event_departments WHERE event_id = ?",
      [`${eventId}\u0000CSC`],
    );
    assert.equal(single[0].c, 0, "a NUL-pinned composite must not be a valid lookup value");
  });
});

describe("hub sync against MariaDB", () => {
  let admin: Awaited<ReturnType<typeof createConnection>> | null = null;

  after(async () => {
    if (admin) {
      if (!givenDatabase) {
        try {
          await admin.query(`DROP DATABASE IF EXISTS \`${HUB_DATABASE}\``);
        } catch {
          // Cleanup is best-effort: a leftover throwaway database is harmless.
        }
      }
      await admin.end();
    }
    await closeHubPool();
    try {
      await closeDb();
    } catch {
      /* already closed */
    }
    fs.rmSync(dirA, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    fs.rmSync(dirB, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  });

  it("pushes machine A's rows, pulls them into B, and lets the newer edit win", async (t) => {
    try {
      admin = await createConnection({
        host: HOST,
        port: PORT,
        user: USER,
        password: PASSWORD,
        connectTimeout: 3_000,
      });
    } catch {
      t.skip(
        `MariaDB not reachable at ${HOST}:${PORT}. Configure SYNC_DB_* and run again to test sync.`,
      );
      return;
    }
    const [version] = (await admin.query("SELECT VERSION() AS v")) as [{ v: string }[], unknown];
    assert.match(version[0].v, /mariadb|mysql/i);

    if (!givenDatabase) {
      await admin.query(`CREATE DATABASE \`${HUB_DATABASE}\``);
    }
    process.env["SYNC_DB_HOST"] = HOST;
    process.env["SYNC_DB_PORT"] = String(PORT);
    process.env["SYNC_DB_USER"] = USER;
    process.env["SYNC_DB_PASSWORD"] = PASSWORD;
    process.env["SYNC_DB_NAME"] = HUB_DATABASE;

    // --- Machine A: create a staff row and an event, then sync. ------------
    await useMachine(fileA);
    const stampA = "2026-09-28 08:00:00.000";
    await seedUser("u1", stampA);
    await query(STAFF_ROW(randomUUID(), "1500", "EGBE", stampA));
    const eventA = await createEvent(
      "student",
      {
        title: "Sync test lecture",
        eventDate: "2026-09-28",
        eventCategory: "other",
        startTime: null,
        endTime: null,
        category: null,
        level: null,
        departmentCodes: null,
        notes: null,
      },
      "u1",
    );

    const firstRun = await runSync();
    assert.ok(firstRun.pushed >= 2, `expected A to push staff + event, pushed ${firstRun.pushed}`);
    assert.equal(firstRun.conflicts, 0, "a first sync has nothing to reconcile");

    const [hubEvent] = (await admin.query(
      `SELECT id, updated_at FROM \`${HUB_DATABASE}\`.student_events WHERE title = ?`,
      ["Sync test lecture"],
    )) as [{ id: string; updated_at: string }[], unknown];
    assert.equal(hubEvent[0].id, eventA.id, "the event reached the hub");

    // --- Machine B: pull, then edit locally and make the edit win. ---------
    await useMachine(fileB);
    const pulled = await runSync();
    assert.ok(pulled.pulled >= 2, `expected B to pull staff + event, pulled ${pulled.pulled}`);
    const onB = await localStaff();
    assert.equal(onB.length, 1, "the staff row crossed to B");
    assert.equal(onB[0].lastName, "EGBE");

    const editB = await updateEvent(
      "student",
      eventA.id,
      { title: "Sync test lecture (edited on B)" },
      "u1",
    );
    assert.equal(editB.title, "Sync test lecture (edited on B)");
    const secondRun = await runSync();
    assert.ok(secondRun.pushed >= 1, "B's edit should push to the hub");

    const [hubEdited] = (await admin.query(
      `SELECT title FROM \`${HUB_DATABASE}\`.student_events WHERE id = ?`,
      [eventA.id],
    )) as [{ title: string }[], unknown];
    assert.equal(hubEdited[0].title, "Sync test lecture (edited on B)");

    // --- Machine A: a plain sync must pull B's newer edit down. -----------
    await useMachine(fileA);
    const thirdRun = await runSync();
    assert.ok(thirdRun.pulled >= 1, "A should pull the edited title back");
    const [onA] = (await query<{ title: string }>("SELECT title FROM student_events WHERE id = ?", [
      eventA.id,
    ])) as { title: string }[];
    assert.equal(onA.title, "Sync test lecture (edited on B)");
    assert.equal(thirdRun.conflicts, 0, "an ordinary edit is not a conflict");

    // --- The same person under two ids must not rewrite either id. ---------
    // The hub carries a UNIQUE key on students.matric_no. A row pushed under a
    // new id but an existing matric_no used to update every column, id
    // included, which would strand the student_scans.student_id pointing at the
    // old one. It is now reported and left alone.
    //
    // The clash needs both sides to hold the same matric number under
    // different ids, so machine A puts one on the hub first.
    await useMachine(fileA);
    await query(
      `INSERT INTO students (id, matric_no, last_name, first_name, updated_at)
       VALUES (?, 'VUG/CSC/22/0001', 'Same', 'Person', ?)`,
      [randomUUID(), "2026-09-28 10:00:00.000"],
    );
    const withStudent = await runSync();
    assert.equal(withStudent.conflicts, 0, "a student nobody else holds is not a conflict");

    await useMachine(fileB);
    await query(
      `INSERT INTO students (id, matric_no, last_name, first_name, updated_at)
       VALUES (?, 'VUG/CSC/22/0001', 'Same', 'Person', ?)`,
      [randomUUID(), "2026-09-29 09:00:00.000"],
    );
    const withDuplicate = await runSync();
    assert.equal(withDuplicate.conflicts, 1, "the duplicate matric_no is reported, not merged");

    const hubRows = (await admin.query(
      `SELECT id FROM \`${HUB_DATABASE}\`.students WHERE matric_no = 'VUG/CSC/22/0001'`,
    )) as [{ id: string }[], unknown];
    assert.equal(hubRows[0].length, 1, "the hub holds one row for that matric_no");
  });
});
