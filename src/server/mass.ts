// Weekly Community Mass: department-to-weekday assignments, weekly records,
// expected-population snapshots and upload processing.
//
// The existing event system answers "did this person scan at an event whose
// scope they fell inside". Weekly Mass asks a different question: "of the
// people who were expected at Week N's Mass -- undergraduates whose department
// is assigned to one of the weekdays selected for Week N -- who attended, who
// missed it, who scanned but was outside that population, and which machine
// rows could not be matched at all". It is answered with its own tables
// (migration 005) so that nothing about the event system changes.
//
// Two rules hold everywhere in this file:
//
//   * The expected population is frozen. The first time a week and participant
//     type is processed, everyone eligible is written to mass_expected with
//     their number, name, level and department as they were at that moment.
//     Reports read the snapshot, never the live master list, so a re-import of
//     the registrar's file or a change to the weekday assignments cannot
//     rewrite what a past week said. Resetting the scope is explicit.
//   * All arithmetic is on unique people. Present is a set of person ids, not
//     a row count: duplicate rows and repeat uploads cannot inflate it, and
//     Absent = Expected − Present is computed on the same ids. Out-of-scope
//     and unmatched rows are never folded into absent.

import { randomUUID } from "node:crypto";
import type { RowDataPacket } from "./db";
import { query, queryOne, transaction, utcStamp, type SqlParam } from "@/server/db";
import { GROUPS, loadLookup, matchRow } from "@/server/events";
import {
  staffDepartmentSql,
  staffNameSql,
  staffScanNumberSql,
  studentCategorySql,
  studentDepartmentSql,
  studentNameSql,
  studentScanNumberSql,
} from "@/server/masters";
import { parseScanTime, percent } from "@/lib/attendance";
import { loadIdentity, type Identity } from "@/server/identity";
import { HttpError } from "@/server/http";
import type {
  MassExpectedRow,
  MassOutOfScopeRow,
  MassPresentRow,
  MassResult,
  MassSummary,
  MassUnmatchedRow,
  MassUpload,
  MassUploadInput,
  MassWeek,
  MassWeekdayAssignment,
  MassWeekStatus,
  MassWeekParticipantType,
  MassScope,
  MassUploadParticipant,
} from "@/lib/types";

const INSERT_CHUNK = 400;

type AssignmentRow = RowDataPacket & {
  id: string;
  department_code: string;
  day_of_week: number;
  is_active: number;
  created_at: string | Date;
  updated_at: string | Date;
};

type WeekRow = RowDataPacket & {
  id: string;
  name: string;
  notes: string | null;
  scope: MassScope;
  participant_type: MassWeekParticipantType;
  status: MassWeekStatus;
  created_by: string | null;
  created_at: string | Date;
  updated_at: string | Date;
};

type CountRow = RowDataPacket & { total: number };

type SnapshotQueryRow = RowDataPacket & {
  id: string;
  matric_no?: string | null;
  staff_no?: string | null;
  full_name: string | null;
  level: string | null;
  department: string | null;
};

type ExpectedQueryRow = RowDataPacket & {
  person_id: string;
  person_no: string | null;
  full_name: string | null;
  level: string | null;
  department: string | null;
  day_of_week: number | null;
};

type UploadRow = RowDataPacket & {
  id: string;
  mass_week_id: string;
  participant_type: MassUploadParticipant;
  level: string | null;
  file_name: string;
  label: string | null;
  row_count: number;
  present_count: number;
  out_of_scope_count: number;
  unmatched_count: number;
  uploaded_by: string | null;
  uploaded_at: string | Date;
};

function placeholders(rows: number, columns = 1): string {
  return Array.from(
    { length: rows },
    () => `(${new Array<string>(columns).fill("?").join(",")})`,
  ).join(",");
}

function toIso(value: unknown): string | null {
  if (value == null) return null;
  if (value instanceof Date) return value.toISOString();
  return String(value);
}

async function audit(
  actorId: string,
  action: string,
  entity: string,
  entityId: string | null,
  details: unknown,
): Promise<void> {
  await query(
    "INSERT INTO audit_logs (id, actor_id, action, entity, entity_id, details) VALUES (?, ?, ?, ?, ?, ?)",
    [randomUUID(), actorId, action, entity, entityId, JSON.stringify(details)],
  );
}

// Weekday assignments --------------------------------------------------------

/** Clean a request body's weekday value: one integer, 1=Mon .. 5=Fri. */
export function parseWeekday(value: unknown): number {
  const day = Number(value);
  if (!Number.isInteger(day) || day < 1 || day > 5) {
    throw new HttpError(400, "Choose a weekday from Monday to Friday (1 to 5).");
  }
  return day;
}

/** Clean a list of weekdays: unique integers, 1..5, sorted. */
export function parseWeekdays(values: unknown): number[] {
  const list = Array.isArray(values) ? values : [];
  const days = [...new Set(list.map((value) => Number(value)))].filter(
    (day) => Number.isInteger(day) && day >= 1 && day <= 5,
  );
  days.sort((a, b) => a - b);
  return days;
}

function mapAssignment(row: AssignmentRow): MassWeekdayAssignment {
  return {
    id: row.id,
    department_code: row.department_code,
    day_of_week: Number(row.day_of_week),
    is_active: Number(row.is_active) === 1,
    created_at: toIso(row.created_at) ?? "",
    updated_at: toIso(row.updated_at) ?? "",
  };
}

export async function listWeekdayAssignments(): Promise<MassWeekdayAssignment[]> {
  const rows = await query<AssignmentRow>(
    `SELECT id, department_code, day_of_week, is_active, created_at, updated_at
       FROM mass_department_weekdays ORDER BY day_of_week, department_code`,
  );
  return rows.map(mapAssignment);
}

/**
 * Every department that has a weekday, with the day it sits on.
 *
 * This is the list a picker should offer when a person is moved to another
 * department: a department with no weekday would never be expected at Community
 * Mass, so choosing it would quietly move somebody out of the expectation
 * altogether. The name is the department's own full name, the same text the
 * master list stores, so the two can be compared without translating between
 * codes and names.
 */
