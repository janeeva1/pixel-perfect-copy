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
import { addMissingExpectations, refreshMassExpectations, syncMassWeekdays } from "@/server/mass";
import {
  matricKey,
  staffCanonicalMap,
  staffIdentityKeys,
  staffNameKey,
  staffNumberDigits,
  studentCanonicalMap,
  type StaffIdentityRow,
  type StudentIdentityRow,
} from "@/server/identity";

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
  staffIdOnMachine: string | null;
  designation: string | null;
  staffCategory: string | null;
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
  return `COALESCE(NULLIF(TRIM(${alias}.staff_id_on_machine), ''), NULLIF(TRIM(${alias}.machine_id), ''), NULLIF(REGEXP_REPLACE(${alias}.staff_no, '[^0-9]', ''), ''))`;
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
  // Only staff on the registrar's current list are expected anywhere. Someone
  // a complete-list import left out still matches a scan (as out of scope).
  const current = `COALESCE(${alias}.on_current_list, 1) = 1`;
  const departments = normalizeScopeList(scope.departments);
  if (departments.length === 0) return current;
  const placeholders = departments.map(() => "?").join(", ");
  params.push(...departments);
  return `${current} AND (${staffDepartmentSql(alias)}) IN (${placeholders})`;
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
 * The registrar's student file does not carry a department column, but the
 * department is encoded in the matric number: VUG/<department>/... for
 * undergraduates and VPG/<programme>/<department>/... for postgraduates. These
 * are the codes seen in the university's own files, mapped to the department
 * spellings the staff file uses so both lists meet at the same weekday.
 */
const STUDENT_DEPARTMENT_BY_CODE: Record<string, string> = {
  ACC: "Accounting",
  ANA: "Medical Sciences",
  ARI: "Software Engineering",
  BCH: "Biochemistry",
  BFN: "Finance",
  BNS: "Nursing Sciences",
  BST: "Theology",
  BUS: "Business Administration",
  CEG: "Computer Engineering",
  CHM: "Pure and Applied Chemistry",
  CSC: "Computer and Information Technology",
  CYS: "Computer and Information Technology",
  DSC: "Software Engineering",
  EBU: "Science Education",
  ECH: "Science Education",
  ECS: "Science Education",
  EEC: "Arts and Social Science Education",
  EEM: "Educational Foundations",
  EEN: "Arts and Social Science Education",
  EEG: "Electrical and Electronic Engineering",
  ENG: "English and Literary Studies",
  ENT: "Entrepreneurship",
  GCE: "Guidance and Counselling",
  GPY: "Guidance and Counselling",
  HIS: "History and International Relations",
  HIR: "History and International Relations",
  IFS: "Computer and Information Technology",
  LAW: "Law",
  MAC: "Mass Communication",
  MBS: "Medical Sciences",
  MCB: "Microbiology",
  MDS: "Medical Sciences",
  MLS: "Medical Laboratory Sciences",
  MKT: "Marketing",
  PCS: "Peace And Conflict Studies",
  PHL: "Philosophy",
  PHM: "Pharmacy",
  PHY: "Pure and Applied Physics",
  PIO: "Medical Sciences",
  POL: "Political Science and Diplomacy",
  PUB: "Public Administration",
  RCS: "Religion and Intercultural Studies",
  RED: "Arts and Social Science Education",
  SEN: "Software Engineering",
  THA: "Theatre Arts",
  THE: "Theology",
};

/** The department a student record belongs to, from the file or the matric number. */
function studentDepartment(matricNo: string, provided: string | null): string | null {
  const given = nullIfBlank(provided);
  if (given) return STUDENT_DEPARTMENT_BY_CODE[given.toUpperCase()] ?? given;

  const parts = matricNo
    .toUpperCase()
    .split("/")
    .map((part) => part.trim());
  const prefix = parts[0];
  const code =
    prefix === "VUG" || prefix === "VUGS" ? parts[1] : prefix === "VPG" ? parts[2] : undefined;
  return code ? (STUDENT_DEPARTMENT_BY_CODE[code] ?? null) : null;
}

