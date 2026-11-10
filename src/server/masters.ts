import { randomUUID } from "node:crypto";
import type { DbConnection, RowDataPacket } from "./db";
import {
  dialect,
  likeTerm,
  query,
  queryOne,
  transaction,
  utcStamp,
  type SqlParam,
} from "@/server/db";
import type {
  ImportResult,
  Staff,
  StaffDepartmentOption,
  StaffList,
  StaffListQuery,
  Student,
  StudentCategory,
  StudentList,
  StudentListQuery,
  StudentScope,
  StaffScope,
} from "@/lib/types";
import { HttpError } from "@/server/http";
import { refreshMassExpectations, syncMassWeekdays } from "@/server/mass";

/**
 * The two master tables hold exactly what the registrar's files hold. Everything
 * else the app shows or filters on is read out of the stored columns in SQL, so
 * nothing derived is stored on a person, and no number is stored twice:
 *
 *   VUG/2021/2633        undergraduate, machine 2633
 *   VPG/PGD/2020/1042    postgraduate, machine 1042
 *
 * The department is the file's own `department` column, kept exactly as written,
 * rather than a code guessed out of the matric number. The registrar's names are
 * the authoritative ones ("Peace And Conflict Studies", not "PCS"), so the app
 * shows and filters on those.
 *
 * The number the machine prints is the last part of the matric number for a
 * student and the digits of the staff number for staff, so a scan is matched
 * against a value worked out here rather than a column kept in step with the
 * file by hand.
 */

/** Row as it arrives from the browser, already parsed out of the file. */
export type StudentInput = {
  matricNo: string;
  lastName: string | null;
  firstName: string | null;
  middleName: string | null;
  level: string | null;
  department: string | null;
  maritalStatus: string | null;
};

export type StaffInput = {
  staffNo: string | null;
  lastName: string | null;
  firstName: string | null;
  middleName: string | null;
  faculty: string | null;
  department: string | null;
  adminDepartment: string | null;
  machineId: string | null;
};

type CountRow = RowDataPacket & { total: number };
type DepartmentRow = RowDataPacket & { code: string };

const STUDENT_CHUNK = 400;
const STAFF_CHUNK = 400;

function placeholders(rows: number, columns = 1): string {
  return Array.from(
    { length: rows },
    () => `(${new Array<string>(columns).fill("?").join(",")})`,
  ).join(",");
}

/**
 * The source CSVs write missing values as the text NULL, so a cell that is
 * empty, "NULL" or "N/A" means the same thing: no value. Anything else is kept
 * exactly as written, because a name or number is never guessed at.
 */
function nullIfBlank(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  if (!trimmed) return null;
  if (/^(null|n\/?a|none|not applicable)$/i.test(trimmed)) return null;
  return trimmed;
}

/** A person's name as one comparable string, or null when there is no name. */
function personName(record: { lastName: string | null; firstName: string | null }): string | null {
  const name = [record.lastName, record.firstName]
    .map((part) => (part ?? "").trim())
    .filter(Boolean)
    .join(" ");
  return name === "" ? null : name;
}

// Derived columns ----------------------------------------------------------

/** lname + fname + mname, the order the file has them in. */
export function studentNameSql(alias = "s"): string {
  return `TRIM(CONCAT_WS(' ', ${alias}.last_name, ${alias}.first_name, ${alias}.middle_name))`;
}

export function staffNameSql(alias = "f"): string {
  return `TRIM(CONCAT_WS(' ', ${alias}.last_name, ${alias}.first_name, ${alias}.middle_name))`;
}

/**
 * The department as the registrar's file writes it, e.g. "Computer and
 * Information Technology". Kept verbatim: the file's own name is what the app
 * shows, filters on and reports, so there is no code to fall out of step with
 * the spelling ("Peace And Conflict Studies", not "PCS").
 *
 * A blank or whitespace-only cell is treated as no department, so it is not
 * offered as a choice and cannot be selected by mistake.
 */