export async function listMassDepartments(): Promise<Array<{ department: string; day: number }>> {
  const rows = await query<RowDataPacket & { department: string; day: number }>(
    `SELECT DISTINCT department_code AS department, day_of_week AS day
       FROM mass_department_weekdays
       WHERE is_active = 1 AND department_code IS NOT NULL
       ORDER BY day_of_week, department_code`,
  );
  return rows.map((row) => ({ department: row.department, day: Number(row.day) }));
}

/**
 * Point a department at a weekday. One row per department, so re-assigning
 * moves the department rather than adding a second home: a department with two
 * expected weekdays would make its students expected twice over.
 */
export async function upsertWeekdayAssignment(
  departmentCode: string,
  dayOfWeek: unknown,
  actorId: string,
): Promise<MassWeekdayAssignment> {
  const code = departmentCode.trim();
  if (!code) throw new HttpError(400, "Choose a department.");
  const day = parseWeekday(dayOfWeek);

  const existing = await queryOne<RowDataPacket & { id: string }>(
    "SELECT id FROM mass_department_weekdays WHERE department_code = ?",
    [code],
  );
  const stamp = utcStamp();
  if (existing) {
    await query(
      `UPDATE mass_department_weekdays
          SET day_of_week = ?, is_active = 1, updated_at = ? WHERE id = ?`,
      [day, stamp, existing.id],
    );
    await audit(actorId, "mass_weekday.assigned", "mass_department_weekdays", existing.id, {
      departmentCode: code,
      dayOfWeek: day,
    });
    const updated = await queryOne<AssignmentRow>(
      `SELECT id, department_code, day_of_week, is_active, created_at, updated_at
         FROM mass_department_weekdays WHERE id = ?`,
      [existing.id],
    );
    return mapAssignment(updated!);
  }
  const id = randomUUID();
  await query(
    `INSERT INTO mass_department_weekdays
       (id, department_code, day_of_week, is_active, created_by, created_at, updated_at)
     VALUES (?, ?, ?, 1, ?, ?, ?)`,
    [id, code, day, actorId, stamp, stamp],
  );
  await audit(actorId, "mass_weekday.assigned", "mass_department_weekdays", id, {
    departmentCode: code,
    dayOfWeek: day,
  });
  return {
    id,
    department_code: code,
    day_of_week: day,
    is_active: true,
    created_at: stamp,
    updated_at: stamp,
  };
}

export async function setWeekdayAssignmentActive(
  assignmentId: string,
  active: boolean,
  actorId: string,
): Promise<void> {
  const found = await queryOne<RowDataPacket & { id: string }>(
    "SELECT id FROM mass_department_weekdays WHERE id = ?",
    [assignmentId],
  );
  if (!found) throw new HttpError(404, "That department assignment no longer exists.");
  await query("UPDATE mass_department_weekdays SET is_active = ?, updated_at = ? WHERE id = ?", [
    active ? 1 : 0,
    utcStamp(),
    assignmentId,
  ]);
  await audit(
    actorId,
    active ? "mass_weekday.activated" : "mass_weekday.deactivated",
    "mass_department_weekdays",
    assignmentId,
    { active },
  );
}

export async function deleteWeekdayAssignment(
  assignmentId: string,
  actorId: string,
): Promise<void> {
  const found = await queryOne<RowDataPacket & { department_code: string }>(
    "SELECT department_code FROM mass_department_weekdays WHERE id = ?",
    [assignmentId],
  );
  if (!found) throw new HttpError(404, "That department assignment no longer exists.");
  await query("DELETE FROM mass_department_weekdays WHERE id = ?", [assignmentId]);
  await audit(actorId, "mass_weekday.removed", "mass_department_weekdays", assignmentId, {
    departmentCode: found.department_code,
  });
}

/**
 * Ensure every department that appears in the live staff or student roster has
 * a row in mass_department_weekdays. Departments already present are untouched
 * (an administrator may have moved them). New departments are assigned to the
 * next free weekday (Mon=1..Fri=5, cycling), so they immediately become expected
 * at Community Mass.
 *
 * Called automatically after staff or student import and when a person's
 * department changes. Also exposed as a manual "Sync Weekdays" action for
 * administrators.
 */
export async function syncMassWeekdays(actorId: string): Promise<{
  added: number;
  skipped: number;
  departments: Array<{ department: string; day: number }>;
}> {
  const stamp = utcStamp();

  // Every distinct department on either master list, staff first so its
  // spelling wins when a student record uses a different case.
  const [staffDepts, studentDepts] = await Promise.all([
    query<RowDataPacket & { department: string }>(
      `SELECT DISTINCT ${staffDepartmentSql("f")} AS department
         FROM staff f
         WHERE ${staffDepartmentSql("f")} IS NOT NULL
         ORDER BY department`,
    ),
    query<RowDataPacket & { department: string }>(
      `SELECT DISTINCT ${studentDepartmentSql("s")} AS department
         FROM students s
         WHERE ${studentDepartmentSql("s")} IS NOT NULL
         ORDER BY department`,
    ),
  ]);
  const departmentNames: string[] = [];
  const seenDepartments = new Set<string>();
  for (const row of [...staffDepts, ...studentDepts]) {
    const dept = row.department?.trim();
    if (!dept) continue;
    const key = dept.toLowerCase();
    if (seenDepartments.has(key)) continue;
    seenDepartments.add(key);
    departmentNames.push(dept);
  }

  // Existing assignments. Inactive rows still count as "already present" so a
  // sync cannot insert a duplicate department and fail the unique index.
  const existing = await query<
    RowDataPacket & { department_code: string; day_of_week: number; is_active: number }
  >("SELECT department_code, day_of_week, is_active FROM mass_department_weekdays");
  const existingByDept = new Map(
    existing.map((r) => [r.department_code.trim().toLowerCase(), Number(r.day_of_week)]),
  );

  // Prefer an unused weekday, then keep cycling so a sixth department cannot
  // spin forever looking for a day that does not exist.
  const usedDays = new Set(
    existing.filter((row) => Number(row.is_active) === 1).map((row) => Number(row.day_of_week)),
  );
  let nextDay = 1;
  const takeDay = (): number => {
    if (usedDays.size < 5) {
      while (usedDays.has(nextDay)) nextDay = (nextDay % 5) + 1;
    }
    const day = nextDay;
    usedDays.add(day);
    nextDay = (nextDay % 5) + 1;
    return day;
  };

  const added: Array<{ department: string; day: number }> = [];
  let skipped = 0;

  await transaction(async (connection) => {
    for (const dept of departmentNames) {
      const key = dept.toLowerCase();
      if (existingByDept.has(key)) {
        skipped++;
        continue;
      }
      const day = takeDay();
      const id = randomUUID();
      await connection.execute(
        `INSERT INTO mass_department_weekdays (id, department_code, day_of_week, is_active, created_by, created_at, updated_at)
         VALUES (?, ?, ?, 1, ?, ?, ?)`,
        [id, dept, day, actorId, stamp, stamp],
      );
      await audit(actorId, "mass_weekday.synced", "mass_department_weekdays", id, {
        departmentCode: dept,
        dayOfWeek: day,
      });
      added.push({ department: dept, day });
      existingByDept.set(key, day);
    }
  });

  return { added: added.length, skipped, departments: added };
}

