import { randomUUID } from "node:crypto";
import type { RowDataPacket } from "./db";
import { dialect, query, queryOne, transaction, utcStamp, type SqlParam } from "@/server/db";
import {
  normalizeScopeList,
  staffDepartmentSql,
  staffNameSql,
  staffScanNumberSql,
  staffScopeWhere,
  studentCategorySql,
  studentDepartmentSql,
  studentNameSql,
  studentScanNumberSql,
  studentScopeWhere,
} from "@/server/masters";
import { normalizeName, parseScanTime, percent } from "@/lib/attendance";
import type {
  AbsentRow,
  EventCategory,
  EventResult,
  EventScope,
  EventSummary,
  EventUpload,
  GroupKind,
  OutOfScopeRow,
  PresentRow,
  ScanUploadInput,
  StaffEvent,
  StudentCategory,
  StudentEvent,
  StudentScope,
} from "@/lib/types";
import { departmentsOf, overriddenStaffIds } from "@/server/presence-overrides";

/**
 * One implementation serves both groups. A student event only ever matches
 * students and a staff event only ever matches staff, which is what stops a
 * number that appears in both master lists from resolving to the wrong person.
 */
type GroupConfig = {
  kind: GroupKind;
  events: "student_events" | "staff_events";
  uploads: "student_event_uploads" | "staff_event_uploads";
  scans: "student_scans" | "staff_scans";
  people: "students" | "staff";
  personAlias: "s" | "f";
  idColumn: "student_id" | "staff_id";
  code: "s.matric_no" | "f.staff_no";
  name: string;
  /**
   * The number the machine prints for this group, as a SQL expression over the
   * stored columns. Nothing is stored for it: for a student it is the tail of
   * the matric number, for staff the digits of the staff number.
   */
  scanNumber: string;
  /**
   * Optional: the machine ID column from the master list (e.g., staff_id_on_machine).
   * When present, this is used as the PRIMARY matching key against the scan file's
   * machine ID column.
   */
  machineIdColumn?: string;
  level: string;
  category: string;
  department: string;
  /**
   * Whether this group can be narrowed. Both can: a student event by category,
   * level and department, a staff event by department. Both are narrowed in SQL
   * from the stored columns, so nothing derived is kept on the event.
   */
  scoped: boolean;
  /**
   * Whether the events table itself carries the student-shaped scope columns
   * (`department_code`, `student_category`, `level`). Only the student table
   * does. A staff event is scoped, but it scopes through the junction table
   * alone, so selecting these columns for staff would be a query for columns
   * that do not exist there.
   */
  scopeColumns: boolean;
  /** Junction table holding every department the event covers. */
  departmentTable: string;
  departmentColumn: string;
};

const GROUPS: Record<GroupKind, GroupConfig> = {
  student: {
    kind: "student",
    events: "student_events",
    uploads: "student_event_uploads",
    scans: "student_scans",
    people: "students",
    personAlias: "s",
    idColumn: "student_id",
    code: "s.matric_no",
    name: studentNameSql("s"),
    scanNumber: studentScanNumberSql("s"),
    level: "s.level",
    category: studentCategorySql("s"),
    department: studentDepartmentSql("s"),
    scoped: true,
    scopeColumns: true,
    departmentTable: "student_event_departments",
    departmentColumn: "department_code",
  },
  staff: {
    kind: "staff",
    events: "staff_events",
    uploads: "staff_event_uploads",
    scans: "staff_scans",
    people: "staff",
    personAlias: "f",
    idColumn: "staff_id",
    code: "f.staff_no",
    name: staffNameSql("f"),
    scanNumber: staffScanNumberSql("f"),
    machineIdColumn: "f.staff_id_on_machine",
    level: "NULL",
    category: "NULL",
    department: staffDepartmentSql("f"),
    scoped: true,
    scopeColumns: false,
    departmentTable: "staff_event_departments",
    departmentColumn: "department",
  },
};

const SCAN_CHUNK = 500;
const AMBIGUOUS = null;

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

function timeOnly(value: string | null): string | null {
  if (!value) return null;
  return value.length === 5 ? `${value}:00` : value;
}

// Matching -----------------------------------------------------------------

/**
 * The number the machine prints is the digits out of a stored column: the tail of
 * a student's matric number, or the digits in a staff member's staff number.
 * Some staff numbers are written with a leading zero ("SA 063", "JT 067") and
 * the machine prints them without one, so both spellings are indexed and both
 * are looked up. No number is stored: these are the values the file already
 * holds, worked out when a scan has to be matched.
 */
function numberKeys(value: string): string[] {
  const digits = value.trim();
  if (!digits) return [];
  const trimmed = digits.replace(/^0+(?=\d)/, "");
  return trimmed === digits ? [digits] : [digits, trimmed];
}

type Candidate = { id: string; names: string[] };

type Lookup = {
  /**
   * the number the machine prints -> the people it could mean. There is more
   * than one entry for the staff numbers whose digits collide ("AT 029" and
   * "ST 029" are both 29), and for them the scanned name picks the right person.
   */
  byNumber: Map<string, Candidate[]>;
  /**
   * machine ID from the master list (e.g., staff_id_on_machine) -> people.
   * Used as the PRIMARY matching key when the scan file provides a machine ID column.
   */
  byMachineId: Map<string, Candidate[]>;
  /** normalized name -> person id. A null value means two people share it. */
  byName: Map<string, string | null>;
};