export function studentDepartmentSql(alias = "s"): string {
  return `NULLIF(TRIM(${alias}.department), '')`;
}

/** VUG and VUGS are undergraduate, VPG is postgraduate. */
export function studentCategorySql(alias = "s"): string {
  return `CASE
    WHEN ${alias}.matric_no LIKE 'VUG%' THEN 'undergraduate'
    WHEN ${alias}.matric_no LIKE 'VPG%' THEN 'postgraduate'
    ELSE NULL END`;
}

/**
 * The department a member of staff belongs to, worked out rather than stored.
 *
 * `department` is the registrar's roster name (staffmapping.txt) and is what the
 * Mass weekday assignments are keyed on, so it comes first. `admin_department`
 * is the older export's column and is used only for a person the roster does not
 * cover, so a staff member is never left without a department when either column
 * has one.
 *
 * Deriving it means there is no third copy of this to keep in step: a re-upload
 * that changes someone's department changes what every past report says, which is
 * what "expected" is supposed to mean.
 */
export function staffDepartmentSql(alias = "f"): string {
  return `COALESCE(NULLIF(TRIM(${alias}.department), ''), NULLIF(TRIM(${alias}.admin_department), ''))`;
}

/**
 * The number the machine prints for a student, which is the last part of the
 * matric number: VUG/ACC/25/13514 -> 13514. It is derived rather than stored,
 * so it cannot fall out of step with the matric number. All 8,760 matric tails
 * are distinct, so a tail identifies one student.
 */
export function studentScanNumberSql(alias = "s"): string {
  return `NULLIF(SUBSTRING_INDEX(${alias}.matric_no, '/', -1), '')`;
}

/**
 * The number the machine prints for a member of staff: the ID the registrar's
 * staff file records in its "Staff_ID_on_machine" column ("SA 1188" -> 1188).
 *
 * The stored `machine_id` comes first because it is the file's own value and a
 * change of staff number must not change who a scan means. Rows the roster does
 * not cover have no machine ID and fall back to the digits of the staff number,
 * which is exactly how every scan was matched before the column existed.
 *
 * Verified against the machine exports: of the scans that no student matric
 * number explains, 170 of 187 carry the digits of a staff number in the file.
 * The digits still collide for two people in the roster ("39" and "65"), and
 * matchRow() tells those apart by name, leaving the rest unresolved rather than
 * picking one.
 */
export function staffScanNumberSql(alias = "f"): string {
  return `COALESCE(NULLIF(TRIM(${alias}.machine_id), ''), NULLIF(REGEXP_REPLACE(${alias}.staff_no, '[^0-9]', ''), ''))`;
}

// Scopes ------------------------------------------------------------------

/**
 * `WHERE` fragment for a student scope. Absent filters match everyone.
 *
 * `departmentCodes` holds every department in the event, so a session for three
 * departments is one `IN (...)` rather than three sessions, three uploads and
 * three chances to disagree about who was expected.
 */
export function studentScopeWhere(scope: StudentScope, params: SqlParam[], alias = "s"): string {
  const clauses = ["1 = 1"];
  if (scope.category) {
    clauses.push(`(${studentCategorySql(alias)}) = ?`);
    params.push(scope.category);
  }
  if (scope.level) {
    clauses.push(`${alias}.level = ?`);
    params.push(scope.level);
  }
  const departments = normalizeScopeList(scope.departmentCodes ?? scope.departmentCode);
  if (departments.length > 0) {
    clauses.push(`(${studentDepartmentSql(alias)}) IN (${departments.map(() => "?").join(", ")})`);
    params.push(...departments);
  }
  return clauses.join(" AND ");
}

/**
 * `WHERE` fragment for a staff scope. Staff have no level and no
 * undergraduate/postgraduate split, so a department list is the only narrowing
 * that can be stated truthfully.
 */