// Weeks ----------------------------------------------------------------------

function mapWeek(row: WeekRow, weekdays: number[]): MassWeek {
  return {
    id: row.id,
    name: row.name,
    notes: row.notes ?? null,
    scope: row.scope,
    participant_type: row.participant_type,
    status: row.status,
    weekdays,
    created_by: row.created_by ?? null,
    created_at: toIso(row.created_at) ?? "",
    updated_at: toIso(row.updated_at) ?? "",
  };
}

async function weekdaysOf(weekId: string): Promise<number[]> {
  const rows = await query<RowDataPacket & { day_of_week: number }>(
    "SELECT day_of_week FROM mass_week_weekdays WHERE mass_week_id = ? ORDER BY day_of_week",
    [weekId],
  );
  return rows.map((row) => Number(row.day_of_week));
}

export async function getMassWeek(weekId: string): Promise<MassWeek> {
  const row = await queryOne<WeekRow>("SELECT * FROM mass_weeks WHERE id = ?", [weekId]);
  if (!row) throw new HttpError(404, "That weekly Community Mass record no longer exists.");
  return mapWeek(row, await weekdaysOf(weekId));
}

const WEEK_COLUMNS =
  "id, name, notes, scope, participant_type, status, created_by, created_at, updated_at";

export async function listMassWeeks(): Promise<MassWeek[]> {
  const rows = await query<WeekRow>(
    `SELECT ${WEEK_COLUMNS} FROM mass_weeks ORDER BY created_at DESC, id`,
  );
  if (rows.length === 0) return [];
  const ids = rows.map((row) => row.id);
  const dayRows = await query<RowDataPacket & { mass_week_id: string; day_of_week: number }>(
    `SELECT mass_week_id, day_of_week FROM mass_week_weekdays
      WHERE mass_week_id IN (${ids.map(() => "?").join(", ")}) ORDER BY day_of_week`,
    ids as SqlParam[],
  );
  const byWeek = new Map<string, number[]>();
  for (const dayRow of dayRows) {
    const list = byWeek.get(dayRow.mass_week_id) ?? [];
    list.push(Number(dayRow.day_of_week));
    byWeek.set(dayRow.mass_week_id, list);
  }
  return rows.map((row) => mapWeek(row, byWeek.get(row.id) ?? []));
}

export type MassWeekInput = {
  name: string;
  notes?: string | null | undefined;
  scope?: MassScope | undefined;
  participantType?: MassWeekParticipantType | undefined;
  weekdays?: number[] | undefined;
};

export async function createMassWeek(input: MassWeekInput, actorId: string): Promise<MassWeek> {
  const name = input.name.trim();
  if (!name)
    throw new HttpError(400, "Give the weekly Mass record a name, e.g. Week 1 Community Mass.");
  const scope: MassScope = input.scope === "sunday" ? "sunday" : "weekday";
  const participantType: MassWeekParticipantType =
    input.participantType === "students" || input.participantType === "staff"
      ? input.participantType
      : "both";
  const weekdays = scope === "weekday" ? parseWeekdays(input.weekdays) : [];

  const id = randomUUID();
  const stamp = utcStamp();
  await transaction(async (connection) => {
    await connection.execute(
      `INSERT INTO mass_weeks
         (id, name, notes, scope, participant_type, status,
          created_by, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, 'draft', ?, ?, ?)`,
      [id, name, input.notes?.trim() || null, scope, participantType, actorId, stamp, stamp],
    );
    for (const day of weekdays) {
      await connection.execute(
        "INSERT INTO mass_week_weekdays (mass_week_id, day_of_week) VALUES (?, ?)",
        [id, day],
      );
    }
  });
  await audit(actorId, "mass_week.created", "mass_weeks", id, { name, scope, weekdays });
  return getMassWeek(id);
}

export type MassWeekPatch = {
  name?: string | undefined;
  notes?: string | null | undefined;
  scope?: MassScope | undefined;
  participantType?: MassWeekParticipantType | undefined;
};

/**
 * Edit a week's own fields. What it covers (scope, participant type) cannot
 * change once anything has been uploaded for it: the snapshot was built for
 * what the week said then, and quietly changing the question would leave the
 * stored answers answering a different one. Reset the week first.
 */