function claim(map: Map<string, string | null>, key: string | null, id: string): void {
  if (!key) return;
  if (!map.has(key)) map.set(key, id);
  else if (map.get(key) !== id) map.set(key, AMBIGUOUS);
}

/**
 * The machine's NAME column does not always print every part of the name in the
 * master file. It writes surname and first name for most people, and adds the
 * middle name for some, in an order of its own. So a candidate is remembered
 * under two names, the full one and the surname-and-first-name one, and a scan
 * counts as agreeing with either. normalizeName sorts the words, so a machine
 * that prints "UKPAI CHINWE" and one that prints "CHINWE UKPAI" both match
 * "CHINWE UKPAI".
 */
function nameForms(lastName: string, firstName: string, middleName: string): string[] {
  const full = normalizeName([lastName, firstName, middleName].join(" "));
  const short = normalizeName([lastName, firstName].join(" "));
  return full === short ? [full] : [full, short];
}

/**
 * Load the whole master list for one group and index it for matching. The
 * number the machine prints is derived from the stored columns, so there is no
 * second copy of it to fall out of date.
 */
async function loadLookup(config: GroupConfig): Promise<Lookup> {
  const hasMachineIdColumn = !!config.machineIdColumn;
  const rows = await query<
    RowDataPacket & {
      id: string;
      scan_number: string | null;
      machine_id: string | null;
      last_name: string | null;
      first_name: string | null;
      middle_name: string | null;
    }
  >(
    `SELECT ${config.personAlias}.id, ${config.scanNumber} AS scan_number,
            ${hasMachineIdColumn ? `${config.machineIdColumn} AS machine_id,` : "NULL AS machine_id,"}
            ${config.personAlias}.last_name, ${config.personAlias}.first_name,
            ${config.personAlias}.middle_name, ${config.name} AS full_name
     FROM ${config.people} ${config.personAlias}`,
  );

  const byNumber = new Map<string, Candidate[]>();
  const byMachineId = new Map<string, Candidate[]>();
  const byName = new Map<string, string | null>();
  for (const row of rows) {
    const names = nameForms(row.last_name ?? "", row.first_name ?? "", row.middle_name ?? "");
    const candidate: Candidate = { id: row.id, names };
    for (const key of numberKeys(row.scan_number ?? "")) {
      const list = byNumber.get(key) ?? [];
      list.push(candidate);
      byNumber.set(key, list);
    }
    if (hasMachineIdColumn && row.machine_id) {
      const key = row.machine_id.trim();
      if (key) {
        const list = byMachineId.get(key) ?? [];
        list.push(candidate);
        byMachineId.set(key, list);
      }
    }
    for (const name of names) claim(byName, name, row.id);
  }
  return { byNumber, byMachineId, byName };
}

type Match = { id: string | null; method: "machine_id" | "number" | "name" | "fuzzy_name" | "none" };

/**
 * Resolve one scan row to a person.
 *
 * Priority order:
 * 1. Machine ID from scan file (matched against staff_id_on_machine)
 * 2. Scan number (derived from staff number digits or machine_id) with name disambiguation
 * 3. Exact name match (when unique)
 * 4. Fuzzy name match (best effort - finds closest name match)
 */
function matchRow(lookup: Lookup, scanNumber: string | null, name: string | null, machineId: string | null): Match {
  const scannedName = normalizeName(name);

  // 1. FIRST: Try machine ID from scan file (highest priority)
  if (machineId) {
    const machineIdKey = machineId.trim();
    if (machineIdKey) {
      const candidates = lookup.byMachineId.get(machineIdKey);
      if (candidates && candidates.length === 1) {
        return { id: candidates[0]!.id, method: "machine_id" };
      }
      if (candidates && candidates.length > 1) {
        // Multiple people with same machine ID - use name to disambiguate
        const scannedNameNorm = normalizeName(name);
        const agreeing = candidates.filter((c) => c.names.includes(scannedNameNorm));
        if (agreeing.length === 1) {
          return { id: agreeing[0]!.id, method: "machine_id" };
        }
        // Multiple matches with same name - unresolved, fall through to other methods
      }
    }
  }

  // 2. SECOND: Try scan number (derived from staff number digits or machine_id)
  let numberMatchFailed = false;
  for (const key of numberKeys(scanNumber ?? "")) {
    const candidates = lookup.byNumber.get(key);
    if (!candidates || candidates.length === 0) {
      numberMatchFailed = true;
      continue;
    }
    if (candidates.length === 1) return { id: candidates[0]!.id, method: "number" };

    // Several people hold this number, so the name decides.
    if (candidates.every((c) => c.names[0] === candidates[0]!.names[0])) {
      return { id: candidates[0]!.id, method: "number" };
    }

    const agreeing = candidates.filter((candidate) => candidate.names.includes(scannedName));
    if (agreeing.length > 0) {
      return { id: agreeing[0]!.id, method: "number" };
    }
    numberMatchFailed = true;
  }

  // 3. THIRD: Exact name match (when unique)
  if (scannedName) {
    const byName = lookup.byName.get(scannedName);
    if (byName) return { id: byName, method: "name" };
  }

  // 4. FOURTH: Fuzzy name match - find closest name match as last resort
  if (scannedName) {
    const fuzzyMatch = findFuzzyNameMatch(lookup.byName, scannedName);
    if (fuzzyMatch) return { id: fuzzyMatch, method: "fuzzy_name" };
  }

  return { id: null, method: "none" };
}

