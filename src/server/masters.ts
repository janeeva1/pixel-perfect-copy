import { randomUUID } from "node:crypto";
import type { DbConnection, RowDataPacket } from "./db";
import { dialect, likeTerm, query, queryOne, transaction, type SqlParam } from "@/server/db";
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

/**
 * The two master tables hold exactly what the registrar's files hold. Everything
 * else the app shows or filters on is read out of the stored columns in SQL, so
 * nothing derived is stored on a person, and no number is stored twice:
 *
 *   VUG/CSC/18/2633      undergraduate, level 400, department CSC, machine 2633
 *   VPG/PGD/ECO/15/1042  postgraduate, level 700, department ECO, machine 1042
 *
 * Undergraduates put the department in the second part (VUG/<dept>/<year>/<id>)
 * and postgraduates in the third (VPG/<award>/<dept>/<year>/<id>), so the
 * department is whichever of those parts is not the award.
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
};

export type StaffInput = {
  staffNo: string | null;
  lastName: string | null;
  firstName: string | null;
  middleName: string | null;
  faculty: string | null;
  department: string | null;
  adminDepartment: string | null;
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

function slashCount(alias: string): string {
  return `(LENGTH(${alias}.matric_no) - LENGTH(REPLACE(${alias}.matric_no, '/', '')))`;
}

/**
 * The department code inside the matric number, e.g. CSC, ECO, ACC.
 *
 * Undergraduates are VUG/<department>/<year>/<id> and postgraduates are
 * VPG/<award>/<department>/<year>/<id>, so the department is the part after the
 * award for a VPG row and the second part otherwise. Checked against all 8,760
 * rows: every one has a department, and no award code ever lands in this slot.
 */
export function studentDepartmentSql(alias = "s"): string {
  const postgraduate = `${alias}.matric_no LIKE 'VPG%'`;
  const slot = (position: number) =>
    `NULLIF(UPPER(SUBSTRING_INDEX(SUBSTRING_INDEX(${alias}.matric_no, '/', ${position}), '/', -1)), '')`;
  return `CASE
    WHEN ${postgraduate} AND ${slashCount(alias)} >= 4 THEN ${slot(3)}
    WHEN NOT ${postgraduate} AND ${slashCount(alias)} >= 3 THEN ${slot(2)}
    ELSE NULL END`;
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
 * The staff file supplies two columns and they mean the same thing, so they are
 * treated as one: `admin_department` is the department they administer, and
 * `department` is the one they sit in. Someone with no admin department is taken
 * from `department` instead, so all 802 staff with either column get a
 * department and the remaining 4 are the only ones without one.
 *
 * Deriving it means there is no third copy of this to keep in step: a re-upload
 * that changes someone's department changes what every past report says, which is
 * what "expected" is supposed to mean.
 */
export function staffDepartmentSql(alias = "f"): string {
  return `COALESCE(NULLIF(TRIM(${alias}.admin_department), ''), NULLIF(TRIM(${alias}.department), ''))`;
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
 * The number the machine prints for a member of staff, which is the digits of
 * the staff number: "SA 1188" -> 1188. Verified against the machine exports:
 * of the scans that no student matric number explains, 170 of 187 carry the
 * digits of a staff number in the file.
 *
 * Deriving it means 62 staff numbers whose digits collide ("497" belongs to two
 * people) have to be told apart by name. matchScanNumber() does that, and
 * leaves the rest unresolved rather than picking one.
 */
export function staffScanNumberSql(alias = "f"): string {
  return `NULLIF(REGEXP_REPLACE(${alias}.staff_no, '[^0-9]', ''), '')`;
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
  // Upper cased, because the code is worked out from the matric number in upper
  // case: a lower-case "csc" must still find the CSC students rather than none.
  const departments = normalizeScopeList(scope.departmentCodes ?? scope.departmentCode, true);
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
 * and trim. Student codes are compared upper case because they are worked out
 * from the matric number in upper case.
 */
export function normalizeScopeList(values: unknown, upper = false): string[] {
  if (values === null || values === undefined) return [];
  const list = Array.isArray(values) ? values : [values];
  const out: string[] = [];
  for (const value of list) {
    if (typeof value !== "string") continue;
    const trimmed = value.trim();
    if (trimmed === "") continue;
    const clean = upper ? trimmed.toUpperCase() : trimmed;
    if (!out.includes(clean)) out.push(clean);
  }
  return out;
}

async function audit(
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
 * re-upload updates the same rows instead of creating duplicates. Nothing else
 * is stored: not the file's id column, which repeats the matric number, and not
 * the category or department, which are derived from the matric number.
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
        );
        if (!record.lastName && !record.firstName) skipped += 1;
      }

      await connection.query(
        `INSERT INTO students
           (id, matric_no, last_name, first_name, middle_name, level)
         VALUES ${placeholders(batch.length, 6)}
         ${dialect.upsert("matric_no", ["last_name", "first_name", "middle_name", "level"])}`,
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
        );
      }

      await connection.query(
        `INSERT INTO staff (id, staff_no, last_name, first_name, middle_name, faculty, department, admin_department)
         VALUES ${placeholders(batch.length, 8)}
         ${dialect.upsert("staff_no", [
           "last_name",
           "first_name",
           "middle_name",
           "faculty",
           "department",
           "admin_department",
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
        "INSERT INTO staff (id, staff_no, last_name, first_name, middle_name, faculty, department, admin_department) VALUES (?, NULL, ?, ?, ?, ?, ?, ?)",
        [
          randomUUID(),
          record.lastName,
          record.firstName,
          record.middleName,
          record.faculty,
          record.department,
          record.adminDepartment,
        ],
      );
      saved += 1;
    }

    const skipped = records.length - keyed.length - unkeyed.length;
    await audit(connection, actorId, "staff.imported", "staff", { saved, skipped });
    return { saved, skipped };
  });
}

// Reads -------------------------------------------------------------------

type StudentRow = RowDataPacket &
  Omit<Student, "department_code" | "student_category" | "full_name"> & {
    full_name: string;
    student_category: StudentCategory | null;
    department_code: string | null;
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

  const sortColumn =
    input.sortBy === "matric_no"
      ? "s.matric_no"
      : input.sortBy === "student_category"
        ? `${studentCategorySql()}`
        : input.sortBy === "level"
          ? "s.level"
          : input.sortBy === "department_code"
            ? `${studentDepartmentSql()}`
            : studentNameSql();
  const sortDir = input.sortDir === "desc" ? "DESC" : "ASC";
  const page = input.page && input.page > 0 ? input.page : 1;
  const pageSize = input.pageSize && input.pageSize > 0 ? Math.min(input.pageSize, 200) : 200;
  const offset = (page - 1) * pageSize;

  const [rows, totalRow, levels, departments, undergrad, postgrad] = await Promise.all([
    query<StudentRow>(
      `SELECT s.id, s.matric_no, s.level,
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
      `SELECT f.id, f.staff_no, ${staffNameSql()} AS full_name, f.faculty, f.department, f.admin_department
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

/** Distinct department codes found in the matric numbers. */
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