export function staffScopeWhere(scope: StaffScope, params: SqlParam[], alias = "f"): string {
  const departments = normalizeScopeList(scope.departments);
  if (departments.length === 0) return "1 = 1";
  const placeholders = departments.map(() => "?").join(", ");
  params.push(...departments);
  return `(${staffDepartmentSql(alias)}) IN (${placeholders})`;
}

/**
 * Clean a department list before it reaches SQL: drop blanks, collapse repeats
 * and trim.
 */
export function normalizeScopeList(values: unknown): string[] {
  if (values === null || values === undefined) return [];
  const list = Array.isArray(values) ? values : [values];
  const out: string[] = [];
  for (const value of list) {
    if (typeof value !== "string") continue;
    const trimmed = value.trim();
    if (trimmed === "") continue;
    if (!out.includes(trimmed)) out.push(trimmed);
  }
  return out;
}

export async function audit(
  connection: DbConnection,
  actorId: string,
  action: string,
  entity: string,
  details: unknown,
): Promise<void> {
  await connection.execute(
    "INSERT INTO audit_logs (id, actor_id, action, entity, details) VALUES (?, ?, ?, ?, ?)",
    [randomUUID(), actorId, action, entity, JSON.stringify(details)],
  );
}

// Imports -----------------------------------------------------------------

/**
 * Stores an uploaded student list. matric_no is the natural key, so a corrected
 * re-upload updates the same rows instead of creating duplicates. The file's id
 * column is not stored (it repeats the matric number), and neither is the
 * category, which is derived from the matric number. The department's full name
 * and the marital status are stored as the file spells them: they are the file's
 * own text, kept for display, for scoping and for the Sunday Mass rule.
 */
export async function importStudents(
  records: StudentInput[],
  actorId: string,
): Promise<ImportResult> {
  const parsed = records
    .filter((record) => record.matricNo.trim() !== "")
    .map((record) => ({
      matric: record.matricNo.trim(),
      lastName: nullIfBlank(record.lastName),
      firstName: nullIfBlank(record.firstName),
      middleName: nullIfBlank(record.middleName),
      level: nullIfBlank(record.level),
      department: nullIfBlank(record.department),
      maritalStatus: nullIfBlank(record.maritalStatus),
    }));

  return transaction(async (connection) => {
    let saved = 0;
    let skipped = 0;

    for (let index = 0; index < parsed.length; index += STUDENT_CHUNK) {
      const batch = parsed.slice(index, index + STUDENT_CHUNK);

      const values: SqlParam[] = [];
      for (const record of batch) {
        values.push(
          randomUUID(),
          record.matric,
          record.lastName,
          record.firstName,
          record.middleName,
          record.level,
          record.department,
          record.maritalStatus,
          utcStamp(),
        );
        if (!record.lastName && !record.firstName) skipped += 1;
      }

      await connection.query(
        `INSERT INTO students
           (id, matric_no, last_name, first_name, middle_name, level, department, marital_status, updated_at)
         VALUES ${placeholders(batch.length, 9)}
         ${dialect.upsert("matric_no", [
           "last_name",
           "first_name",
           "middle_name",
           "level",
           "department",
           "marital_status",
           "updated_at",
         ])}`,
        values,
      );
      saved += batch.length;
    }

    await audit(connection, actorId, "students.imported", "students", { saved, skipped });
    return { saved, skipped };
  });
}

/**
 * Stores an uploaded staff list. staff_no is the natural key because it is the
 * one identifier the staff file supplies, and it is distinct on every row that
 * has one. A re-upload therefore updates the same rows.
 *
 * Two rows in the file carry the literal text NULL, which is read as "no staff
 * number" and stored as NULL. Those rows have no key to update, so they are
 * matched on the person's name instead: an existing row with no staff number
 * and the same name is replaced rather than duplicated. A row with neither a
 * staff number nor a name cannot be identified at all and is counted as
 * skipped.
 */