/**
 * Find the closest name match using simple string similarity.
 * Returns the person ID if a sufficiently close match is found.
 */
function findFuzzyNameMatch(byName: Map<string, string | null>, scannedName: string): string | null {
  let bestMatch: string | null = null;
  let bestScore = 0;

  for (const [name, personId] of byName.entries()) {
    if (!personId) continue; // Skip ambiguous names
    const score = stringSimilarity(scannedName, name);
    if (score > bestScore && score >= 0.8) { // 80% similarity threshold
      bestScore = score;
      bestMatch = personId;
    }
  }
  return bestMatch;
}

/**
 * Simple string similarity using Jaro-Winkler-like algorithm.
 * Returns a score between 0 and 1.
 */
function stringSimilarity(a: string, b: string): number {
  if (a === b) return 1;
  if (!a || !b) return 0;

  // Jaro similarity
  const lenA = a.length;
  const lenB = b.length;
  if (lenA === 0 || lenB === 0) return 0;

  const matchDistance = Math.floor(Math.max(lenA, lenB) / 2) - 1;
  const aMatches = new Array(lenA).fill(false);
  const bMatches = new Array(lenB).fill(false);
  let matches = 0;
  let transpositions = 0;

  for (let i = 0; i < lenA; i++) {
    const start = Math.max(0, i - matchDistance);
    const end = Math.min(i + matchDistance + 1, lenB);
    for (let j = start; j < end; j++) {
      if (!bMatches[j] && a[i] === b[j]) {
        aMatches[i] = true;
        bMatches[j] = true;
        matches++;
        break;
      }
    }
  }

  if (matches === 0) return 0;

  let k = 0;
  for (let i = 0; i < lenA; i++) {
    if (!aMatches[i]) continue;
    while (!bMatches[k]) k++;
    if (a[i] !== b[k]) transpositions++;
    k++;
  }

  const jaro = (matches / lenA + matches / lenB + (matches - transpositions / 2) / matches) / 3;

  // Winkler prefix bonus
  let prefix = 0;
  const minLen = Math.min(lenA, lenB, 4);
  for (let i = 0; i < minLen; i++) {
    if (a[i] === b[i]) prefix++;
    else break;
  }

  return jaro + 0.1 * prefix * (1 - jaro);
}

// Events -------------------------------------------------------------------

export type EventInput = EventScope & {
  title: string;
  eventDate: string;
  /** Community Mass or other. Defaults to "other" when not supplied. */
  eventCategory?: EventCategory;
  startTime?: string | null;
  endTime?: string | null;
  notes?: string | null;
  /** Staff department names. Ignored for a student event. */
  departments?: string[] | null;
};

/**
 * A change to an event that already exists. `EventInput` is the create shape,
 * where a title and a date have to be given; a patch carries only what is being
 * changed, so every field is optional. `| undefined` is spelled out because this
 * project compiles with `exactOptionalPropertyTypes`, and a parsed request body
 * types its absent fields as possibly `undefined`.
 */
export type EventPatch = { [Key in keyof EventInput]?: EventInput[Key] | undefined };

/** The `WHERE` fragment for an event's scope, whichever group it belongs to. */
function scopeWhereFor(
  kind: GroupKind,
  scope: {
    category?: StudentCategory | null;
    level?: string | null;
    departmentCodes?: string[] | null;
    departments?: string[] | null;
  },
  params: SqlParam[],
  alias?: string,
): string {
  if (kind === "staff") {
    return staffScopeWhere({ departments: scope.departments ?? [] }, params, alias ?? "f");
  }
  return studentScopeWhere(
    {
      category: scope.category ?? null,
      level: scope.level ?? null,
      departmentCodes: scope.departmentCodes ?? null,
    },
    params,
    alias ?? "s",
  );
}

/** Every department an event covers, in a stable order. Empty means everyone. */
export async function eventDepartments(kind: GroupKind, eventId: string): Promise<string[]> {
  const config = GROUPS[kind];
  const rows = await query<RowDataPacket & { department: string }>(
    `SELECT ${config.departmentColumn} AS department
     FROM ${config.departmentTable}
     WHERE event_id = ?
     ORDER BY ${config.departmentColumn}`,
    [eventId],
  );
  return rows.map((row) => row.department);
}

/** Attach the department list to each event, in one round trip. */
async function withDepartments<T extends { id: string }>(
  kind: GroupKind,
  events: T[],
): Promise<Array<T & { departments: string[] }>> {
  const config = GROUPS[kind];
  if (events.length === 0) return [];

  const ids = events.map((event) => event.id);
  const rows = await query<RowDataPacket & { event_id: string; department: string }>(
    `SELECT event_id, ${config.departmentColumn} AS department
     FROM ${config.departmentTable}
     WHERE event_id IN (${ids.map(() => "?").join(", ")})
     ORDER BY ${config.departmentColumn}`,
    ids as SqlParam[],
  );

  const byEvent = new Map<string, string[]>();
  for (const row of rows) {
    const list = byEvent.get(row.event_id) ?? [];
    list.push(row.department);
    byEvent.set(row.event_id, list);
  }

  return events.map((event) => ({
    ...event,
    departments: byEvent.get(event.id) ?? [],
  }));
}