export async function updateMassWeek(
  weekId: string,
  patch: MassWeekPatch,
  actorId: string,
): Promise<MassWeek> {
  const week = await getMassWeek(weekId);
  const uploads = await queryOne<CountRow>(
    "SELECT COUNT(*) AS total FROM mass_uploads WHERE mass_week_id = ?",
    [weekId],
  );
  if (Number(uploads?.total ?? 0) > 0) {
    const changingCover =
      (patch.scope !== undefined && patch.scope !== week.scope) ||
      (patch.participantType !== undefined && patch.participantType !== week.participant_type);
    if (changingCover) {
      throw new HttpError(
        400,
        "This week already has uploads. Reset its scopes before changing what it covers.",
      );
    }
  }

  const name = patch.name !== undefined ? patch.name.trim() : week.name;
  if (!name) throw new HttpError(400, "The week's name cannot be blank.");
  const scope: MassScope =
    patch.scope === "weekday" || patch.scope === "sunday" ? patch.scope : week.scope;
  const participantType: MassWeekParticipantType =
    patch.participantType === "students" || patch.participantType === "staff"
      ? patch.participantType
      : week.participant_type;

  await transaction(async (connection) => {
    await connection.execute(
      `UPDATE mass_weeks
          SET name = ?, notes = ?, scope = ?,
              participant_type = ?, updated_at = ?
        WHERE id = ?`,
      [
        name,
        patch.notes !== undefined ? patch.notes?.trim() || null : week.notes,
        scope,
        participantType,
        utcStamp(),
        weekId,
      ],
    );
    if (scope === "sunday" && week.scope !== "sunday") {
      await connection.execute("DELETE FROM mass_week_weekdays WHERE mass_week_id = ?", [weekId]);
    }
  });
  await audit(actorId, "mass_week.updated", "mass_weeks", weekId, { patch });
  return getMassWeek(weekId);
}

/**
 * Set the weekdays this week's Mass was held on. This is the public-holiday
 * switch: leave Monday out and no student is expected, or absent, because of
 * Monday. Blocked once uploads exist, because the expected snapshot was built
 * from the selection as it stood when the week was processed.
 */
export async function setMassWeekWeekdays(
  weekId: string,
  values: unknown,
  actorId: string,
): Promise<MassWeek> {
  const week = await getMassWeek(weekId);
  if (week.scope === "sunday") {
    throw new HttpError(400, "A Sunday Mass record covers every department and has no weekdays.");
  }
  const uploads = await queryOne<CountRow>(
    "SELECT COUNT(*) AS total FROM mass_uploads WHERE mass_week_id = ?",
    [weekId],
  );
  if (Number(uploads?.total ?? 0) > 0) {
    throw new HttpError(
      400,
      "This week already has uploads. Reset it before changing which weekdays it covers.",
    );
  }
  const weekdays = parseWeekdays(values);
  if (weekdays.length === 0) {
    throw new HttpError(
      400,
      "Choose at least one weekday. If Community Mass was not held on a day, leave it out.",
    );
  }
  const stamp = utcStamp();
  await transaction(async (connection) => {
    await connection.execute("DELETE FROM mass_week_weekdays WHERE mass_week_id = ?", [weekId]);
    for (const day of weekdays) {
      await connection.execute(
        "INSERT INTO mass_week_weekdays (mass_week_id, day_of_week) VALUES (?, ?)",
        [weekId, day],
      );
    }
    await connection.execute("UPDATE mass_weeks SET updated_at = ? WHERE id = ?", [stamp, weekId]);
  });
  await audit(actorId, "mass_week.weekdays_set", "mass_weeks", weekId, { weekdays });
  return getMassWeek(weekId);
}

export async function setMassWeekStatus(
  weekId: string,
  status: MassWeekStatus,
  actorId: string,
): Promise<MassWeek> {
  await getMassWeek(weekId);
  if (!["draft", "active", "completed", "archived"].includes(status)) {
    throw new HttpError(400, "Status must be draft, active, completed or archived.");
  }
  await query("UPDATE mass_weeks SET status = ?, updated_at = ? WHERE id = ?", [
    status,
    utcStamp(),
    weekId,
  ]);
  await audit(actorId, "mass_week.status_set", "mass_weeks", weekId, { status });
  return getMassWeek(weekId);
}

export async function deleteMassWeek(weekId: string, actorId: string): Promise<void> {
  await getMassWeek(weekId);
  // Uploads, scans, weekdays and the expected snapshot all cascade from here.
  await query("DELETE FROM mass_weeks WHERE id = ?", [weekId]);
  await audit(actorId, "mass_week.deleted", "mass_weeks", weekId, null);
}

// Expected population ----------------------------------------------------------

type SnapshotRow = {
  personId: string;
  personNo: string | null;
  fullName: string | null;
  level: string | null;
  department: string | null;
  dayOfWeek: number | null;
};

/**
 * One row per person. When the master list holds the same person under two rows
 * (see src/server/identity.ts) both rows would otherwise be expected, a scan
 * could only ever mark one of them present, and the other would be reported
 * absent: the same person on both lists. Here they become one expected person
 * under the id that stands for them. The row that IS that id is preferred for
 * the details shown; otherwise the first twin's details are used.
 */
function collapseSnapshot(rows: SnapshotRow[], identity: Identity): SnapshotRow[] {
  const byPerson = new Map<string, SnapshotRow>();
  for (const row of rows) {
    const canonical = identity.canonical(row.personId);
    const current = byPerson.get(canonical);
    if (!current || (row.personId === canonical && current.personId !== canonical)) {
      byPerson.set(canonical, row);
    }
  }
  return [...byPerson.entries()].map(([canonical, row]) => ({ ...row, personId: canonical }));
}

type AssignedDepartments = {
  /** Exact spellings as stored, for the SQL IN (which compares exactly). */
  names: string[];
  /** Lower-cased name -> weekday, for JS lookups by the snapshot's spelling. */
  byLower: Map<string, number>;
};

/**
 * The departments assigned to any of the week's selected weekdays. Only active
 * assignments count: a department switched off is not expected until it is
 * switched back on.
 */
async function assignedDepartments(weekdays: number[]): Promise<AssignedDepartments> {
  const names: string[] = [];
  const byLower = new Map<string, number>();
  if (weekdays.length === 0) return { names, byLower };
  const rows = await query<RowDataPacket & { department_code: string; day_of_week: number }>(
    `SELECT department_code, day_of_week FROM mass_department_weekdays
      WHERE is_active = 1 AND day_of_week IN (${weekdays.map(() => "?").join(", ")})
      ORDER BY department_code`,
    weekdays as SqlParam[],
  );
  for (const row of rows) {
    names.push(row.department_code);
    byLower.set(row.department_code.trim().toLowerCase(), Number(row.day_of_week));
  }
  return { names, byLower };
}

