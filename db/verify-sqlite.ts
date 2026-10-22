/**
 * Checks that the SQLite port behaves the way the MySQL schema and queries did.
 *
 * These are the assertions that matter, because each one is a place where the
 * two engines disagree and where getting it wrong would quietly change who is
 * counted as present:
 *   - SUBSTRING_INDEX reads the printed scan number out of a matric or staff
 *     number, and therefore decides whether a scan matches a person.
 *   - The case-insensitive collation decides whether a department name matches.
 *   - ON DELETE CASCADE decides whether deleting an event takes its scans with it.
 *   - The CHECK constraints decide whether a typo becomes a stored bad value.
 *
 * Run with: npx tsx --test db/verify-sqlite.ts
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, describe, it } from "node:test";

const file = path.join(
  fs.mkdtempSync(path.join(os.tmpdir(), "attendance-verify-")),
  "attendance.db",
);
process.env["DB_FILE"] = file;
// Both of these have to be set before db.ts is imported: the driver defaults to
// MySQL, and these assertions are about the SQLite file, not the live database.
process.env["DB_DRIVER"] = "sqlite";

const { closeDb, getDb, migrate, query, queryOne, transaction } = await import("../src/server/db");
const { createEvent, setEventStatus, updateEvent } = await import("../src/server/events");

/** A student event to edit, created through the same path the app uses. */
async function makeEvent(overrides: Record<string, unknown> = {}) {
  return createEvent(
    "student",
    {
      title: "CSC 200 lecture",
      eventDate: "2026-09-26",
      eventCategory: "other",
      startTime: null,
      endTime: null,
      category: null,
      level: null,
      departmentCodes: null,
      notes: null,
      ...overrides,
    },
    "u1",
  );
}

async function departmentsOf(eventId: string): Promise<string[]> {
  const rows = await query<{ department_code: string }>(
    "SELECT department_code FROM student_event_departments WHERE event_id = ? ORDER BY department_code",
    [eventId],
  );
  return rows.map((row) => row.department_code);
}