/**
 * The scope an event carries, for whichever group it belongs to. `departments`
 * has already been loaded from the junction table by the caller.
 */
function scopeOf(event: StudentEvent | StaffEvent): {
  category: StudentCategory | null;
  level: string | null;
  departmentCodes: string[] | null;
  departments: string[] | null;
} {
  const departments = event.departments ?? [];
  if (!("category" in event)) {
    return { category: null, level: null, departmentCodes: null, departments };
  }
  return {
    category: event.category,
    level: event.level,
    departmentCodes: departments.length > 0 ? departments : null,
    departments,
  };
}

/**
 * The departments an event covers, in the order a reader will see them.
 *
 * The event row's own `department_code` is only a label for the list pages and
 * the CSV exports, and those read the junction table back ordered by that
 * column. Storing the caller's first choice instead would let the label say one
 * department while the list beside it starts with another, so the two are sorted
 * together here and the label is taken from the front of the sorted list.
 */
function orderedScope(departments: string[]): string[] {
  return [...departments].sort();
}

export async function createEvent(
  kind: GroupKind,
  input: EventInput,
  actorId: string,
): Promise<StudentEvent | StaffEvent> {
  const config = GROUPS[kind];
  const id = randomUUID();
  const student = kind === "student";
  const departments = orderedScope(normalizeScopeList(input.departments ?? input.departmentCodes));
  const columns = [
    "id",
    "title",
    "event_date",
    "event_category",
    "start_time",
    "end_time",
    ...(student ? ["student_category", "level", "department_code"] : []),
    "notes",
    "status",
    "created_by",
    "updated_at",
  ];

  // The read-back happens after the commit on purpose: getEvent() uses a
  // pooled connection, which cannot see a row the transaction is still holding.
  await transaction(async (connection) => {
    await connection.execute(
      `INSERT INTO ${config.events} (${columns.join(", ")}) VALUES ${placeholders(1, columns.length)}`,
      [
        id,
        input.title,
        input.eventDate,
        // Defaults to "other" so an event created without a choice is still
        // counted in every report; it is never left null.
        input.eventCategory ?? "other",
        timeOnly(input.startTime ?? null),
        timeOnly(input.endTime ?? null),
        ...(student
          ? [
              input.category ?? null,
              input.level ?? null,
              // Kept as the first department so labels and CSV exports still say
              // something; the junction table is what decides who is expected.
              departments[0] ?? null,
            ]
          : []),
        input.notes ?? null,
        "draft",
        actorId,
        utcStamp(),
      ],
    );

    for (const department of departments) {
      await connection.execute(
        `${dialect.insertIgnore} ${config.departmentTable} (event_id, ${config.departmentColumn})
         VALUES (?, ?)`,
        [id, department],
      );
    }

    await connection.execute(
      "INSERT INTO audit_logs (id, actor_id, action, entity, entity_id) VALUES (?, ?, ?, ?, ?)",
      [randomUUID(), actorId, `${kind}_event.created`, `${kind}_events`, id],
    );
  });

  return getEvent(kind, id);
}

type EventRow = RowDataPacket & {
  id: string;
  title: string;
  event_date: string;
  event_category: EventCategory;
  start_time: string | null;
  end_time: string | null;
  category: StudentCategory | null;
  level: string | null;
  department_code: string | null;
  notes: string | null;
  status: "draft" | "finalized";
  created_at: Date;
};

/** Both event tables carry a category; only the student one has the scope columns. */
function eventSelect(config: GroupConfig): string {
  if (!config.scopeColumns) {
    return `SELECT e.id, e.title, e.event_date, e.event_category,
                   e.start_time, e.end_time, e.notes, e.status, e.created_at
             FROM ${config.events} e`;
  }
  return `SELECT e.id, e.title, e.event_date, e.event_category,
                  e.start_time, e.end_time, e.notes, e.status,
                  e.department_code, e.created_at,
                  e.student_category AS category, e.level
          FROM ${config.events} e`;
}

function mapEvent(row: EventRow): StudentEvent | StaffEvent {
  return {
    id: row.id,
    title: row.title,
    event_date: row.event_date,
    event_category: row.event_category,
    start_time: row.start_time,
    end_time: row.end_time,
    category: "category" in row ? row.category : undefined,
    level: "level" in row ? row.level : undefined,
    department_code: "department_code" in row ? row.department_code : undefined,
    notes: row.notes,
    status: row.status,
    created_at: toIso(row.created_at) ?? "",
  } as StudentEvent | StaffEvent;
}

export async function getEvent(
  kind: GroupKind,
  eventId: string,
): Promise<StudentEvent | StaffEvent> {
  const config = GROUPS[kind];
  const row = await queryOne<EventRow>(`${eventSelect(config)} WHERE e.id = ?`, [eventId]);
  if (!row) throw Object.assign(new Error("Event not found."), { status: 404 });
  const [event] = await withDepartments(kind, [mapEvent(row)]);
  return event as StudentEvent | StaffEvent;
}