export async function importStaff(records: StaffInput[], actorId: string): Promise<ImportResult> {
  const parsed = records.map((record) => ({
    staffNo: nullIfBlank(record.staffNo),
    lastName: nullIfBlank(record.lastName),
    firstName: nullIfBlank(record.firstName),
    middleName: nullIfBlank(record.middleName),
    faculty: nullIfBlank(record.faculty),
    department: nullIfBlank(record.department),
    adminDepartment: nullIfBlank(record.adminDepartment),
    machineId: nullIfBlank(record.machineId),
  }));

  const keyed = parsed.filter((record) => record.staffNo !== null);
  const unkeyed = parsed.filter((record) => record.staffNo === null && personName(record));

  return transaction(async (connection) => {
    let saved = 0;

    for (let index = 0; index < keyed.length; index += STAFF_CHUNK) {
      const batch = keyed.slice(index, index + STAFF_CHUNK);

      const values: SqlParam[] = [];
      for (const record of batch) {
        values.push(
          randomUUID(),
          record.staffNo,
          record.lastName,
          record.firstName,
          record.middleName,
          record.faculty,
          record.department,
          record.adminDepartment,
          record.machineId,
          utcStamp(),
        );
      }

      await connection.query(
        `INSERT INTO staff (id, staff_no, last_name, first_name, middle_name, faculty, department, admin_department, machine_id, updated_at)
         VALUES ${placeholders(batch.length, 10)}
         ${dialect.upsert("staff_no", [
           "last_name",
           "first_name",
           "middle_name",
           "faculty",
           "department",
           "admin_department",
           "machine_id",
           "updated_at",
         ])}`,
        values,
      );
      saved += batch.length;
    }

    // Rows with no staff number: replace any earlier row for the same person.
    for (const record of unkeyed) {
      const name = personName(record);
      // staffNameSql() defaults to the "f" alias used by the reads, so the
      // table name is passed here where there is no such alias.
      await connection.query(
        `DELETE FROM staff WHERE staff_no IS NULL AND ${staffNameSql("staff")} = ?`,
        [name],
      );
      await connection.query(
        "INSERT INTO staff (id, staff_no, last_name, first_name, middle_name, faculty, department, admin_department, machine_id, updated_at) VALUES (?, NULL, ?, ?, ?, ?, ?, ?, ?, ?)",
        [
          randomUUID(),
          record.lastName,
          record.firstName,
          record.middleName,
          record.faculty,
          record.department,
          record.adminDepartment,
          record.machineId,
          utcStamp(),
        ],
      );
      saved += 1;
    }

    const skipped = records.length - keyed.length - unkeyed.length;
    await audit(connection, actorId, "staff.imported", "staff", { saved, skipped });
    return { saved, skipped };
  });

  // Ensure any new departments from this import get a weekday assignment
  await syncMassWeekdays(actorId);
}

// Editing a person ------------------------------------------------------------

/** The fields a person can be corrected on, from the master list screen. */
export type StudentEdit = {
  lastName?: string | null | undefined;
  firstName?: string | null | undefined;
  middleName?: string | null | undefined;
  level?: string | null | undefined;
  department?: string | null | undefined;
  maritalStatus?: string | null | undefined;
};

export type StaffEdit = {
  lastName?: string | null | undefined;
  firstName?: string | null | undefined;
  middleName?: string | null | undefined;
  faculty?: string | null | undefined;
  department?: string | null | undefined;
  adminDepartment?: string | null | undefined;
  machineId?: string | null | undefined;
};

/**
 * Corrects one student, in place.
 *
 * The matric number is the natural key and is not editable here: changing it
 * would break every scan that points at this person, and the registrar's file
 * is the authority on it anyway. Everything else -- the names, the level, the
 * department and the marital status -- is the file's own text and can be
 * corrected by hand when a file arrives wrong.
 *
 * A field left out of `input` is not touched. A field given as an empty string
 * is cleared, because "this person has no department" is a real answer.
 *
 * A change of department moves the person between the Mass weekdays, so the
 * weeks whose expected population is still open are refreshed. The weeks that
 * already hold attendance keep their snapshot and are named in the result, so
 * the correction can be applied to them on purpose rather than by accident.
 */