async function buildStudentSnapshot(week: MassWeek): Promise<SnapshotRow[]> {
  const departments = week.scope === "weekday" ? await assignedDepartments(week.weekdays) : null;
  // A weekday week with no departments assigned to its days expects nobody --
  // that is a real answer, not an error: the administrator can see the week
  // expects nobody and fix the assignments.
  if (departments && departments.names.length === 0) return [];

  const params: SqlParam[] = [];
  let where = `(${studentCategorySql("s")}) = 'undergraduate'`;
  if (week.scope === "sunday") {
    // A student whose registrar record says 'Religious' is not expected at
    // Sunday Mass. The comparison is trimmed and case-insensitive because the
    // column holds the file's own text; a missing value never excludes anyone,
    // and weekday Mass keeps every undergraduate as before. The row is still
    // in the lookup, so such a student who does scan on Sunday is matched and
    // reported as out of scope rather than unmatched.
    where += ` AND (s.marital_status IS NULL OR UPPER(TRIM(s.marital_status)) <> 'RELIGIOUS')`;
  }
  if (departments) {
    where += ` AND (${studentDepartmentSql("s")}) IN (${departments.names.map(() => "?").join(", ")})`;
    params.push(...departments.names);
  }
  const rows = await query<RowDataPacket & SnapshotQueryRow>(
    `SELECT s.id, s.matric_no, ${studentNameSql("s")} AS full_name, s.level,
            ${studentDepartmentSql("s")} AS department
       FROM students s WHERE ${where}
      ORDER BY ${studentNameSql("s")}`,
    params,
  );
  return rows.map((row) => ({
    personId: row.id,
    personNo: row.matric_no ?? null,
    fullName: row.full_name ?? null,
    level: row.level ?? null,
    department: row.department ?? null,
    dayOfWeek:
      week.scope === "weekday" && row.department != null
        ? (departments!.byLower.get(row.department.trim().toLowerCase()) ?? null)
        : null,
  }));
}

/**
 * The staff expected at a week's Mass. On a weekday week, only staff whose
 * department is assigned to one of the selected weekdays are expected; a staff
 * member in an unlisted unit (Registry, Bursary, and so on) is never expected.
 * A Sunday Mass has no staff expectation at all: staff are not part of the
 * Sunday population, so the snapshot is empty rather than every member of staff.
 */
async function buildStaffSnapshot(week: MassWeek): Promise<SnapshotRow[]> {
  if (week.scope === "sunday") return [];
  const departments = await assignedDepartments(week.weekdays);
  if (departments.names.length === 0) return [];

  const rows = await query<RowDataPacket & SnapshotQueryRow>(
    `SELECT f.id, f.staff_no, ${staffNameSql("f")} AS full_name,
            ${staffDepartmentSql("f")} AS department
       FROM staff f
      WHERE (${staffDepartmentSql("f")}) IN (${departments.names.map(() => "?").join(", ")})
      ORDER BY ${staffNameSql("f")}`,
    departments.names,
  );
  return rows.map((row) => ({
    personId: row.id,
    personNo: row.staff_no ?? null,
    fullName: row.full_name ?? null,
    level: null,
    department: row.department ?? null,
    dayOfWeek:
      row.department != null
        ? (departments.byLower.get(row.department.trim().toLowerCase()) ?? null)
        : null,
  }));
}

/**
 * The frozen expected population for one week and participant type, built on
 * first use and read back afterwards. The existence check and the insert run
 * in one transaction, and the unique key on (week, participant, person) means
 * a race can only lose, never double up: the loser's transaction rolls back
 * and the next call reads the winner's snapshot.
 */
async function ensureExpected(
  week: MassWeek,
  participantType: MassUploadParticipant,
  identity: Identity,
): Promise<Map<string, SnapshotRow>> {
  const existing = await query<ExpectedQueryRow>(
    `SELECT person_id, person_no, full_name, level, department, day_of_week
       FROM mass_expected WHERE mass_week_id = ? AND participant_type = ?`,
    [week.id, participantType],
  );
  if (existing.length > 0) {
    // A week frozen before duplicates were recognised can hold both twins; it
    // is read back as one person each, without rewriting what was stored.
    const rows = existing.map(
      (row) =>
        ({
          personId: row.person_id,
          personNo: row.person_no ?? null,
          fullName: row.full_name ?? null,
          level: row.level ?? null,
          department: row.department ?? null,
          dayOfWeek: row.day_of_week == null ? null : Number(row.day_of_week),
        }) satisfies SnapshotRow,
    );
    return new Map(collapseSnapshot(rows, identity).map((row) => [row.personId, row]));
  }

  const snapshot = collapseSnapshot(
    participantType === "student"
      ? await buildStudentSnapshot(week)
      : await buildStaffSnapshot(week),
    identity,
  );
  await transaction(async (connection) => {
    for (let index = 0; index < snapshot.length; index += INSERT_CHUNK) {
      const batch = snapshot.slice(index, index + INSERT_CHUNK);
      const values: SqlParam[] = [];
      for (const row of batch) {
        values.push(
          randomUUID(),
          week.id,
          participantType,
          row.personId,
          row.personNo,
          row.fullName,
          row.level,
          row.department,
          row.dayOfWeek,
        );
      }
      await connection.query(
        `INSERT INTO mass_expected
           (id, mass_week_id, participant_type, person_id, person_no, full_name,
            level, department, day_of_week)
         VALUES ${placeholders(batch.length, 9)}`,
        values,
      );
    }
  });
  return new Map(snapshot.map((row) => [row.personId, row]));
}

// Upload processing ------------------------------------------------------------