export async function listEvents(
  kind: GroupKind,
  options: {
    from?: string | undefined;
    to?: string | undefined;
    status?: string | undefined;
    eventCategory?: EventCategory | "all" | undefined;
    limit: number;
  },
): Promise<Array<StudentEvent | StaffEvent>> {
  const config = GROUPS[kind];
  const params: SqlParam[] = [];
  const where = ["1 = 1"];
  if (options.from) {
    where.push("e.event_date >= ?");
    params.push(options.from);
  }
  if (options.to) {
    where.push("e.event_date <= ?");
    params.push(options.to);
  }
  if (options.status === "draft" || options.status === "finalized") {
    where.push("e.status = ?");
    params.push(options.status);
  }
  if (options.eventCategory === "community_mass" || options.eventCategory === "other") {
    where.push("e.event_category = ?");
    params.push(options.eventCategory);
  }

  const rows = await query<EventRow>(
    `${eventSelect(config)}
     WHERE ${where.join(" AND ")}
     ORDER BY e.event_date DESC, e.created_at DESC
     LIMIT ?`,
    [...params, options.limit],
  );
  return withDepartments(kind, rows.map(mapEvent)) as Promise<Array<StudentEvent | StaffEvent>>;
}

/**
 * Change an event that already exists.
 *
 * Only the fields actually present in `input` are written, so a caller can move
 * one thing without restating the rest of the event and accidentally blanking
 * it. The status is deliberately not one of them: settling an event is a
 * separate, deliberate act, and an edit that quietly marked it final would let
 * a typo be signed off by accident.
 *
 * The department rows are replaced rather than merged. The list in the form is
 * the whole scope, so a department left behind that the form no longer shows
 * would go on expecting people who are no longer in it.
 *
 * Note that changing the scope re-reads who is expected, because attendance is
 * worked out from the current master list every time a report runs. That is the
 * same reason re-uploading a corrected master file changes last term's report,
 * and it is why this is an ordinary edit rather than something to refuse once
 * scans have been uploaded.
 */
export async function updateEvent(
  kind: GroupKind,
  eventId: string,
  input: EventPatch,
  actorId: string,
): Promise<StudentEvent | StaffEvent> {
  const config = GROUPS[kind];
  // Throws if the event is not there, so an edit cannot invent one.
  await getEvent(kind, eventId);

  const fields: string[] = [];
  const values: SqlParam[] = [];
  const set = (column: string, value: SqlParam) => {
    fields.push(`${column} = ?`);
    values.push(value);
  };

  if (input.title !== undefined) set("title", input.title);
  if (input.eventDate !== undefined) set("event_date", input.eventDate);
  if (input.eventCategory !== undefined) set("event_category", input.eventCategory);
  if (input.startTime !== undefined) set("start_time", timeOnly(input.startTime ?? null));
  if (input.endTime !== undefined) set("end_time", timeOnly(input.endTime ?? null));
  if (input.notes !== undefined) set("notes", input.notes ?? null);
  if (config.scopeColumns) {
    if (input.category !== undefined) set("student_category", input.category ?? null);
    if (input.level !== undefined) set("level", input.level ?? null);
  }

  const resendDepartments = input.departments !== undefined || input.departmentCodes !== undefined;
  const departments = resendDepartments
    ? orderedScope(normalizeScopeList(input.departments ?? input.departmentCodes))
    : [];
  if (resendDepartments && config.scopeColumns) {
    // Kept as the first department so labels and CSV exports still say
    // something; the junction table is what decides who is expected.
    set("department_code", departments[0] ?? null);
  }

  await transaction(async (connection) => {
    if (fields.length > 0) {
      // updated_at is the stamp hub sync compares, so every edit (not just the
      // ones that replace a column) moves it.
      fields.push("updated_at = ?");
      values.push(utcStamp());
      await connection.execute(`UPDATE ${config.events} SET ${fields.join(", ")} WHERE id = ?`, [
        ...values,
        eventId,
      ]);
    } else if (resendDepartments) {
      // Only the department junction changed, which still leaves the event row
      // alone, so the row's own stamp has to move by hand.
      await connection.execute(`UPDATE ${config.events} SET updated_at = ? WHERE id = ?`, [
        utcStamp(),
        eventId,
      ]);
    }
    if (resendDepartments) {
      await connection.execute(`DELETE FROM ${config.departmentTable} WHERE event_id = ?`, [
        eventId,
      ]);
      for (const department of departments) {
        await connection.execute(
          `${dialect.insertIgnore} ${config.departmentTable} (event_id, ${config.departmentColumn})
           VALUES (?, ?)`,
          [eventId, department],
        );
      }
    }
    await connection.execute(
      "INSERT INTO audit_logs (id, actor_id, action, entity, entity_id) VALUES (?, ?, ?, ?, ?)",
      [randomUUID(), actorId, `${kind}_event.updated`, `${kind}_events`, eventId],
    );
  });

  // Read after the commit: getEvent() uses a pooled connection, which cannot
  // see a row the transaction is still holding.
  return getEvent(kind, eventId);
}

export async function setEventStatus(
  kind: GroupKind,
  eventId: string,
  status: "draft" | "finalized",
): Promise<StudentEvent | StaffEvent> {
  const config = GROUPS[kind];
  await getEvent(kind, eventId);
  await query(
    `UPDATE ${config.events} SET status = ?, finalized_at = ?, updated_at = ? WHERE id = ?`,
    [status, status === "finalized" ? new Date() : null, utcStamp(), eventId],
  );
  return getEvent(kind, eventId);
}