export async function updateStudent(
  id: string,
  input: StudentEdit,
  actorId: string,
): Promise<{ staleWeeks: string[] }> {
  const sets: string[] = [];
  const values: SqlParam[] = [];
  const push = (column: string, value: string | null | undefined) => {
    if (value === undefined) return;
    sets.push(`${column} = ?`);
    values.push(value);
  };
  push("last_name", input.lastName === undefined ? undefined : nullIfBlank(input.lastName));
  push("first_name", input.firstName === undefined ? undefined : nullIfBlank(input.firstName));
  push("middle_name", input.middleName === undefined ? undefined : nullIfBlank(input.middleName));
  push("level", input.level === undefined ? undefined : nullIfBlank(input.level));
  push("department", input.department === undefined ? undefined : nullIfBlank(input.department));
  push(
    "marital_status",
    input.maritalStatus === undefined ? undefined : nullIfBlank(input.maritalStatus),
  );
  if (sets.length === 0) return { staleWeeks: [] };

  sets.push("updated_at = ?");
  values.push(utcStamp());
  values.push(id);

  await transaction(async (connection) => {
    const [result] = await connection.execute<{ affectedRows?: number }>(
      `UPDATE students SET ${sets.join(", ")} WHERE id = ?`,
      values,
    );
    // A database reports no rows changed when the new value is the same as the
    // old one, so a count of zero does not mean the person is missing. The row
    // is looked up to tell the two apart.
    if (!result || result.affectedRows === 0) {
      const [rows] = await connection.execute<RowDataPacket[]>(
        "SELECT id FROM students WHERE id = ?",
        [id],
      );
      if (rows.length === 0) {
        throw new HttpError(404, "That student is no longer in the list.");
      }
    }
    await audit(connection, actorId, "student.updated", "students", { id, ...input });
  });

  if (input.department === undefined) return { staleWeeks: [] };
  const refreshed = await refreshMassExpectations("student");
  return { staleWeeks: refreshed.stale };
}

/**
 * Corrects one member of staff, in place. As with a student, the staff number
 * is the natural key and is not editable: a scan matches on it, so changing it
 * would lose the person their attendance.
 *
 * A change of department moves the person between the Mass weekdays, so the
 * weeks whose expected population is still open are refreshed.
 */
export async function updateStaff(
  id: string,
  input: StaffEdit,
  actorId: string,
): Promise<{ staleWeeks: string[] }> {
  const sets: string[] = [];
  const values: SqlParam[] = [];
  const push = (column: string, value: string | null | undefined) => {
    if (value === undefined) return;
    sets.push(`${column} = ?`);
    values.push(value);
  };
  push("last_name", input.lastName === undefined ? undefined : nullIfBlank(input.lastName));
  push("first_name", input.firstName === undefined ? undefined : nullIfBlank(input.firstName));
  push("middle_name", input.middleName === undefined ? undefined : nullIfBlank(input.middleName));
  push("faculty", input.faculty === undefined ? undefined : nullIfBlank(input.faculty));
  push("department", input.department === undefined ? undefined : nullIfBlank(input.department));
  push(
    "admin_department",
    input.adminDepartment === undefined ? undefined : nullIfBlank(input.adminDepartment),
  );
  push("machine_id", input.machineId === undefined ? undefined : nullIfBlank(input.machineId));
  if (sets.length === 0) return { staleWeeks: [] };

  sets.push("updated_at = ?");
  values.push(utcStamp());
  values.push(id);

  await transaction(async (connection) => {
    const [result] = await connection.execute<{ affectedRows?: number }>(
      `UPDATE staff SET ${sets.join(", ")} WHERE id = ?`,
      values,
    );
    // As for a student: a count of zero means the value did not change, not
    // that the person is missing.
    if (!result || result.affectedRows === 0) {
      const [rows] = await connection.execute<RowDataPacket[]>(
        "SELECT id FROM staff WHERE id = ?",
        [id],
      );
      if (rows.length === 0) {
        throw new HttpError(404, "That member of staff is no longer in the list.");
      }
    }
    await audit(connection, actorId, "staff.updated", "staff", { id, ...input });
  });

  if (input.department === undefined) return { staleWeeks: [] };
  const refreshed = await refreshMassExpectations("staff");
  await syncMassWeekdays(actorId);
  return { staleWeeks: refreshed.stale };
}

