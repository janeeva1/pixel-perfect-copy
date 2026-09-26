import { randomUUID } from "node:crypto";
import type { RowDataPacket } from "./db";
import { dialect, query, queryOne, transaction, type SqlParam } from "@/server/db";
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
  const rows = await query<
    RowDataPacket & {
      id: string;
      scan_number: string | null;
      last_name: string | null;
      first_name: string | null;
      middle_name: string | null;
    }
  >(
    `SELECT ${config.personAlias}.id, ${config.scanNumber} AS scan_number,
            ${config.personAlias}.last_name, ${config.personAlias}.first_name,
            ${config.personAlias}.middle_name, ${config.name} AS full_name
     FROM ${config.people} ${config.personAlias}`,
  );

  const byNumber = new Map<string, Candidate[]>();
  const byName = new Map<string, string | null>();
  for (const row of rows) {
    const names = nameForms(row.last_name ?? "", row.first_name ?? "", row.middle_name ?? "");
    const candidate: Candidate = { id: row.id, names };
    for (const key of numberKeys(row.scan_number ?? "")) {
      const list = byNumber.get(key) ?? [];
      list.push(candidate);
      byNumber.set(key, list);
    }
    for (const name of names) claim(byName, name, row.id);
  }
  return { byNumber, byName };
}

type Match = { id: string | null; method: "number" | "name" | "none" };

/**
 * Resolve one scan row to a person.
 *
 * The number is the join, and it is compared exactly: "149111" and "14911" are
 * different people. When the number is shared by several staff, the scanned name
 * picks between them, and if the name cannot separate them the row is left
 * unresolved rather than guessed. A name is only used on its own when the scan
 * carried no usable number, and only when exactly one person has that name.
 */
function matchRow(lookup: Lookup, scanNumber: string | null, name: string | null): Match {
  const scannedName = normalizeName(name);

  for (const key of numberKeys(scanNumber ?? "")) {
    const candidates = lookup.byNumber.get(key);
    if (!candidates || candidates.length === 0) continue;
    if (candidates.length === 1) return { id: candidates[0]!.id, method: "number" };

    // Several people hold this number, so the name decides. The staff file
    // lists some people twice under two numbers that differ only by a trailing
    // hyphen (SA1319- and SA1319), and those rows are the same human, so they
    // are not really a choice between two people.
    if (candidates.every((c) => c.names[0] === candidates[0]!.names[0])) {
      return { id: candidates[0]!.id, method: "number" };
    }

    const agreeing = candidates.filter((candidate) => candidate.names.includes(scannedName));
    if (agreeing.length > 0) {
      return { id: agreeing[0]!.id, method: "number" };
    }
    return { id: null, method: "none" };
  }

  if (scannedName) {
    const byName = lookup.byName.get(scannedName);
    if (byName) return { id: byName, method: "name" };
  }
  return { id: null, method: "none" };
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
  const departments = orderedScope(
    normalizeScopeList(input.departments ?? input.departmentCodes, student),
  );
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
    ? orderedScope(
        normalizeScopeList(input.departments ?? input.departmentCodes, kind === "student"),
      )
    : [];
  if (resendDepartments && config.scopeColumns) {
    // Kept as the first department so labels and CSV exports still say
    // something; the junction table is what decides who is expected.
    set("department_code", departments[0] ?? null);
  }

  await transaction(async (connection) => {
    if (fields.length > 0) {
      await connection.execute(`UPDATE ${config.events} SET ${fields.join(", ")} WHERE id = ?`, [
        ...values,
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
  await query(`UPDATE ${config.events} SET status = ?, finalized_at = ? WHERE id = ?`, [
    status,
    status === "finalized" ? new Date() : null,
    eventId,
  ]);
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
    scannedAt: Date;
    personId: string | null;
    method: "number" | "name" | "none";
    inScope: boolean;
    outsideWindow: boolean;
  };

  const prepared: Prepared[] = [];
  for (const row of input.rows) {
    const scanNumber = row.scanNumber?.trim() || null;
    const name = row.name?.trim() || null;
    if (!scanNumber && !name) continue;

    const scannedAt = parseScanTime(row.scannedAt);
    if (!scannedAt) continue; // a row with no usable timestamp is not evidence of attendance

    const match = matchRow(lookup, scanNumber, name);

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
        );
      }
      await connection.query(
        `INSERT INTO ${config.scans}
           (id, event_id, upload_id, scan_number, scanned_name, scanned_at,
            ${config.idColumn}, match_method, in_scope, outside_window)
         VALUES ${placeholders(batch.length, 10)}`,
        values,
      );
    }

    // New scans change the numbers, so an event that was closed goes back to
    // draft rather than pretending to be final.
    await connection.execute(
      `UPDATE ${config.events} SET status = 'draft', finalized_at = NULL WHERE id = ?`,
      [eventId],
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

export async function eventSummary(kind: GroupKind, eventId: string): Promise<EventSummary> {
  const config = GROUPS[kind];
  const event = await getEvent(kind, eventId);
  const [expected, counts, uploads, window] = await Promise.all([
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
  ]);

  const present = Number(counts?.present ?? 0);
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

  const [present, absent, outOfScope, unmatched, uploadList] = await Promise.all([
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
  ]);

  return {
    ...summary,
    presentList: present.map((row) => ({
      ...row,
      first_scan_at: toIso(row.first_scan_at) ?? "",
      last_scan_at: toIso(row.last_scan_at) ?? "",
    })),
    absentList: absent.map((row) => ({ ...row })),
    outOfScopeList: outOfScope.map((row) => ({ ...row })),
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

export { GROUPS, type GroupConfig };