export async function deleteEvent(kind: GroupKind, eventId: string): Promise<void> {
  const config = GROUPS[kind];
  await getEvent(kind, eventId);
  await query(`DELETE FROM ${config.events} WHERE id = ?`, [eventId]);
}

// Uploads ------------------------------------------------------------------

type UploadRow = RowDataPacket & {
  id: string;
  file_name: string;
  label: string | null;
  row_count: number;
  present_count: number;
  out_of_scope_count: number;
  unmatched_count: number;
  uploaded_at: Date;
  uploaded_by: string | null;
};

function mapUpload(row: UploadRow): EventUpload {
  return {
    id: row.id,
    file_name: row.file_name,
    label: row.label,
    row_count: Number(row.row_count),
    present_count: Number(row.present_count),
    out_of_scope_count: Number(row.out_of_scope_count),
    unmatched_count: Number(row.unmatched_count),
    uploaded_at: toIso(row.uploaded_at) ?? "",
    uploaded_by: row.uploaded_by,
  };
}

export async function listUploads(kind: GroupKind, eventId: string): Promise<EventUpload[]> {
  const config = GROUPS[kind];
  const rows = await query<UploadRow>(
    `SELECT id, file_name, label, row_count, present_count, out_of_scope_count, unmatched_count,
            uploaded_at, uploaded_by
     FROM ${config.uploads} WHERE event_id = ? ORDER BY uploaded_at, id`,
    [eventId],
  );
  return rows.map(mapUpload);
}

/**
 * Store one machine export against an event. Every row is kept, including
 * repeats, so clock-in and clock-out can both be shown. A row is matched only
 * against this event's own group, and rows that match somebody outside the
 * event scope are kept as out-of-scope rather than being dropped.
 */