// Reads -------------------------------------------------------------------

type StudentRow = RowDataPacket &
  Omit<Student, "department_code" | "student_category" | "full_name"> & {
    full_name: string;
    student_category: StudentCategory | null;
    department_code: string | null;
  };

/**
 * The students page sorts by the column *label* it renders ("Matric no",
 * "Department"), while the API's own vocabulary is the column key. Both are
 * accepted so either spelling sorts the same way, and anything unrecognised
 * falls through to the name, which is the default ordering.
 */
const STUDENT_SORT_ALIASES: Record<string, string> = {
  "Matric no": "matric_no",
  Category: "student_category",
  Level: "level",
  Department: "department_code",
};

export async function listStudents(input: StudentListQuery): Promise<StudentList> {
  const params: SqlParam[] = [];
  const where = [studentScopeWhere(input, params)];
  if (input.search) {
    const term = likeTerm(input.search);
    where.push(
      `(${studentNameSql()} LIKE ?${dialect.likeEscape} OR s.matric_no LIKE ?${dialect.likeEscape})`,
    );
    params.push(term, term);
  }
  const filter = where.join(" AND ");

  const sortBy = STUDENT_SORT_ALIASES[input.sortBy ?? ""] ?? input.sortBy;
  const sortColumn =
    sortBy === "matric_no"
      ? "s.matric_no"
      : sortBy === "student_category"
        ? `${studentCategorySql()}`
        : sortBy === "level"
          ? "s.level"
          : sortBy === "department_code"
            ? studentDepartmentSql()
            : studentNameSql();
  const sortDir = input.sortDir === "desc" ? "DESC" : "ASC";
  const page = input.page && input.page > 0 ? input.page : 1;
  const pageSize = input.pageSize && input.pageSize > 0 ? Math.min(input.pageSize, 200) : 200;
  const offset = (page - 1) * pageSize;

  const [rows, totalRow, levels, departments, undergrad, postgrad] = await Promise.all([
    query<StudentRow>(
      `SELECT s.id, s.matric_no, s.last_name, s.first_name, s.middle_name,
              s.level, s.department, s.marital_status,
              ${studentNameSql()} AS full_name,
              ${studentCategorySql()} AS student_category,
              ${studentDepartmentSql()} AS department_code
       FROM students s
       WHERE ${filter}
       ORDER BY ${sortColumn} ${sortDir}
       LIMIT ? OFFSET ?`,
      [...params, pageSize, offset],
    ),
    queryOne<CountRow>(`SELECT COUNT(*) AS total FROM students s WHERE ${filter}`, params),
    studentLevels(),
    studentDepartments(),
    queryOne<CountRow>(
      `SELECT COUNT(*) AS total FROM students s WHERE (${studentCategorySql()}) = 'undergraduate'`,
    ),
    queryOne<CountRow>(
      `SELECT COUNT(*) AS total FROM students s WHERE (${studentCategorySql()}) = 'postgraduate'`,
    ),
  ]);

  return {
    students: rows,
    total: Number(totalRow?.total ?? 0),
    levels,
    departments,
    undergraduate: Number(undergrad?.total ?? 0),
    postgraduate: Number(postgrad?.total ?? 0),
  };
}