after(async () => {
  try {
    await closeDb();
  } catch {
    /* already closed */
  }
  fs.rmSync(path.dirname(file), { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
});

describe("migrations", () => {
  it("creates every table the app uses, and records the version", () => {
    const result = migrate();
    // Every file, in name order. Each numbered migration moved the version.
    assert.deepEqual(result.applied, [
      "001_initial.sql",
      "002_staff_presence_overrides.sql",
      "003_sync_metadata.sql",
      "004_recurring_template_stamps.sql",
      "005_weekly_mass.sql",
      "006_student_department_marital.sql",
      "007_seed_mass_weekdays.sql",
    ]);
    assert.equal(result.version, 7);

    const tables = (
      getDb()
        .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'")
        .all() as {
        name: string;
      }[]
    )
      .map((r) => r.name)
      .sort();

    assert.deepEqual(tables, [
      "audit_logs",
      "mass_department_weekdays",
      "mass_expected",
      "mass_scans",
      "mass_uploads",
      "mass_week_weekdays",
      "mass_weeks",
      "profiles",
      "recurring_schedule_departments",
      "recurring_schedules",
      "recurring_templates",
      "staff",
      "staff_event_departments",
      "staff_event_uploads",
      "staff_events",
      "staff_presence_overrides",
      "staff_scans",
      "student_event_departments",
      "student_event_uploads",
      "student_events",
      "student_scans",
      "students",
      "sync_log",
      "sync_meta",
      "user_roles",
      "users",
    ]);
  });

  it("keeps the registrar's department name and marital status on the students table", () => {
    // Both are stored as written. The department is what every scope uses; the
    // marital status drives the Sunday Mass rule.
    getDb()
      .prepare(
        "INSERT INTO students (id, matric_no, department, marital_status) VALUES ('stc1','VUG/CEG/26/1','Computer Engineering','Religious')",
      )
      .run();
    const row = getDb()
      .prepare("SELECT department, marital_status FROM students WHERE id = 'stc1'")
      .get() as { department: string; marital_status: string };
    assert.equal(row.department, "Computer Engineering");
    assert.equal(row.marital_status, "Religious");
  });

  it("is not applied twice, so a second run is a no-op", () => {
    const result = migrate();
    assert.deepEqual(result.applied, []);
    assert.equal(result.version, 7);
  });

  it("seeds every staff department with one weekday assignment", () => {
    // The seed is what makes the staff snapshot resolve. One row per roster
    // department, and a department an administrator adds later is simply
    // extra -- the seed neither forbids nor duplicates it.
    const rows = getDb()
      .prepare(
        "SELECT department_code, day_of_week FROM mass_department_weekdays ORDER BY department_code",
      )
      .all() as { department_code: string; day_of_week: number }[];
    assert.ok(rows.length >= 63, `expected at least 63 seeded departments, got ${rows.length}`);
    const codes = new Set(rows.map((r) => r.department_code));
    assert.equal(codes.size, rows.length, "a department must have exactly one weekday");
    assert.ok(
      rows.every((r) => r.day_of_week >= 1 && r.day_of_week <= 5),
      "every seeded weekday is Monday to Friday",
    );
  });

  it("keeps the four committed weekday artifacts in step with each other", () => {
    // The same list is written in four places, because each is read by a
    // different thing: the SQLite migration, the MySQL schema, the TypeScript
    // the app imports, and the JSON a script reads. They have to say the same
    // thing, or a department is expected on a day in one engine and another in
    // the other.
    const read = (relative: string): string =>
      fs.readFileSync(path.join(import.meta.dirname, relative), "utf8");

    const asPairs = (rows: Array<[string, number]>): string =>
      JSON.stringify([...rows].sort((a, b) => a[0].localeCompare(b[0])));

    const fromTypeScript = [
      ...read("seed/mass-weekday-departments.ts").matchAll(
        /department: "([^"]+)", dayOfWeek: (\d+)/g,
      ),
    ].map((m) => [m[1] as string, Number(m[2])] as [string, number]);

    const fromJson = (
      JSON.parse(read("seed/mass-weekday-departments.json")) as Array<{
        department: string;
        dayOfWeek: number;
      }>
    ).map((r) => [r.department, r.dayOfWeek] as [string, number]);

    const fromMigration = [
      ...read("migrations/007_seed_mass_weekdays.sql").matchAll(
        /VALUES \('[^']+', '([^']+)', (\d),/g,
      ),
    ].map((m) => [m[1] as string, Number(m[2])] as [string, number]);

    const fromSchema = [
      ...read("schema.sql").matchAll(/SELECT '[^']+', '([^']+)', (\d), 1 FROM DUAL/g),
    ].map((m) => [m[1] as string, Number(m[2])] as [string, number]);

    assert.equal(fromTypeScript.length, 64, "the committed list should have 64 departments");
    assert.equal(asPairs(fromJson), asPairs(fromTypeScript), "the JSON and the TypeScript differ");
    assert.equal(asPairs(fromMigration), asPairs(fromTypeScript), "the SQLite migration differs");
    assert.equal(asPairs(fromSchema), asPairs(fromTypeScript), "the MySQL schema differs");

    // And the database that was just migrated holds the same list.
    const rows = getDb()
      .prepare(
        "SELECT department_code, day_of_week FROM mass_department_weekdays ORDER BY department_code",
      )
      .all() as { department_code: string; day_of_week: number }[];
    assert.equal(
      asPairs(rows.map((r) => [r.department_code, r.day_of_week] as [string, number])),
      asPairs(fromTypeScript),
      "the migrated database differs from the committed list",
    );

    // "Performing Arts" is the one the roster does not list, so it is the one
    // that can silently go missing; it is on Tuesday, like the live database.
    const performingArts = fromTypeScript.find(([name]) => name === "Performing Arts");
    assert.deepEqual(performingArts, ["Performing Arts", 2]);
  });
});

describe("SUBSTRING_INDEX", () => {
  // The expected values are MySQL's, not SQLite's, because the point is that
  // the derivation in masters.ts did not change meaning.
  const cases: [string, string, number, string][] = [
    ["www.mysql.com", ".", 2, "www.mysql"],
    ["www.mysql.com", ".", -2, "mysql.com"],
    ["www.mysql.com", ".", 1, "www"],
    ["www.mysql.com", ".", -1, "com"],
    ["www.mysql.com", ".", 0, ""],
    ["a/b/c", "/", 5, "a/b/c"],
    ["a/b/c", "/", -5, "a/b/c"],
    ["VUG/CSC/18/2633", "/", 2, "VUG/CSC"],
    ["VUG/CSC/18/2633", "/", -1, "2633"],
    ["VUG/PGD/ECO/15/1042", "/", 3, "VUG/PGD/ECO"],
  ];

  for (const [input, delimiter, position, expected] of cases) {
    it(`SUBSTRING_INDEX('${input}', '${delimiter}', ${position}) = '${expected}'`, () => {
      const row = getDb()
        .prepare("SELECT SUBSTRING_INDEX(?, ?, ?) AS v")
        .get(input, delimiter, position) as { v: string };
      assert.equal(row.v, expected);
    });
  }

  it("returns the whole string when the delimiter is absent", () => {
    const row = getDb().prepare("SELECT SUBSTRING_INDEX('VUG', '/', 2) AS v").get() as {
      v: string;
    };
    assert.equal(row.v, "VUG");
  });
});

describe("REGEXP_REPLACE", () => {
  it("takes the digits out of a staff number, as staffScanNumberSql needs", () => {
    const row = getDb()
      .prepare("SELECT NULLIF(REGEXP_REPLACE('SA 1188', '[^0-9]', ''), '') AS v")
      .get() as { v: string };
    assert.equal(row.v, "1188");
  });

  it("replaces every occurrence, not just the first", () => {
    const row = getDb().prepare("SELECT REGEXP_REPLACE('a1b2c3', '[0-9]', '') AS v").get() as {
      v: string;
    };
    assert.equal(row.v, "abc");
  });

  it("yields NULL for a staff number with no digits, as MySQL did", () => {
    const row = getDb()
      .prepare("SELECT NULLIF(REGEXP_REPLACE('ADMIN', '[^0-9]', ''), '') AS v")
      .get() as { v: string | null };
    assert.equal(row.v, null);
  });

  it("reads `0-9` as a range, not as the three characters 0, - and 9", () => {
    // The mistake here is invisible in the common case: `new Set("0-9")` is
    // {'0', '-', '9'}, so a negated class deletes nothing and an ordinary one
    // deletes nothing either, and every staff number keeps its letters.
    const keepDigits = getDb()
      .prepare("SELECT REGEXP_REPLACE('SA 1188', '[^0-9]', '') AS v")
      .get() as { v: string };
    assert.equal(keepDigits.v, "1188", "only the non-digits should be removed");

    const dropDigits = getDb().prepare("SELECT REGEXP_REPLACE('1188', '[0-9]', '') AS v").get() as {
      v: string;
    };
    assert.equal(dropDigits.v, "", "the digits themselves should be removed");
  });

  it("leaves a leading zero in a staff number's digits, as the machine prints it", () => {
    const row = getDb().prepare("SELECT REGEXP_REPLACE('SA 063', '[^0-9]', '') AS v").get() as {
      v: string;
    };
    assert.equal(row.v, "063", "063 and 63 are the same number written two ways");
  });
});

describe("case-insensitive text", () => {
  it("treats an email that differs only in case as the same account", async () => {
    await query("INSERT INTO users (id, email, password_hash) VALUES (?, ?, ?)", [
      "u1",
      "Admin@Attendance.Test",
      "x",
    ]);
    await assert.rejects(
      () =>
        query("INSERT INTO users (id, email, password_hash) VALUES (?, ?, ?)", [
          "u2",
          "admin@attendance.test",
          "x",
        ]),
      /UNIQUE/,
    );
  });

  it("matches a staff department regardless of case, which reports.ts relies on", async () => {
    getDb()
      .prepare("INSERT INTO staff (id, staff_no, last_name, department) VALUES (?, ?, ?, ?)")
      .run("s1", "SA 1", "Doe", "Accounting");
    const exact = await queryOne<{ n: number }>(
      "SELECT COUNT(*) AS n FROM staff WHERE department = 'Accounting'",
    );
    const lower = await queryOne<{ n: number }>(
      "SELECT COUNT(*) AS n FROM staff WHERE department = 'accounting'",
    );
    assert.equal(exact?.n, 1);
    assert.equal(
      lower?.n,
      1,
      "a report filtering on 'accounting' must find staff recorded as 'Accounting'",
    );
  });
});

describe("constraints", () => {
  it("refuses audit details that are not JSON, as MariaDB does", () => {
    // The rule is only worth having if json_valid() is actually there, which
    // depends on the JSON functions being compiled into the bundled SQLite.
    assert.throws(
      () =>
        getDb()
          .prepare(
            "INSERT INTO audit_logs (id, action, entity, details) VALUES ('a1','x','y','not json')",
          )
          .run(),
      /CHECK/,
      "a details column that is not JSON has to be refused, or the two engines accept different rows",
    );
  });

  it("accepts audit details that are JSON, and none at all", () => {
    getDb()
      .prepare(
        "INSERT INTO audit_logs (id, action, entity, details) VALUES ('a2','x','y','{\"rows\":3}')",
      )
      .run();
    // A log row with no details is normal, so the rule has to let it past
    // rather than doing so by accident.
    getDb().prepare("INSERT INTO audit_logs (id, action, entity) VALUES ('a3','x','y')").run();
    const stored = getDb().prepare("SELECT COUNT(*) AS n FROM audit_logs").get() as
      { n: number } | undefined;
    assert.equal(stored?.n, 2);
  });

  it("refuses a role that is not one of the three", () => {
    assert.throws(
      () =>
        getDb()
          .prepare("INSERT INTO user_roles (id, user_id, role) VALUES (?, ?, ?)")
          .run("r1", "u1", "superuser"),
      /CHECK/,
    );
  });

  it("refuses a match_method outside the three the scanner produces", () => {
    assert.throws(() => {
      getDb()
        .prepare(
          "INSERT INTO student_events (id, title, event_date) VALUES ('e1', 't', '2026-09-26')",
        )
        .run();
      getDb()
        .prepare(
          "INSERT INTO student_scans (id, event_id, upload_id, scanned_at, match_method) VALUES ('sc1','e1','up1','2026-09-26 08:00:00','maybe')",
        )
        .run();
    }, /CHECK/);
  });

  it("refuses a day_of_week outside 0-6", () => {
    getDb()
      .prepare(
        "INSERT INTO recurring_templates (id, name, start_date, end_date, event_title_template) VALUES ('t1','n','2026-09-01','2026-09-30','x')",
      )
      .run();
    assert.throws(
      () =>
        getDb()
          .prepare(
            "INSERT INTO recurring_schedules (id, template_id, day_of_week) VALUES ('rs1','t1',7)",
          )
          .run(),
      /CHECK/,
    );
  });
});

describe("deleting an event", () => {
  it("takes its uploads, scans and department rows with it, as the code assumes", () => {
    getDb()
      .prepare("INSERT INTO student_events (id, title, event_date) VALUES ('e2','t','2026-09-26')")
      .run();
    getDb()
      .prepare(
        "INSERT INTO student_event_uploads (id, event_id, file_name) VALUES ('up2','e2','f.csv')",
      )
      .run();
    getDb()
      .prepare(
        "INSERT INTO student_scans (id, event_id, upload_id, scanned_at) VALUES ('sc2','e2','up2','2026-09-26 08:00:00')",
      )
      .run();
    getDb()
      .prepare(
        "INSERT INTO student_event_departments (event_id, department_code) VALUES ('e2','CSC')",
      )
      .run();

    // This is deleteEvent()'s only statement; the children go because of cascade.
    getDb().prepare("DELETE FROM student_events WHERE id = 'e2'").run();

    for (const table of ["student_event_uploads", "student_scans", "student_event_departments"]) {
      const left = getDb().prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number };
      assert.equal(left.n, 0, `${table} should have been cascaded away`);
    }
  });

  it("leaves a scan's student in place when the event goes", async () => {
    await query("INSERT INTO students (id, matric_no) VALUES ('st1','VUG/CSC/18/1')");
    getDb()
      .prepare("INSERT INTO student_events (id, title, event_date) VALUES ('e3','t','2026-09-26')")
      .run();
    getDb()
      .prepare(
        "INSERT INTO student_event_uploads (id, event_id, file_name) VALUES ('up3','e3','f.csv')",
      )
      .run();
    getDb()
      .prepare(
        "INSERT INTO student_scans (id, event_id, upload_id, scanned_at, student_id, match_method, in_scope) VALUES ('sc3','e3','up3','2026-09-26 08:00:00','st1','number',1)",
      )
      .run();

    getDb().prepare("DELETE FROM student_events WHERE id = 'e3'").run();

    const student = await queryOne<{ n: number }>(
      "SELECT COUNT(*) AS n FROM students WHERE id = 'st1'",
    );
    assert.equal(
      student?.n,
      1,
      "the master list must not lose anybody because an event was deleted",
    );
  });
});

describe("editing an event", () => {
  it("changes only the fields it was given, leaving the rest alone", async () => {
    const event = await makeEvent({
      title: "CSC 200 lecture",
      notes: "hall B",
      level: "200",
      departmentCodes: ["CSC"],
    });
    const edited = await updateEvent(
      "student",
      event.id,
      { title: "CSC 200 lecture (moved)" },
      "u1",
    );

    assert.equal(edited.title, "CSC 200 lecture (moved)");
    assert.equal(edited.notes, "hall B", "a field that was not sent must not be blanked");
    assert.equal(edited.level, "200");
    assert.equal(edited.event_date, "2026-09-26");
    assert.deepEqual(edited.departments, ["CSC"]);
  });

  it("replaces the department list rather than adding to it", async () => {
    // Keeping a department the form no longer shows would go on expecting
    // people who are no longer in scope, which is the whole point of editing.
    const event = await makeEvent({ departmentCodes: ["CSC", "ENG"] });
    assert.deepEqual(await departmentsOf(event.id), ["CSC", "ENG"]);

    await updateEvent("student", event.id, { departmentCodes: ["ENG"] }, "u1");
    assert.deepEqual(await departmentsOf(event.id), ["ENG"]);

    await updateEvent("student", event.id, { departmentCodes: [] }, "u1");
    assert.deepEqual(
      await departmentsOf(event.id),
      [],
      "clearing the list must mean everyone, not everybody who was there before",
    );
  });

  it("keeps the first department in the column labels and exports read from", async () => {
    const event = await makeEvent({ departmentCodes: ["CSC", "ENG"] });
    const edited = await updateEvent(
      "student",
      event.id,
      { departmentCodes: ["ENG", "CSC"] },
      "u1",
    );
    assert.equal(edited.department_code, edited.departments[0]);
  });

  it("does not touch the status, so an edit cannot sign an event off by accident", async () => {
    const event = await makeEvent();
    await setEventStatus("student", event.id, "finalized");
    const edited = await updateEvent("student", event.id, { title: "Renamed" }, "u1");
    assert.equal(edited.status, "finalized");
  });

  it("moves a finalized event back to draft and clears finalized_at", async () => {
    const event = await makeEvent();
    const finalized = await setEventStatus("student", event.id, "finalized");
    assert.ok(finalized.id);

    const reopened = await setEventStatus("student", event.id, "draft");
    assert.equal(reopened.status, "draft");
    const row = await queryOne<{ finalized_at: string | null }>(
      "SELECT finalized_at FROM student_events WHERE id = ?",
      [event.id],
    );
    assert.equal(
      row?.finalized_at,
      null,
      "a reopened event is not settled, so it must not keep a sign-off time",
    );
  });

  it("refuses a category the schema does not have", async () => {
    const event = await makeEvent();
    await assert.rejects(
      () => updateEvent("student", event.id, { eventCategory: "seminar" as never }, "u1"),
      /CHECK/,
    );
  });

  it("records who changed the event", async () => {
    const event = await makeEvent();
    await updateEvent("student", event.id, { notes: "moved to hall C" }, "u1");
    const audit = await queryOne<{ n: number }>(
      "SELECT COUNT(*) AS n FROM audit_logs WHERE entity_id = ? AND action = 'student_event.updated'",
      [event.id],
    );
    assert.equal(audit?.n, 1, "an edit that changed the event has to be traceable");
  });
});

describe("transactions", () => {
  it("rolls back and leaves nothing behind when the work throws", async () => {
    await assert.rejects(() =>
      transaction(async (conn) => {
        await conn.execute("INSERT INTO students (id, matric_no) VALUES (?, ?)", [
          "st2",
          "VUG/CSC/18/2",
        ]);
        throw new Error("deliberate");
      }),
    );
    const left = await queryOne<{ n: number }>(
      "SELECT COUNT(*) AS n FROM students WHERE matric_no = 'VUG/CSC/18/2'",
    );
    assert.equal(left?.n, 0);
  });

  it("commits when the work returns", async () => {
    await transaction(async (conn) => {
      await conn.execute("INSERT INTO students (id, matric_no) VALUES (?, ?)", [
        "st3",
        "VUG/CSC/18/3",
      ]);
    });
    const left = await queryOne<{ n: number }>(
      "SELECT COUNT(*) AS n FROM students WHERE matric_no = 'VUG/CSC/18/3'",
    );
    assert.equal(left?.n, 1);
  });

  it("keeps two concurrent write transactions from interleaving", async () => {
    // The MySQL version gave each transaction its own pooled connection. With
    // one shared handle, an interleaved COMMIT would commit half of the other
    // transaction's work, so writes are queued. This checks the queue holds.
    const first = transaction(async (conn) => {
      await conn.execute("INSERT INTO students (id, matric_no) VALUES (?, ?)", [
        "st4",
        "VUG/CSC/18/4",
      ]);
      await new Promise((resolve) => setTimeout(resolve, 20));
      throw new Error("first fails after the second was queued");
    });
    const second = transaction(async (conn) => {
      await conn.execute("INSERT INTO students (id, matric_no) VALUES (?, ?)", [
        "st5",
        "VUG/CSC/18/5",
      ]);
    });

    await assert.rejects(() => first);
    await second;

    const four = await queryOne<{ n: number }>(
      "SELECT COUNT(*) AS n FROM students WHERE matric_no = 'VUG/CSC/18/4'",
    );
    const five = await queryOne<{ n: number }>(
      "SELECT COUNT(*) AS n FROM students WHERE matric_no = 'VUG/CSC/18/5'",
    );
    assert.equal(four?.n, 0, "the failed transaction left nothing");
    assert.equal(five?.n, 1, "the queued transaction still committed");
  });
});

describe("parameter binding", () => {
  it("stores a boolean as 0/1 the way a TINYINT(1) did", async () => {
    getDb()
      .prepare("INSERT INTO student_events (id, title, event_date) VALUES ('e5','t','2026-09-26')")
      .run();
    getDb()
      .prepare(
        "INSERT INTO student_event_uploads (id, event_id, file_name) VALUES ('up5','e5','f.csv')",
      )
      .run();
    await query(
      "INSERT INTO student_scans (id, event_id, upload_id, scanned_at, in_scope, outside_window) VALUES (?,?,?,?,?,?)",
      ["sc5", "e5", "up5", "2026-09-26 08:00:00", true, false],
    );
    const row = await queryOne<{ in_scope: number; outside_window: number }>(
      "SELECT in_scope, outside_window FROM student_scans WHERE id = 'sc5'",
    );
    assert.equal(row?.in_scope, 1);
    assert.equal(row?.outside_window, 0);
  });

  it("stores a Date as the UTC text the DATETIME columns expect", async () => {
    getDb()
      .prepare("INSERT INTO student_events (id, title, event_date) VALUES ('e6','t','2026-09-26')")
      .run();
    getDb()
      .prepare(
        "INSERT INTO student_event_uploads (id, event_id, file_name) VALUES ('up6','e6','f.csv')",
      )
      .run();
    await query(
      "INSERT INTO student_scans (id, event_id, upload_id, scanned_at) VALUES (?,?,?,?)",
      ["sc6", "e6", "up6", new Date("2026-09-26T08:00:00.000Z")],
    );
    const row = await queryOne<{ scanned_at: string }>(
      "SELECT scanned_at FROM student_scans WHERE id = 'sc6'",
    );
    assert.equal(row?.scanned_at, "2026-09-26 08:00:00.000");
  });
});

describe("event dates survive both drivers", () => {
  it("keeps a plain SQLite text date as it is", async () => {
    const { isoDate } = await import("../src/server/downloads");
    assert.equal(isoDate("2026-09-28"), "2026-09-28");
  });

  it("drops the time part SQLite stores on a DATE column", async () => {
    const { isoDate } = await import("../src/server/downloads");
    // What SQLite actually returns: text with a time, not a bare day.
    assert.equal(isoDate("2026-09-28 00:00:00"), "2026-09-28");
  });

  it("narrows the Date that mysql2 hands back to a readable day", async () => {
    const { isoDate } = await import("../src/server/downloads");
    // What mysql2 actually returns for a DATE column: local midnight, as a Date.
    // Left alone, toCsv would String() this into
    // "Mon Sep 28 2026 00:00:00 GMT+0100 (Coordinated Universal Time)".
    const fromMysql = new Date(2026, 8, 28);
    assert.equal(isoDate(fromMysql), "2026-09-28");
    assert.doesNotMatch(isoDate(fromMysql), /GMT|Coordinated|\(.*\)$/);
  });

  it("reads the date with local getters, so the day cannot slip backwards", async () => {
    const { isoDate } = await import("../src/server/downloads");
    // The 1st is the case that breaks if someone "fixes" this with toISOString,
    // which would turn local midnight into the previous day west of Greenwich.
    assert.equal(isoDate(new Date(2026, 0, 1)), "2026-01-01");
    assert.equal(isoDate(new Date(2026, 11, 31)), "2026-12-31");
  });

  it("agrees on the day whichever driver it was handed", async () => {
    const { isoDate } = await import("../src/server/downloads");
    // The whole point: the CSV must not depend on which engine is behind it.
    assert.equal(isoDate("2026-09-28 00:00:00"), isoDate(new Date(2026, 8, 28)));
  });

  it("yields an empty cell rather than 'Invalid Date'", async () => {
    const { isoDate } = await import("../src/server/downloads");
    assert.equal(isoDate(new Date("not a date")), "");
    assert.equal(isoDate("rubbish"), "");
  });
});