export async function uploadScans(
  kind: GroupKind,
  eventId: string,
  input: ScanUploadInput,
  actorId: string,
): Promise<{ upload: EventUpload; summary: EventSummary }> {
  const config = GROUPS[kind];
  const event = await getEvent(kind, eventId);
  const scope = scopeOf(event);
  const lookup = await loadLookup(config);
  const uploadId = randomUUID();

  const startAt = event.start_time ? ` ${event.start_time}` : null;
  const endAt = event.end_time ? ` ${event.end_time}` : null;

  type Prepared = {
    scanNumber: string | null;
    name: string | null;
    machineId: string | null;
    scannedAt: Date;
    personId: string | null;
    method: "machine_id" | "number" | "name" | "fuzzy_name" | "none";
    inScope: boolean;
    outsideWindow: boolean;
  };

  const prepared: Prepared[] = [];
  for (const row of input.rows) {
    const scanNumber = row.scanNumber?.trim() || null;
    const name = row.name?.trim() || null;
    const machineId = row.machineId?.trim() || null;
    if (!scanNumber && !name && !machineId) continue;

    const scannedAt = parseScanTime(row.scannedAt);
    if (!scannedAt) continue; // a row with no usable timestamp is not evidence of attendance

    const match = matchRow(lookup, scanNumber, name, machineId);

    // A matched person counts only if they are inside the event's scope: the
    // category/level/departments for a student event, the departments for a
    // staff event. An event with no departments expects everyone.
    let inScope = match.id !== null;
    if (match.id !== null) {
      // The scope helper pushes its own values in placeholder order, so the
      // person id has to be appended after it, not before.
      const params: SqlParam[] = [];
      const hit = await queryOne<RowDataPacket & { ok: number }>(
        `SELECT 1 AS ok FROM ${config.people} ${config.personAlias}
         WHERE ${scopeWhereFor(kind, scope, params, config.personAlias)}
           AND ${config.personAlias}.id = ?`,
        [...params, match.id],
      );
      inScope = hit !== null;
    }

    // Advisory flag only: a scan counts, but one that lands on another day or
    // outside the event hours is worth seeing on the report.
    const day = scannedAt.toISOString().slice(0, 10);
    const clock = scannedAt.toISOString().slice(11, 19);
    const outsideWindow =
      day !== event.event_date ||
      (startAt !== null && clock < startAt) ||
      (endAt !== null && clock > endAt);

    prepared.push({
      scanNumber,
      name,
      machineId,
      scannedAt,
      personId: match.id,
      method: match.method,
      inScope,
      outsideWindow,
    });
  }

  const counts = { present: new Set<string>(), outOfScope: new Set<string>(), unmatched: 0 };
  for (const row of prepared) {
    if (row.personId === null) counts.unmatched += 1;
    else if (row.inScope) counts.present.add(row.personId);
    else counts.outOfScope.add(row.personId);
  }

  await transaction(async (connection) => {
    await connection.execute(
      `INSERT INTO ${config.uploads}
         (id, event_id, file_name, label, row_count, present_count, out_of_scope_count,
          unmatched_count, uploaded_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        uploadId,
        eventId,
        input.fileName,
        input.label ?? null,
        prepared.length,
        counts.present.size,
        counts.outOfScope.size,
        counts.unmatched,
        actorId,
      ],
    );

    for (let index = 0; index < prepared.length; index += SCAN_CHUNK) {
      const batch = prepared.slice(index, index + SCAN_CHUNK);
      const values: SqlParam[] = [];
      for (const row of batch) {
        values.push(
          randomUUID(),
          eventId,
          uploadId,
          row.scanNumber,
          row.name,
          row.scannedAt,
          row.personId,
          row.method,
          row.inScope ? 1 : 0,
          row.outsideWindow ? 1 : 0,
          row.machineId,
        );
      }
      await connection.query(
        `INSERT INTO ${config.scans}
           (id, event_id, upload_id, scan_number, scanned_name, scanned_at,
            ${config.idColumn}, match_method, in_scope, outside_window, machine_id)
         VALUES ${placeholders(batch.length, 11)}`,
        values,
      );
    }

    // New scans change the numbers, so an event that was closed goes back to
    // draft rather than pretending to be final.
    await connection.execute(
      `UPDATE ${config.events} SET status = 'draft', finalized_at = NULL, updated_at = ? WHERE id = ?`,
      [utcStamp(), eventId],
    );
    await connection.execute(
      "INSERT INTO audit_logs (id, actor_id, action, entity, entity_id, details) VALUES (?, ?, ?, ?, ?, ?)",
      [
        randomUUID(),
        actorId,
        `${kind}_scans.uploaded`,
        `${kind}_events`,
        eventId,
        JSON.stringify({ file: input.fileName, rows: prepared.length }),
      ],
    );
  });

  const summary = await eventSummary(kind, eventId);
  const upload = (await listUploads(kind, eventId)).find((row) => row.id === uploadId);
  if (!upload) throw new Error("Upload was not stored.");
  return { upload, summary };
}

// Results ------------------------------------------------------------------

async function expectedCount(
  config: GroupConfig,
  kind: GroupKind,
  event: StudentEvent | StaffEvent,
): Promise<number> {
  const params: SqlParam[] = [];
  const where = scopeWhereFor(kind, scopeOf(event), params, config.personAlias);
  const row = await queryOne<RowDataPacket & { total: number }>(
    `SELECT COUNT(*) AS total FROM ${config.people} ${config.personAlias} WHERE ${where}`,
    params,
  );
  return Number(row?.total ?? 0);
}

/**
 * The staff credited present at this event who have no scan of their own.
 *
 * Both halves matter. The grant only applies to a staff event that has an
 * upload, and a person who did scan is dropped from the result, because they are
 * already counted by the scan query and the two sets must not overlap. A student
 * event grants nothing and returns an empty list.
 *
 * `event` is passed rather than re-read so this can run alongside the other
 * summary queries instead of costing another round trip.
 */
async function grantedPresentIds(
  kind: GroupKind,
  eventId: string,
  event: StudentEvent | StaffEvent,
): Promise<string[]> {
  if (kind !== "staff") return [];
  const granted = await overriddenStaffIds(eventId, departmentsOf(event));
  if (granted.length === 0) return [];

  const scanned = await query<RowDataPacket & { id: string }>(
    `SELECT DISTINCT staff_id AS id FROM staff_scans
     WHERE event_id = ? AND in_scope = 1 AND staff_id IS NOT NULL`,
    [eventId],
  );
  const already = new Set(scanned.map((row) => row.id));
  return granted.filter((id) => !already.has(id));
}

export async function eventSummary(kind: GroupKind, eventId: string): Promise<EventSummary> {
  const config = GROUPS[kind];
  const event = await getEvent(kind, eventId);
  const [expected, counts, uploads, window, granted] = await Promise.all([
    expectedCount(config, kind, event),
    queryOne<
      RowDataPacket & { scans: number; present: number; out_of_scope: number; unmatched: number }
    >(
      `SELECT COUNT(*) AS scans,
              COUNT(DISTINCT CASE WHEN in_scope = 1 THEN ${config.idColumn} END) AS present,
              COUNT(DISTINCT CASE WHEN ${config.idColumn} IS NOT NULL AND in_scope = 0
                                  THEN ${config.idColumn} END) AS out_of_scope,
              SUM(CASE WHEN match_method = 'none' THEN 1 ELSE 0 END) AS unmatched
       FROM ${config.scans} WHERE event_id = ?`,
      [eventId],
    ),
    listUploads(kind, eventId),
    queryOne<RowDataPacket & { first_scan: Date | null; last_scan: Date | null }>(
      `SELECT MIN(scanned_at) AS first_scan, MAX(scanned_at) AS last_scan
       FROM ${config.scans} WHERE event_id = ?`,
      [eventId],
    ),
    // The staff credited present without a scan, already reduced to the ones
    // who did not scan, so this total is a count of people rather than a sum of
    // two overlapping sets.
    grantedPresentIds(kind, eventId, event),
  ]);

  const present = Number(counts?.present ?? 0) + granted.length;
  const outOfScope = Number(counts?.out_of_scope ?? 0);
  const unmatched = Number(counts?.unmatched ?? 0);

  return {
    event,
    uploads: uploads.length,
    scans: Number(counts?.scans ?? 0),
    expected,
    present,
    absent: Math.max(expected - present, 0),
    outOfScope,
    unmatched,
    percent: percent(present, expected),
    firstScanAt: toIso(window?.first_scan),
    lastScanAt: toIso(window?.last_scan),
  } as EventSummary;
}

/** The person columns the result tables show, for one group. */
function personColumns(config: GroupConfig): string {
  const alias = config.personAlias;
  const shared = `${alias}.id AS person_id, ${config.name} AS name, ${config.code} AS code`;
  if (!config.scoped) {
    return `${shared}, NULL AS level, NULL AS category, NULL AS department_code`;
  }
  return `${shared}, ${config.level} AS level, ${config.category} AS category, ${config.department} AS department_code`;
}

function personGroupBy(config: GroupConfig): string {
  const alias = config.personAlias;
  const shared = `${alias}.id, ${config.name}, ${config.code}`;
  if (!config.scoped) return shared;
  return `${shared}, ${config.level}, ${config.category}, ${config.department}`;
}

/** Everything the event page shows: totals, the three lists and the uploads. */
export async function eventResult(kind: GroupKind, eventId: string): Promise<EventResult> {
  const config = GROUPS[kind];
  const event = await getEvent(kind, eventId);
  const alias = config.personAlias;
  const columns = personColumns(config);
  const groupBy = personGroupBy(config);
  const summary = await eventSummary(kind, eventId);

  const scopeParams: SqlParam[] = [];
  const scopeWhere = scopeWhereFor(kind, scopeOf(event), scopeParams, alias);

  const [scannedPresent, absent, outOfScope, unmatched, uploadList, granted] = await Promise.all([
    query<RowDataPacket & PresentRow>(
      `SELECT ${columns}, COUNT(*) AS scan_count,
              MIN(sc.scanned_at) AS first_scan_at, MAX(sc.scanned_at) AS last_scan_at
       FROM ${config.scans} sc
       JOIN ${config.people} ${alias} ON ${alias}.id = sc.${config.idColumn}
       WHERE sc.event_id = ? AND sc.in_scope = 1
       GROUP BY ${groupBy}
       ORDER BY name`,
      [eventId],
    ),
    // Not filtered against the grants here: granted ids are not known yet at this
    // point in the Promise.all, so the exclusion happens once both halves are
    // in hand, a few lines below. A person ends up in exactly one of the two
    // lists.
    query<RowDataPacket & AbsentRow>(
      `SELECT ${columns}
       FROM ${config.people} ${alias}
       WHERE ${scopeWhere}
         AND ${alias}.id NOT IN (
           SELECT ${config.idColumn} FROM ${config.scans}
           WHERE event_id = ? AND in_scope = 1 AND ${config.idColumn} IS NOT NULL)
       ORDER BY name`,
      [...scopeParams, eventId],
    ),
    query<RowDataPacket & OutOfScopeRow>(
      `SELECT ${columns}, COUNT(*) AS scan_count
       FROM ${config.scans} sc
       JOIN ${config.people} ${alias} ON ${alias}.id = sc.${config.idColumn}
       WHERE sc.event_id = ? AND sc.${config.idColumn} IS NOT NULL AND sc.in_scope = 0
       GROUP BY ${groupBy}
       ORDER BY name`,
      [eventId],
    ),
    query<
      RowDataPacket & {
        scan_id: string;
        scan_number: string | null;
        scanned_name: string | null;
        scan_count: number;
        first_scan_at: Date;
        last_scan_at: Date;
      }
    >(
      `SELECT MIN(id) AS scan_id, scan_number, scanned_name, COUNT(*) AS scan_count,
              MIN(scanned_at) AS first_scan_at, MAX(scanned_at) AS last_scan_at
       FROM ${config.scans}
       WHERE event_id = ? AND match_method = 'none'
       GROUP BY scan_number, scanned_name
       ORDER BY scan_count DESC, scanned_name
       LIMIT 500`,
      [eventId],
    ),
    listUploads(kind, eventId),
    grantedPresentIds(kind, eventId, event),
  ]);

  // The granted rows, joined to their people so the present table shows a name
  // rather than an id. scan_count is 0 and the scan times are empty strings,
  // which is the honest reading: present, with no scan behind it.
  const grantedPeople = await query<RowDataPacket & PresentRow>(
    `SELECT ${columns}, 0 AS scan_count, NULL AS first_scan_at, NULL AS last_scan_at
     FROM ${config.people} ${alias}
     WHERE ${alias}.id IN (${granted.map(() => "?").join(", ")})`,
    granted,
  );

  const presentList = [
    ...scannedPresent.map((row) => ({
      ...row,
      first_scan_at: toIso(row.first_scan_at) ?? "",
      last_scan_at: toIso(row.last_scan_at) ?? "",
    })),
    ...grantedPeople.map((row) => ({
      ...row,
      first_scan_at: "",
      last_scan_at: "",
    })),
  ].sort((a, b) => a.name.localeCompare(b.name));

  const grantedSet = new Set(granted);
  const absentList = absent.filter((row) => !grantedSet.has(row.person_id));

  return {
    ...summary,
    presentList,
    absentList: absentList.map((row) => ({ ...row })),
    outOfScopeList: outOfScope.map((row) => ({ ...row })),
    // True when any row in presentList was granted rather than scanned, so the
    // event page can say the present count includes overrides instead of
    // leaving the reader to infer it from a zero in the scan column.
    hasGrantedPresence: granted.length > 0,
    unmatchedList: unmatched.map((row) => ({
      scan_id: row.scan_id,
      scan_number: row.scan_number,
      scanned_name: row.scanned_name,
      scan_count: Number(row.scan_count),
      first_scan_at: toIso(row.first_scan_at) ?? "",
      last_scan_at: toIso(row.last_scan_at) ?? "",
    })),
    uploadList,
  };
}

export { GROUPS, loadLookup, matchRow, stringSimilarity, findFuzzyNameMatch, type GroupConfig, type Lookup, type Match };