type StaffRow = RowDataPacket &
  Omit<Staff, "full_name"> & {
    full_name: string;
    faculty: string | null;
    department: string | null;
    admin_department: string | null;
    machine_id: string | null;
  };

export async function listStaff(input: StaffListQuery): Promise<StaffList> {
  const params: SqlParam[] = [];
  const where = ["1 = 1"];
  if (input.search) {
    const term = likeTerm(input.search);
    where.push(
      `(${staffNameSql()} LIKE ?${dialect.likeEscape} OR f.staff_no LIKE ?${dialect.likeEscape})`,
    );
    params.push(term, term);
  }
  const filter = where.join(" AND ");

  const sortColumn =
    input.sortBy === "staff_no"
      ? "f.staff_no"
      : input.sortBy === "faculty"
        ? "f.faculty"
        : input.sortBy === "department"
          ? "f.department"
          : input.sortBy === "admin_department"
            ? "f.admin_department"
            : staffNameSql();
  const sortDir = input.sortDir === "desc" ? "DESC" : "ASC";
  const page = input.page && input.page > 0 ? input.page : 1;
  const pageSize = input.pageSize && input.pageSize > 0 ? Math.min(input.pageSize, 200) : 200;
  const offset = (page - 1) * pageSize;

  const [rows, totalRow, withNoRow] = await Promise.all([
    query<StaffRow>(
      `SELECT f.id, f.staff_no, f.last_name, f.first_name, f.middle_name,
              ${staffNameSql()} AS full_name, f.faculty, f.department, f.admin_department, f.machine_id
       FROM staff f
       WHERE ${filter}
       ORDER BY ${sortColumn} ${sortDir}
       LIMIT ? OFFSET ?`,
      [...params, pageSize, offset],
    ),
    queryOne<CountRow>(`SELECT COUNT(*) AS total FROM staff f WHERE ${filter}`, params),
    queryOne<CountRow>(
      `SELECT COUNT(*) AS total FROM staff f WHERE ${filter} AND f.staff_no IS NOT NULL AND f.staff_no <> ''`,
      params,
    ),
  ]);

  return {
    staff: rows,
    total: Number(totalRow?.total ?? 0),
    withStaffNo: Number(withNoRow?.total ?? 0),
  };
}

/** How many students currently match a scope. This is the denominator in reports. */
export async function countStudentsInScope(scope: StudentScope): Promise<number> {
  const params: SqlParam[] = [];
  const where = studentScopeWhere(scope, params);
  const row = await queryOne<CountRow>(
    `SELECT COUNT(*) AS total FROM students s WHERE ${where}`,
    params,
  );
  return Number(row?.total ?? 0);
}

export async function countStaff(): Promise<number> {
  const row = await queryOne<CountRow>("SELECT COUNT(*) AS total FROM staff");
  return Number(row?.total ?? 0);
}

/** Distinct levels that actually exist, for the event and report filters. */
export async function studentLevels(): Promise<string[]> {
  const rows = await query<RowDataPacket & { level: string }>(
    `SELECT DISTINCT level FROM students WHERE level IS NOT NULL ORDER BY ${dialect.intCast("level")}`,
  );
  return rows.map((row) => row.level);
}

/** Distinct department names found in the registrar's file, for the pickers. */
export async function studentDepartments(): Promise<string[]> {
  const rows = await query<DepartmentRow>(
    `SELECT DISTINCT ${studentDepartmentSql()} AS code FROM students s
     WHERE ${studentDepartmentSql()} IS NOT NULL
     ORDER BY code`,
  );
  return rows.map((row) => row.code);
}

/**
 * Every staff department a picker should offer, with the number of staff in it,
 * so choosing a department cannot silently include nobody. The staff with neither
 * column are counted in `unassigned` and cannot be selected, because there is no
 * name to select them by: they fall outside a department-scoped event and are
 * expected at an event that names none, since that one expects everyone.
 */