export async function listMassUploads(weekId: string): Promise<MassUpload[]> {
  const rows = await query<UploadRow>(
    `SELECT id, mass_week_id, participant_type, level, file_name, label, row_count,
            present_count, out_of_scope_count, unmatched_count, uploaded_by, uploaded_at
       FROM mass_uploads WHERE mass_week_id = ? ORDER BY uploaded_at, id`,
    [weekId],
  );
  return rows.map((row) => ({
    id: row.id,
    mass_week_id: row.mass_week_id,
    participant_type: row.participant_type,
    level: row.level ?? null,
    file_name: row.file_name,
    label: row.label ?? null,
    row_count: Number(row.row_count),
    present_count: Number(row.present_count),
    out_of_scope_count: Number(row.out_of_scope_count),
    unmatched_count: Number(row.unmatched_count),
    uploaded_by: row.uploaded_by ?? null,
    uploaded_at: toIso(row.uploaded_at) ?? "",
  }));
}

/**
 * Process one machine export against a week's frozen expected population.
 *
 * Every row is kept. Matching is the same engine the events use (leading
 * zeros, colliding staff numbers settled by name, name fallback only when the
 * name is unique), imported from events.ts rather than reimplemented, because
 * a scan must resolve the same way everywhere or the same number would mean
 * two different people on two different pages.
 *
 * Classification, decided here and stored:
 *   present       the matched person is in the frozen expected population for
 *                 this upload's participant type and level
 *   out of scope  matched, but not in that population -- the wrong level, a
 *                 department on an unselected weekday, a postgraduate, a
 *                 member of staff in a student upload
 *   unmatched     nothing in the master list explains the row
 */