/**
 * Stores an uploaded student list. matric_no is the natural key, so a corrected
 * re-upload updates the same rows instead of creating duplicates. The file's id
 * column is not stored (it repeats the matric number), and neither is the
 * category, which is derived from the matric number. The department's full name
 * and the marital status are stored as the file spells them: they are the file's
 * own text, kept for display, for scoping and for the Sunday Mass rule. When the
 * file has no department, the matric number supplies it.
 */
export async function importStudents(
  records: StudentInput[],
  actorId: string,
): Promise<ImportResult> {
  const parsed = records
    .filter((record) => record.matricNo.trim() !== "")
    .map((record) => {
      const matric = record.matricNo.trim();
      return {
        matric,
        lastName: nullIfBlank(record.lastName),
        firstName: nullIfBlank(record.firstName),
        middleName: nullIfBlank(record.middleName),
        level: nullIfBlank(record.level),
        department: studentDepartment(matric, record.department),
        maritalStatus: nullIfBlank(record.maritalStatus),
      };
    });

  // Each row updates the student already on the list with the same matric
  // number -- compared with case, spaces, punctuation and leading zeros
  // ignored, so a file that writes "vug/csc/25/01001" updates
  // "VUG/CSC/25/1001" instead of adding the same student a second time -- and
  // only a student not on the list is added.
  const result = await transaction(async (connection) => {
    let saved = 0;
    let skipped = 0;
    const [existing] = await connection.query<Array<RowDataPacket & StudentIdentityRow>>(
      "SELECT id, matric_no, updated_at FROM students",
    );
    const canonical = studentCanonicalMap(existing);
    const byKey = new Map<string, string>();
    const byExact = new Map<string, string>();
    for (const row of existing) {
      const key = matricKey(row.matric_no);
      if (key && !byKey.has(key)) byKey.set(key, canonical.get(row.id) ?? row.id);
      if (row.matric_no) byExact.set(row.matric_no, row.id);
    }

    const now = utcStamp();
    for (const record of parsed) {
      if (!record.lastName && !record.firstName) skipped += 1;
      const key = matricKey(record.matric);
      const targetId = byExact.get(record.matric) ?? (key ? byKey.get(key) : undefined);
      if (targetId) {
        // Keep the file's spelling of the matric number unless another record
        // already holds that exact text (matric_no is unique).
        const holder = byExact.get(record.matric);
        const matric = holder === undefined || holder === targetId ? record.matric : null;
        await connection.execute(
          `UPDATE students SET matric_no = COALESCE(?, matric_no), last_name = ?, first_name = ?,
             middle_name = ?, level = ?, department = ?, marital_status = ?, updated_at = ?
           WHERE id = ?`,
          [
            matric,
            record.lastName,
            record.firstName,
            record.middleName,
            record.level,
            record.department,
            record.maritalStatus,
            now,
            targetId,
          ],
        );
        if (matric) byExact.set(matric, targetId);
      } else {
        const id = randomUUID();
        await connection.execute(
          `INSERT INTO students
             (id, matric_no, last_name, first_name, middle_name, level, department,
              marital_status, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            id,
            record.matric,
            record.lastName,
            record.firstName,
            record.middleName,
            record.level,
            record.department,
            record.maritalStatus,
            now,
          ],
        );
        byExact.set(record.matric, id);
        if (key) byKey.set(key, id);
      }
      saved += 1;
    }

    await audit(connection, actorId, "students.imported", "students", { saved, skipped });
    return { saved, skipped };
  });

  // Fold together any records that are one student (e.g. created on another
  // computer, or by an older version of this import).
  const merged = await deduplicateStudents(actorId);
  (await import("@/server/rematch")).markStale("student");
  // Students added by this import are expected in the weeks already running.
  await addMissingExpectations("student");

  // Ensure any new departments from this import get a weekday assignment.
  await syncMassWeekdays(actorId);
  return { ...result, duplicatesMerged: merged.duplicatesRemoved };
}

/**
 * Stores an uploaded staff list, updating the people already on it and adding
 * the new ones. Each row of the file is matched to an existing record in this
 * order, and the first that finds exactly one record wins:
 *
 *   1. the same staff number, ignoring spaces and case ("SA 534" = "sa534");
 *   2. the same person by the identity rule in src/server/identity.ts: same
 *      name AND the same staff-number digits ("SA 534" and "SAC534") or the
 *      same machine number;
 *   3. for a row with no staff number, the one record with no staff number and
 *      the same name.
 *
 * Matching by exact text alone is what produced duplicates: the registrar's
 * newer file writes many numbers differently, so every one of those people was
 * added a second time and then shown as both present and absent.
 *
 * A matched record takes the file's values, including its spelling of the
 * staff number. Machine numbers are only overwritten when the file has them,
 * so one set by hand on the Staff page is not wiped by a file without the
 * column. A row with neither a staff number nor a name cannot be identified and
 * is counted as skipped.
 */
export async function importStaff(
  records: StaffInput[],
  actorId: string,
  options: { completeList?: boolean } = {},
): Promise<ImportResult> {
  const parsed = records.map((record) => ({
    staffNo: nullIfBlank(record.staffNo),
    lastName: nullIfBlank(record.lastName),
    firstName: nullIfBlank(record.firstName),
    middleName: nullIfBlank(record.middleName),
    faculty: nullIfBlank(record.faculty),
    department: nullIfBlank(record.department),
    adminDepartment: nullIfBlank(record.adminDepartment),
    machineId: nullIfBlank(record.machineId),
    staffIdOnMachine: nullIfBlank(record.staffIdOnMachine),
    designation: nullIfBlank(record.designation),
    staffCategory: nullIfBlank(record.staffCategory),
  }));
  const usable = parsed.filter((record) => record.staffNo !== null || personName(record));

  const result = await transaction(async (connection) => {
    const [existing] = await connection.query<Array<RowDataPacket & StaffIdentityRow>>(
      `SELECT id, staff_no, last_name, first_name, middle_name, staff_id_on_machine, machine_id,
              updated_at
         FROM staff`,
    );

    // Indexes over the records as they stand, kept current as the file is applied.
    const compactNo = (value: string | null | undefined) =>
      (value ?? "").toUpperCase().replace(/\s+/g, "");
    const rowsById = new Map<string, StaffIdentityRow>();
    const byNumber = new Map<string, string>();
    const byKey = new Map<string, Set<string>>();
    const byNameNoNumber = new Map<string, Set<string>>();
    const index = (row: StaffIdentityRow) => {
      rowsById.set(row.id, row);
      if (row.staff_no) byNumber.set(compactNo(row.staff_no), row.id);
      for (const key of staffIdentityKeys(row)) {
        byKey.set(key, (byKey.get(key) ?? new Set()).add(row.id));
      }
      const name = staffNameKey(row);
      if (!row.staff_no && name) {
        byNameNoNumber.set(name, (byNameNoNumber.get(name) ?? new Set()).add(row.id));
      }
    };
    const unindex = (row: StaffIdentityRow) => {
      if (row.staff_no && byNumber.get(compactNo(row.staff_no)) === row.id) {
        byNumber.delete(compactNo(row.staff_no));
      }
      for (const key of staffIdentityKeys(row)) byKey.get(key)?.delete(row.id);
      byNameNoNumber.get(staffNameKey(row))?.delete(row.id);
    };
    for (const row of existing) index(row);
    // When the list already holds twins, the file updates the one that stands
    // for the person (the merge tool can then remove the other).
    const canonical = staffCanonicalMap(existing);

    let created = 0;
    let updated = 0;
    const now = utcStamp();
    const inFile = new Set<string>();
    for (const record of usable) {
      const asRow: StaffIdentityRow = {
        id: "",
        staff_no: record.staffNo,
        last_name: record.lastName,
        first_name: record.firstName,
        staff_id_on_machine: record.staffIdOnMachine,
        machine_id: record.machineId,
      };

      let targetId: string | null = null;
      if (record.staffNo) targetId = byNumber.get(compactNo(record.staffNo)) ?? null;
      if (!targetId) {
        const found = new Set<string>();
        for (const key of staffIdentityKeys(asRow)) {
          for (const id of byKey.get(key) ?? []) found.add(canonical.get(id) ?? id);
        }
        if (found.size === 1) targetId = [...found][0]!;
      }
      if (!targetId && !record.staffNo) {
        const sameName = byNameNoNumber.get(staffNameKey(asRow));
        if (sameName && sameName.size === 1) targetId = [...sameName][0]!;
      }

      if (targetId) {
        // The file's spelling of the staff number is kept, unless another
        // record already holds it (staff_no is unique).
        const holder = record.staffNo ? byNumber.get(compactNo(record.staffNo)) : undefined;
        const staffNo =
          record.staffNo && (holder === undefined || holder === targetId)
            ? record.staffNo
            : (rowsById.get(targetId)?.staff_no ?? null);
        await connection.execute(
          `UPDATE staff SET
             staff_no = ?, last_name = ?, first_name = ?, middle_name = ?, faculty = ?,
             department = ?, admin_department = ?,
             machine_id = COALESCE(?, machine_id),
             staff_id_on_machine = COALESCE(?, staff_id_on_machine),
             designation = ?, staff_category = ?, updated_at = ?
           WHERE id = ?`,
          [
            staffNo,
            record.lastName,
            record.firstName,
            record.middleName,
            record.faculty,
            record.department,
            record.adminDepartment,
            record.machineId,
            record.staffIdOnMachine,
            record.designation,
            record.staffCategory,
            now,
            targetId,
          ],
        );
        const before = rowsById.get(targetId);
        if (before) unindex(before);
        index({
          id: targetId,
          staff_no: staffNo,
          last_name: record.lastName,
          first_name: record.firstName,
          staff_id_on_machine: record.staffIdOnMachine ?? before?.staff_id_on_machine ?? null,
          machine_id: record.machineId ?? before?.machine_id ?? null,
        });
        inFile.add(targetId);
        updated += 1;
        continue;
      }

      const id = randomUUID();
      await connection.execute(
        `INSERT INTO staff (id, staff_no, last_name, first_name, middle_name, faculty, department,
                            admin_department, machine_id, staff_id_on_machine, designation,
                            staff_category, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          id,
          record.staffNo,
          record.lastName,
          record.firstName,
          record.middleName,
          record.faculty,
          record.department,
          record.adminDepartment,
          record.machineId,
          record.staffIdOnMachine,
          record.designation,
          record.staffCategory,
          now,
        ],
      );
      index({ ...asRow, id });
      inFile.add(id);
      created += 1;
    }

    // Everyone in the file is on the registrar's current list. When the file IS
    // the complete list (staffdb.xlsx), everyone else is not: they stop being
    // expected, but stay on record and still match a scan. Importing a file
    // that includes them again puts them back.
    const ids = [...inFile];
    for (let index = 0; index < ids.length; index += 400) {
      const batch = ids.slice(index, index + 400);
      await connection.execute(
        `UPDATE staff SET on_current_list = 1 WHERE id IN (${batch.map(() => "?").join(", ")})`,
        batch,
      );
    }
    let leftOff = 0;
    if (options.completeList && ids.length > 0) {
      const [current] = await connection.query<Array<RowDataPacket & { id: string }>>(
        "SELECT id FROM staff WHERE on_current_list = 1",
      );
      const notInFile = current.map((row) => row.id).filter((id) => !inFile.has(id));
      for (let index = 0; index < notInFile.length; index += 400) {
        const batch = notInFile.slice(index, index + 400);
        await connection.execute(
          `UPDATE staff SET on_current_list = 0, updated_at = ?
            WHERE id IN (${batch.map(() => "?").join(", ")})`,
          [now, ...batch],
        );
      }
      leftOff = notInFile.length;
    }

    const skipped = records.length - usable.length;
    await audit(connection, actorId, "staff.imported", "staff", {
      created,
      updated,
      skipped,
      completeList: Boolean(options.completeList),
      notOnCurrentList: leftOff,
    });
    return { saved: created + updated, skipped, notOnCurrentList: leftOff };
  });

  // Fold together any rows that are certainly one person (same name and same
  // staff or machine number), whether this file or an earlier one created
  // them, so the list holds each member of staff once. Only certain matches are
  // merged; look-alikes are left for the review list on the Admin page.
  const merged = await deduplicateStaff(actorId);
  (await import("@/server/rematch")).markStale("staff");
  // Staff added by this import are expected in the weeks already running.
  await addMissingExpectations("staff");
  // After merging, who is left off the current list (a merged twin is not "left off").
  const notOnCurrentList = options.completeList
    ? Number(
        (
          await queryOne<CountRow>(
            "SELECT COUNT(*) AS total FROM staff WHERE COALESCE(on_current_list, 1) = 0",
          )
        )?.total ?? 0,
      )
    : 0;

  // Ensure any new departments from this import get a weekday assignment.
  await syncMassWeekdays(actorId);
  return { ...result, notOnCurrentList, duplicatesMerged: merged.duplicatesRemoved };
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
  staffIdOnMachine?: string | null | undefined;
  designation?: string | null | undefined;
  staffCategory?: string | null | undefined;
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

// Staff deduplication -----------------------------------------------------
//
// Rows are merged only when they are the same person by the one identity rule
// every part of the app uses (src/server/identity.ts): the same name AND either
// the same staff-number digits ("SA 534" and "SAC534") or the same machine
// number. Those are the duplicates a re-import of the registrar's file leaves.
// Anything that looks alike on only one of those -- a shared machine number
// with different names, or a shared name with different numbers -- is listed
// for a person to review and is never merged automatically, because the
// machine really does print one number for two people, and two members of
// staff really can share a name.
//
// A group is also left for review if its rows carry two different staff-number
// digits, since that is more likely two people than one person entered twice.
//
// Note on sync: deletes do not travel to the hub (see src/server/sync.ts). Merge
// on every machine that has the duplicates, or the removed row comes back from
// the hub on the next pull. Until then nothing is miscounted: Weekly Mass and
// scan matching already treat the twins as one person.

type StaffDupRow = RowDataPacket &
  StaffIdentityRow & {
    middle_name: string | null;
  };

export type StaffDuplicateGroup = {
  /** Why the rows were grouped. */
  key: string;
  canonicalId: string;
  canonicalName: string;
  duplicateIds: string[];
  names: string[];
  /** Set when the group is listed for review instead of being merged. */
  reason?: string;
};

function dupDisplayName(row: StaffDupRow): string {
  const name = [row.last_name, row.first_name, row.middle_name].filter(Boolean).join(" ").trim();
  return row.staff_no ? `${name} (${row.staff_no})` : name;
}

function toGroup(
  key: string,
  rows: StaffDupRow[],
  canonicalId: string,
  reason?: string,
): StaffDuplicateGroup {
  const canonical = rows.find((row) => row.id === canonicalId) ?? rows[0]!;
  return {
    key,
    canonicalId: canonical.id,
    canonicalName: dupDisplayName(canonical),
    duplicateIds: rows.filter((row) => row.id !== canonical.id).map((row) => row.id),
    names: rows.map(dupDisplayName),
    ...(reason ? { reason } : {}),
  };
}

async function findStaffDuplicates(
  run: <T>(sql: string) => Promise<T[]>,
): Promise<{ mergeable: StaffDuplicateGroup[]; needsReview: StaffDuplicateGroup[] }> {
  const rows = await run<StaffDupRow>(
    `SELECT id, staff_no, last_name, first_name, middle_name, staff_id_on_machine, machine_id,
            updated_at
       FROM staff`,
  );
  const canonical = staffCanonicalMap(rows);
  const person = (row: StaffDupRow) => canonical.get(row.id) ?? row.id;

  const people = new Map<string, StaffDupRow[]>();
  for (const row of rows) people.set(person(row), [...(people.get(person(row)) ?? []), row]);

  const mergeable: StaffDuplicateGroup[] = [];
  const needsReview: StaffDuplicateGroup[] = [];
  for (const [id, group] of people) {
    if (group.length < 2) continue;
    const digits = new Set(group.map((row) => staffNumberDigits(row.staff_no)).filter(Boolean));
    if (digits.size > 1) {
      needsReview.push(
        toGroup(`person ${id}`, group, id, "Same name, but the staff numbers differ."),
      );
    } else {
      mergeable.push(toGroup(`person ${id}`, group, id));
    }
  }

  // Look-alikes that are different people by the rule: shown, never merged.
  const lookAlikes = (keyOf: (row: StaffDupRow) => string[], label: string, reason: string) => {
    const groups = new Map<string, StaffDupRow[]>();
    for (const row of rows) {
      for (const key of keyOf(row)) groups.set(key, [...(groups.get(key) ?? []), row]);
    }
    for (const [key, group] of groups) {
      // One representative per person; only flag when 2+ different people share the key.
      const byPerson = new Map<string, StaffDupRow>();
      for (const row of group) if (!byPerson.has(person(row))) byPerson.set(person(row), row);
      if (byPerson.size < 2) continue;
      const representatives = [...byPerson.values()];
      needsReview.push(toGroup(`${label} ${key}`, representatives, representatives[0]!.id, reason));
    }
  };
  lookAlikes(
    (row) =>
      [row.staff_id_on_machine, row.machine_id]
        .map((value) => (value ?? "").trim().replace(/^0+(?=\d)/, ""))
        .filter((value, index, all) => value !== "" && all.indexOf(value) === index),
    "machine",
    "Same machine number, different names: the machine prints one number for both. Check they are different people.",
  );
  lookAlikes(
    (row) => {
      const name = staffNameKey(row);
      return name ? [name] : [];
    },
    "name",
    "Same name, different numbers: may be two people with the same name.",
  );

  return { mergeable, needsReview };
}

/** What `deduplicateStaff` would merge, plus the groups left for a person to check. */
export async function previewStaffDeduplication(): Promise<{
  mergeable: StaffDuplicateGroup[];
  needsReview: StaffDuplicateGroup[];
}> {
  return findStaffDuplicates((sql) => query(sql));
}

/**
 * Merge the staff rows that are provably the same person (same machine number
 * and same name). Their scans and Mass expectations are moved onto the row that
 * is kept, then the extra rows are removed. Everything happens in one
 * transaction, so a failure leaves the list exactly as it was.
 */
/**
 * Fold duplicate records of one person into the record that is kept: their
 * event scans, Weekly Mass scans and Mass expectations move to it, then the
 * extra records are removed. Returns how many scans were moved. Runs inside
 * the caller's transaction, so a failure leaves everything as it was.
 */
export async function mergeInto(
  connection: DbConnection,
  kind: "student" | "staff",
  canonicalId: string,
  ids: string[],
  now: string,
): Promise<number> {
  if (ids.length === 0) return 0;
  const table = kind === "staff" ? "staff" : "students";
  const scans = kind === "staff" ? "staff_scans" : "student_scans";
  const column = kind === "staff" ? "staff_id" : "student_id";
  const marks = ids.map(() => "?").join(", ");

  const [counted] = await connection.query<Array<RowDataPacket & { total: number }>>(
    `SELECT
       (SELECT COUNT(*) FROM ${scans} WHERE ${column} IN (${marks})) +
       (SELECT COUNT(*) FROM mass_scans
        WHERE participant_type = ? AND person_id IN (${marks})) AS total`,
    [...ids, kind, ...ids],
  );

  await connection.execute(`UPDATE ${scans} SET ${column} = ? WHERE ${column} IN (${marks})`, [
    canonicalId,
    ...ids,
  ]);
  await connection.execute(
    `UPDATE mass_scans SET person_id = ? WHERE participant_type = ? AND person_id IN (${marks})`,
    [canonicalId, kind, ...ids],
  );
  // mass_expected is unique per (week, type, person): drop a duplicate's row
  // where the kept person is already expected that week, then move the rest.
  await connection.execute(
    `DELETE FROM mass_expected
     WHERE participant_type = ? AND person_id IN (${marks})
       AND mass_week_id IN (
         SELECT mass_week_id FROM mass_expected WHERE participant_type = ? AND person_id = ?
       )`,
    [kind, ...ids, kind, canonicalId],
  );
  await connection.execute(
    `UPDATE mass_expected SET person_id = ? WHERE participant_type = ? AND person_id IN (${marks})`,
    [canonicalId, kind, ...ids],
  );
  if (kind === "staff") {
    // The kept record is on the current list if either of them was.
    await connection.execute(
      `UPDATE staff SET on_current_list = 1
        WHERE id = ? AND EXISTS (
          SELECT 1 FROM staff WHERE id IN (${marks}) AND on_current_list = 1)`,
      [canonicalId, ...ids],
    );
  }
  await connection.execute(`DELETE FROM ${table} WHERE id IN (${marks})`, ids);
  await connection.execute(`UPDATE ${table} SET updated_at = ? WHERE id = ?`, [now, canonicalId]);
  return Number(counted[0]?.total ?? 0);
}

export type DeduplicationResult = {
  groupsMerged: number;
  duplicatesRemoved: number;
  scanRecordsUpdated: number;
  needsReview: number;
};

export async function deduplicateStaff(actorId: string): Promise<DeduplicationResult> {
  return transaction(async (connection) => {
    const { mergeable, needsReview } = await findStaffDuplicates(async (sql) => {
      const [rows] = await connection.query(sql);
      return rows as never[];
    });

    let duplicatesRemoved = 0;
    let scanRecordsUpdated = 0;
    const now = utcStamp();
    for (const group of mergeable) {
      scanRecordsUpdated += await mergeInto(
        connection,
        "staff",
        group.canonicalId,
        group.duplicateIds,
        now,
      );
      duplicatesRemoved += group.duplicateIds.length;
    }

    const result = {
      groupsMerged: mergeable.length,
      duplicatesRemoved,
      scanRecordsUpdated,
      needsReview: needsReview.length,
    };
    if (result.groupsMerged > 0) {
      await audit(connection, actorId, "staff.deduplicated", "staff", {
        ...result,
        merged: mergeable.map((group) => ({
          kept: group.canonicalId,
          removed: group.duplicateIds,
        })),
      });
    }
    return result;
  });
}

/**
 * Merge student records that are one student: the same matric number once
 * case, spaces, punctuation and leading zeros are ignored (see
 * src/server/identity.ts). Students with the same name and different matric
 * numbers are different people and are never touched.
 */
export async function deduplicateStudents(actorId: string): Promise<DeduplicationResult> {
  return transaction(async (connection) => {
    const [rows] = await connection.query<Array<RowDataPacket & StudentIdentityRow>>(
      "SELECT id, matric_no, updated_at FROM students",
    );
    const canonical = studentCanonicalMap(rows);
    const groups = new Map<string, string[]>();
    for (const row of rows) {
      const keep = canonical.get(row.id) ?? row.id;
      if (keep !== row.id) groups.set(keep, [...(groups.get(keep) ?? []), row.id]);
    }

    let duplicatesRemoved = 0;
    let scanRecordsUpdated = 0;
    const now = utcStamp();
    for (const [keep, ids] of groups) {
      scanRecordsUpdated += await mergeInto(connection, "student", keep, ids, now);
      duplicatesRemoved += ids.length;
    }

    const result = {
      groupsMerged: groups.size,
      duplicatesRemoved,
      scanRecordsUpdated,
      needsReview: 0,
    };
    if (result.groupsMerged > 0) {
      await audit(connection, actorId, "students.deduplicated", "students", {
        ...result,
        merged: [...groups.entries()].map(([kept, removed]) => ({ kept, removed })),
      });
    }
    return result;
  });
}

/**
 * Merge every certain duplicate in both master lists. Called after anything
 * that can bring a second copy of a person in: a staff or student import, and a
 * synchronization that pulled people created on another computer.
 */
export async function deduplicateEveryone(
  actorId: string,
): Promise<{ staff: DeduplicationResult; students: DeduplicationResult }> {
  return { staff: await deduplicateStaff(actorId), students: await deduplicateStudents(actorId) };
}