export async function staffDepartments(): Promise<{
  departments: StaffDepartmentOption[];
  unassigned: number;
}> {
  // Grouped by the expression, not by the `department` alias. MariaDB resolves a
  // bare name in GROUP BY against the real column of that name, and staff has one
  // called `department`, so grouping by the alias silently grouped by the wrong
  // column: it reported 43 departments instead of 59, miscounted them (13 staff
  // in Accounting, shown as 15) and folded the four staff with neither column
  // into whichever department happened to sort first.
  const derived = staffDepartmentSql();
  const rows = await query<RowDataPacket & { department: string | null; total: number }>(
    `SELECT ${derived} AS department, COUNT(*) AS total
     FROM staff f
     GROUP BY ${derived}
     ORDER BY (department IS NULL), department`,
  );

  let unassigned = 0;
  const departments: StaffDepartmentOption[] = [];
  for (const row of rows) {
    if (row.department === null) {
      unassigned = Number(row.total);
      continue;
    }
    departments.push({ department: row.department, total: Number(row.total) });
  }
  return { departments, unassigned };
}

/**
 * Just the names, for a report filter or breakdown. The staff with neither
 * column are left out: they have no department to offer, and they appear in
 * every unscoped count already.
 */
export async function staffDepartmentOptions(): Promise<string[]> {
  const derived = staffDepartmentSql();
  const rows = await query<RowDataPacket & { department: string }>(
    `SELECT DISTINCT ${derived} AS department FROM staff f
     WHERE ${derived} IS NOT NULL
     ORDER BY department`,
  );
  return rows.map((row) => row.department);
}

/** How many staff currently match a staff scope. */
export async function countStaffInScope(scope: StaffScope): Promise<number> {
  const params: SqlParam[] = [];
  const where = staffScopeWhere(scope, params);
  const row = await queryOne<CountRow>(
    `SELECT COUNT(*) AS total FROM staff f WHERE ${where}`,
    params,
  );
  return Number(row?.total ?? 0);
}

export async function levelBreakdown(): Promise<Array<{ level: string; total: number }>> {
  const rows = await query<RowDataPacket & { level: string; total: number }>(
    `SELECT level, COUNT(*) AS total FROM students
     WHERE level IS NOT NULL
     GROUP BY level ORDER BY ${dialect.intCast("level")}`,
  );
  return rows.map((row) => ({ level: row.level, total: Number(row.total) }));
}

export async function categoryBreakdown(): Promise<
  Array<{ category: StudentCategory; total: number }>
> {
  const rows = await query<RowDataPacket & { category: StudentCategory; total: number }>(
    `SELECT ${studentCategorySql()} AS category, COUNT(*) AS total FROM students s
     WHERE (${studentCategorySql()}) IS NOT NULL
     GROUP BY category`,
  );
  return rows.map((row) => ({ category: row.category, total: Number(row.total) }));
}

export async function eventCategoryBreakdown(): Promise<{
  student: { community_mass: number; other: number };
  staff: { community_mass: number; other: number };
}> {
  const [studentRows, staffRows] = await Promise.all([
    query<RowDataPacket & { event_category: "community_mass" | "other"; total: number }>(
      `SELECT event_category, COUNT(*) AS total FROM student_events GROUP BY event_category`,
    ),
    query<RowDataPacket & { event_category: "community_mass" | "other"; total: number }>(
      `SELECT event_category, COUNT(*) AS total FROM staff_events GROUP BY event_category`,
    ),
  ]);
  const student = { community_mass: 0, other: 0 };
  const staff = { community_mass: 0, other: 0 };
  for (const row of studentRows) student[row.event_category] = Number(row.total);
  for (const row of staffRows) staff[row.event_category] = Number(row.total);
  return { student, staff };
}