export async function processMassUpload(
  weekId: string,
  input: MassUploadInput,
  actorId: string,
): Promise<{ upload: MassUpload; summary: MassSummary }> {
  const week = await getMassWeek(weekId);
  if (week.participant_type === "students" && input.participantType !== "student") {
    throw new HttpError(
      400,
      "This week is for student reports; its uploads must be student files.",
    );
  }
  if (week.participant_type === "staff" && input.participantType !== "staff") {
    throw new HttpError(400, "This week is for staff reports; its uploads must be staff files.");
  }
  if (input.participantType === "staff" && input.level) {
    throw new HttpError(400, "Staff have no level. Leave the level empty for a staff upload.");
  }
  if (week.scope === "weekday" && week.weekdays.length === 0) {
    throw new HttpError(
      400,
      "Select which weekdays this week's Mass was held on before uploading attendance.",
    );
  }

  const level = input.level?.trim() || null;
  const identity = await loadIdentity(input.participantType);
  const expected = await ensureExpected(week, input.participantType, identity);
  const config = GROUPS[input.participantType];
  const lookup = await loadLookup(config);

  type Prepared = {
    scanNumber: string | null;
    name: string | null;
    machineId: string | null;
    scannedAt: Date;
    personId: string | null;
    method: "machine_id" | "number" | "name" | "none";
    originalMethod: "machine_id" | "number" | "name" | "fuzzy_name" | "none";
    inExpected: boolean;
  };
  const prepared: Prepared[] = [];
  for (const row of input.rows) {
    const scanNumber = row.scanNumber?.trim() || null;
    const name = row.name?.trim() || null;
    const machineId = row.machineId?.trim() || null;
    if (!scanNumber && !name && !machineId) continue;
    const scannedAt = parseScanTime(row.scannedAt);
    if (!scannedAt) continue; // no usable timestamp is not evidence of attendance

    const match = matchRow(lookup, scanNumber, name, machineId);
    // Always record the id that stands for the person, so every scan of one
    // person -- whichever of their rows the machine number pointed at -- lands
    // on the same expected entry.
    const personId = match.id === null ? null : identity.canonical(match.id);
    let inExpected = false;
    if (personId !== null) {
      const snapshot = expected.get(personId);
      inExpected = snapshot !== undefined && (level === null || (snapshot.level ?? "") === level);
    }
    prepared.push({
      scanNumber,
      name,
      machineId,
      scannedAt,
      personId,
      method: match.method,
      originalMethod: match.originalMethod,
      inExpected,
    });
  }

  const presentIds = new Set<string>();
  const outOfScopeIds = new Set<string>();
  let unmatched = 0;
  for (const row of prepared) {
    if (row.personId === null) unmatched += 1;
    else if (row.inExpected) presentIds.add(row.personId);
    else outOfScopeIds.add(row.personId);
  }

  const uploadId = randomUUID();
  const stamp = utcStamp();
  await transaction(async (connection) => {
    await connection.execute(
      `INSERT INTO mass_uploads
         (id, mass_week_id, participant_type, level, file_name, label, row_count,
          present_count, out_of_scope_count, unmatched_count, uploaded_by, uploaded_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        uploadId,
        weekId,
        input.participantType,
        level,
        input.fileName,
        input.label?.trim() || null,
        prepared.length,
        presentIds.size,
        outOfScopeIds.size,
        unmatched,
        actorId,
        stamp,
      ],
    );
    for (let index = 0; index < prepared.length; index += INSERT_CHUNK) {
      const batch = prepared.slice(index, index + INSERT_CHUNK);
      const values: SqlParam[] = [];
      for (const row of batch) {
        values.push(
          randomUUID(),
          weekId,
          uploadId,
          input.participantType,
          row.scanNumber,
          row.name,
          row.scannedAt,
          row.personId,
          row.method,
          row.inExpected ? 1 : 0,
          row.machineId,
        );
      }
      await connection.query(
        `INSERT INTO mass_scans
           (id, mass_week_id, upload_id, participant_type, scan_number, scanned_name,
            scanned_at, person_id, match_method, in_expected, machine_id)
         VALUES ${placeholders(batch.length, 11)}`,
        values,
      );
    }
    await connection.execute("UPDATE mass_weeks SET updated_at = ? WHERE id = ?", [stamp, weekId]);
  });
  await audit(actorId, "mass_scans.uploaded", "mass_weeks", weekId, {
    uploadId,
    file: input.fileName,
    participantType: input.participantType,
    level,
    rows: prepared.length,
  });

  const uploads = await listMassUploads(weekId);
  const upload = uploads.find((row) => row.id === uploadId);
  if (!upload) throw new Error("Upload was not stored.");
  return { upload, summary: await massSummary(weekId, input.participantType, level) };
}

/**
 * Forget every upload, scan and snapshot for one week and participant type.
 * The next upload rebuilds the expected population from the assignments and
 * masters as they stand then -- which is the only way to pick up a corrected
 * weekday assignment or a re-imported registrar file.
 */
export async function resetMassScope(
  weekId: string,
  participantType: MassUploadParticipant,
  actorId: string,
): Promise<void> {
  await getMassWeek(weekId);
  await transaction(async (connection) => {
    await connection.execute(
      "DELETE FROM mass_scans WHERE mass_week_id = ? AND participant_type = ?",
      [weekId, participantType],
    );
    await connection.execute(
      "DELETE FROM mass_uploads WHERE mass_week_id = ? AND participant_type = ?",
      [weekId, participantType],
    );
    await connection.execute(
      "DELETE FROM mass_expected WHERE mass_week_id = ? AND participant_type = ?",
      [weekId, participantType],
    );
    await connection.execute("UPDATE mass_weeks SET updated_at = ? WHERE id = ?", [
      utcStamp(),
      weekId,
    ]);
  });
  await audit(actorId, "mass_scope.reset", "mass_weeks", weekId, { participantType });
}

/**
 * The Mass weeks whose expected population is out of date because a person
 * changed department.
 *
 * A week that has no attendance uploaded yet has nothing to preserve: its
 * snapshot is only a convenience so that the expected list is the same from
 * one upload to the next, so it is cleared and rebuilt from the master list the
 * next time attendance arrives. The new department then takes effect on its
 * own.
 *
 * A week that already has attendance keeps its snapshot, because that snapshot
 * is the record of who was expected on that date. Clearing it would rewrite
 * what a past week said. Those weeks are named in `stale` so the administrator
 * can reset them deliberately if the correction really should apply to them.
 *
 * A Sunday week expects everybody and is not scoped by department, so a
 * department change cannot affect it and it is left alone.
 */
export async function refreshMassExpectations(
  participantType: MassUploadParticipant,
): Promise<{ cleared: string[]; stale: string[] }> {
  // A week records the people it covers as "students" or "staff", while an
  // upload says which group it carries as "student" or "staff". A week that
  // covers both groups is affected by either.
  const weekType = participantType === "student" ? "students" : "staff";
  const weeks = await query<RowDataPacket & { id: string; name: string }>(
    `SELECT id, name FROM mass_weeks
      WHERE scope <> 'sunday'
        AND (participant_type = ? OR participant_type = 'both')
      ORDER BY created_at`,
    [weekType],
  );

  const cleared: string[] = [];
  const stale: string[] = [];
  for (const week of weeks) {
    const uploaded = await queryOne<CountRow>(
      "SELECT COUNT(*) AS total FROM mass_uploads WHERE mass_week_id = ? AND participant_type = ?",
      [week.id, participantType],
    );
    if (Number(uploaded?.total ?? 0) > 0) {
      stale.push(week.name);
      continue;
    }
    await query("DELETE FROM mass_expected WHERE mass_week_id = ? AND participant_type = ?", [
      week.id,
      participantType,
    ]);
    cleared.push(week.name);
  }
  return { cleared, stale };
}

// Summary and results -----------------------------------------------------------
//
// Present, absent and out of scope are worked out per PERSON, never per master
// row, and they never overlap:
//
//   present       expected, and at least one scan of theirs counts
//   absent        expected, and no scan of theirs counts
//   out of scope  scanned, matched to someone, but not present (not expected,
//                 or only scanned in an upload for another level)
//   unmatched     a scan row nothing in the master list explains
//
// Everything is recomputed from the stored scans and the frozen expected list
// each time, through the identity rule, so weeks stored before duplicates were
// recognised (both twins expected, scans on either twin) report correctly too.
// A scan counts for an expected person when its upload names no level, or the
// level the person is expected at -- the same test the upload itself applies.

type ScanForOutcome = RowDataPacket & {
  id: string;
  person_id: string | null;
  scan_number: string | null;
  scanned_name: string | null;
  scanned_at: string | Date;
  upload_level: string | null;
};

type PresentAggregate = { count: number; first: string; last: string };

type MassOutcome = {
  /** Expected people at the requested level, one entry per person. */
  expected: Map<string, MassExpectedRow>;
  present: Map<string, PresentAggregate>;
  absent: string[];
  /** Person -> number of their scans in the uploads being reported on. */
  outOfScope: Map<string, { count: number; scannedName: string | null }>;
  unmatchedScans: number;
  unmatched: MassUnmatchedRow[];
};

function expectedRowFrom(row: ExpectedQueryRow, personId: string): MassExpectedRow {
  return {
    person_id: personId,
    person_no: row.person_no ?? null,
    full_name: row.full_name ?? null,
    level: row.level ?? null,
    department: row.department ?? null,
    day_of_week: row.day_of_week == null ? null : Number(row.day_of_week),
  };
}

const byName = (a: { full_name: string | null }, b: { full_name: string | null }) =>
  (a.full_name ?? "").localeCompare(b.full_name ?? "", "en");

async function massOutcome(
  weekId: string,
  participantType: MassUploadParticipant,
  level: string | null,
): Promise<MassOutcome> {
  const identity = await loadIdentity(participantType);

  const expectedRows = await query<ExpectedQueryRow>(
    `SELECT person_id, person_no, full_name, level, department, day_of_week
       FROM mass_expected WHERE mass_week_id = ? AND participant_type = ?`,
    [weekId, participantType],
  );
  const expectedAll = new Map<string, MassExpectedRow>();
  for (const row of expectedRows) {
    const canonical = identity.canonical(row.person_id);
    const current = expectedAll.get(canonical);
    // Prefer the details of the row that is the person's own id.
    if (!current || row.person_id === canonical) {
      expectedAll.set(canonical, expectedRowFrom(row, canonical));
    }
  }

  const scans = await query<ScanForOutcome>(
    `SELECT s.id, s.person_id, s.scan_number, s.scanned_name, s.scanned_at,
            u.level AS upload_level
       FROM mass_scans s
       JOIN mass_uploads u ON u.id = s.upload_id
      WHERE s.mass_week_id = ? AND s.participant_type = ?`,
    [weekId, participantType],
  );

  const present = new Map<string, PresentAggregate>();
  const scannedNotCounted = new Map<string, { count: number; scannedName: string | null }>();
  const unmatchedGroups = new Map<string, MassUnmatchedRow>();
  let unmatchedScans = 0;

  for (const scan of scans) {
    const at = toIso(scan.scanned_at) ?? "";
    const inReportedUploads = level === null || scan.upload_level === level;

    if (scan.person_id === null) {
      if (!inReportedUploads) continue;
      unmatchedScans += 1;
      const key = `${scan.scan_number ?? ""}\u0000${scan.scanned_name ?? ""}`;
      const group = unmatchedGroups.get(key);
      if (!group) {
        unmatchedGroups.set(key, {
          scan_id: scan.id,
          scan_number: scan.scan_number,
          scanned_name: scan.scanned_name,
          scan_count: 1,
          first_scan_at: at,
          last_scan_at: at,
        });
      } else {
        group.scan_count += 1;
        if (scan.id < group.scan_id) group.scan_id = scan.id;
        if (at < group.first_scan_at) group.first_scan_at = at;
        if (at > group.last_scan_at) group.last_scan_at = at;
      }
      continue;
    }

    const person = identity.canonical(scan.person_id);
    const expectedRow = expectedAll.get(person);
    const counts =
      expectedRow !== undefined &&
      (scan.upload_level === null || (expectedRow.level ?? "") === scan.upload_level);

    if (counts) {
      const aggregate = present.get(person);
      if (!aggregate) present.set(person, { count: 1, first: at, last: at });
      else {
        aggregate.count += 1;
        if (at < aggregate.first) aggregate.first = at;
        if (at > aggregate.last) aggregate.last = at;
      }
    } else if (inReportedUploads) {
      const entry = scannedNotCounted.get(person);
      if (!entry) scannedNotCounted.set(person, { count: 1, scannedName: scan.scanned_name });
      else entry.count += 1;
    }
  }

  const expected = new Map<string, MassExpectedRow>();
  for (const [person, row] of expectedAll) {
    if (level === null || row.level === level) expected.set(person, row);
  }

  const presentAtLevel = new Map<string, PresentAggregate>();
  const absent: string[] = [];
  for (const person of expected.keys()) {
    const aggregate = present.get(person);
    if (aggregate) presentAtLevel.set(person, aggregate);
    else absent.push(person);
  }

  // Someone present anywhere in the week is never also "out of scope".
  const outOfScope = new Map<string, { count: number; scannedName: string | null }>();
  for (const [person, entry] of scannedNotCounted) {
    if (!present.has(person)) outOfScope.set(person, entry);
  }

  const unmatched = [...unmatchedGroups.values()]
    .sort(
      (a, b) =>
        b.scan_count - a.scan_count ||
        (a.scanned_name ?? "").localeCompare(b.scanned_name ?? "", "en"),
    )
    .slice(0, 500);

  return { expected, present: presentAtLevel, absent, outOfScope, unmatchedScans, unmatched };
}

function summaryFrom(
  week: MassWeek,
  participantType: MassUploadParticipant,
  level: string | null,
  outcome: MassOutcome,
  uploads: MassUpload[],
): MassSummary {
  const expected = outcome.expected.size;
  const present = outcome.present.size;
  return {
    week,
    participant_type: participantType,
    level,
    expected,
    present,
    absent: outcome.absent.length,
    out_of_scope: outcome.outOfScope.size,
    unmatched: outcome.unmatchedScans,
    percent: percent(present, expected),
    uploads: uploads.filter(
      (upload) =>
        upload.participant_type === participantType && (level === null || upload.level === level),
    ),
  };
}

export async function massSummary(
  weekId: string,
  participantType: MassUploadParticipant,
  level: string | null = null,
): Promise<MassSummary> {
  const week = await getMassWeek(weekId);
  const outcome = await massOutcome(weekId, participantType, level);
  return summaryFrom(week, participantType, level, outcome, await listMassUploads(weekId));
}

export async function massResult(
  weekId: string,
  participantType: MassUploadParticipant,
  level: string | null = null,
): Promise<MassResult> {
  const week = await getMassWeek(weekId);
  const outcome = await massOutcome(weekId, participantType, level);
  const summary = summaryFrom(week, participantType, level, outcome, await listMassUploads(weekId));

  const presentList: MassPresentRow[] = [...outcome.present.entries()]
    .map(([person, aggregate]) => ({
      ...outcome.expected.get(person)!,
      scan_count: aggregate.count,
      first_scan_at: aggregate.first,
      last_scan_at: aggregate.last,
    }))
    .sort(byName);

  const absentList: MassExpectedRow[] = outcome.absent
    .map((person) => outcome.expected.get(person)!)
    .sort(byName);

  // Out-of-scope people are described from the master list as it is now.
  const config = GROUPS[participantType];
  const alias = config.personAlias;
  const ids = [...outcome.outOfScope.keys()];
  const details = new Map<string, MassOutOfScopeRow>();
  for (let index = 0; index < ids.length; index += INSERT_CHUNK) {
    const batch = ids.slice(index, index + INSERT_CHUNK);
    const rows = await query<RowDataPacket & Omit<MassOutOfScopeRow, "scan_count">>(
      `SELECT ${alias}.id AS person_id, ${config.code} AS person_no, ${config.name} AS full_name,
              ${config.level} AS level, ${config.department} AS department
         FROM ${config.people} ${alias}
        WHERE ${alias}.id IN (${batch.map(() => "?").join(", ")})`,
      batch,
    );
    for (const row of rows) details.set(row.person_id, { ...row, scan_count: 0 });
  }
  const outOfScopeList: MassOutOfScopeRow[] = ids
    .map((person) => {
      const entry = outcome.outOfScope.get(person)!;
      const row = details.get(person) ?? {
        person_id: person,
        person_no: null,
        full_name: entry.scannedName,
        level: null,
        department: null,
        scan_count: 0,
      };
      return { ...row, scan_count: entry.count };
    })
    .sort(byName);

  return {
    ...summary,
    presentList,
    absentList,
    outOfScopeList,
    unmatchedList: outcome.unmatched,
  };
}
