// Report downloads, built so an operator cannot pick one thing and get another.
//
// Every download is described by three independent choices, and each is stated
// back in words before the file is fetched:
//
//   who    students or staff, never both in one file
//   when   one event, one day, one week, one month, or a range you type
//   what   who turned up, who did not, or both
//
// "Absent" over a period means missed *every* event in it, not missed one. A
// person is only counted against the events that actually expected them, so
// someone who was never in scope for the Tuesday Mass is not reported absent
// for it.

import type { RowDataPacket } from "./db";
import { query, type SqlParam } from "@/server/db";
import { GROUPS, type GroupConfig } from "@/server/events";
import { loadIdentity } from "@/server/identity";
import { HttpError } from "@/server/http";
import { toCsv } from "@/lib/attendance";
import { overridesForScope } from "@/server/presence-overrides";
import { EVENT_CATEGORY_LABEL, type EventCategory, type GroupKind } from "@/lib/types";

export type DownloadScopeType = "event" | "day" | "week" | "month" | "range";
export type DownloadDetail = "present" | "absent" | "combined";

export type DownloadRequest = {
  group: GroupKind;
  scopeType: DownloadScopeType;
  /** Required when scopeType is "event". */
  eventId?: string | null;
  /** Anchor for "day", "week" and "month". */
  date?: string | null;
  from?: string | null;
  to?: string | null;
  category: EventCategory | "all";
  detail: DownloadDetail;
  /** Optional further narrowing: a student code or a staff department name. */
  department?: string | null;
};

const DAY_NAMES = [
  "Sunday",
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday",
] as const;
const MONTH_NAMES = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
] as const;

/**
 * Days are worked out in UTC everywhere in this file. The event_date values are
 * plain YYYY-MM-DD strings (see isoDate), so `new Date("2026-09-28")` is
 * midnight UTC and the UTC getters below read back the same day. A local-time
 * getter would report the 27th for anyone west of Greenwich.
 */

/** Always defined: a valid date indexes 0-6 into both name lists. */
function dayName(date: Date): string {
  return DAY_NAMES[date.getUTCDay()] ?? "";
}

function monthName(date: Date): string {
  return MONTH_NAMES[date.getUTCMonth()] ?? "";
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function parseDate(value: string, label: string): Date {
  if (!DATE_RE.test(value)) {
    throw new HttpError(400, `${label} must be a date like 2026-03-02.`);
  }
  const date = new Date(`${value}T00:00:00Z`);
  if (Number.isNaN(date.getTime())) {
    throw new HttpError(400, `${label} is not a real date.`);
  }
  return date;
}

function iso(date: Date): string {
  return date.toISOString().slice(0, 10);
}

/**
 * A DATE column as a plain YYYY-MM-DD day, whichever driver it came from.
 *
 * The two engines disagree here. mysql2 returns a Date, and String() on that
 * writes "Mon Sep 28 2026 00:00:00 GMT+0100 (Coordinated Universal Time)" into
 * the CSV. SQLite keeps the column as text, but that text carries a time part
 * ("2026-09-26 00:00:00"), so passing it through unchanged trades one piece of
 * nonsense for another. An event happens on a day; it has no time of day, so the
 * time is dropped rather than printed as a misleading midnight.
 *
 * Local getters on the Date branch, because the Date is local midnight and
 * toISOString would read it as UTC and shift the day backwards west of Greenwich.
 */
export function isoDate(value: Date | string): string {
  if (typeof value === "string") {
    return /^(\d{4}-\d{2}-\d{2})/.exec(value)?.[1] ?? "";
  }
  if (Number.isNaN(value.getTime())) return "";
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${value.getFullYear()}-${pad(value.getMonth() + 1)}-${pad(value.getDate())}`;
}

/** "Mon 2 Mar 2026", the form a person reads a date in. */
function prettyDate(value: string): string {
  const date = new Date(`${value}T00:00:00Z`);
  return `${dayName(date).slice(0, 3)} ${date.getUTCDate()} ${monthName(date).slice(0, 3)} ${date.getUTCFullYear()}`;
}

/** A week runs Monday to Sunday, which is how the reports bucket them too. */
function weekRange(anchor: Date): { from: string; to: string } {
  const weekday = anchor.getUTCDay();
  const offset = weekday === 0 ? -6 : 1 - weekday;
  const monday = new Date(anchor);
  monday.setUTCDate(anchor.getUTCDate() + offset);
  const sunday = new Date(monday);
  sunday.setUTCDate(monday.getUTCDate() + 6);
  return { from: iso(monday), to: iso(sunday) };
}

function monthRange(anchor: Date): { from: string; to: string } {
  const from = new Date(Date.UTC(anchor.getUTCFullYear(), anchor.getUTCMonth(), 1));
  const to = new Date(Date.UTC(anchor.getUTCFullYear(), anchor.getUTCMonth() + 1, 0));
  return { from: iso(from), to: iso(to) };
}

type EventRow = RowDataPacket & {
  id: string;
  title: string;
  /** A DATE column, so the driver hands back a Date unless it is told not to. */
  event_date: Date | string;
  event_category: EventCategory;
  student_category: string | null;
  level: string | null;
  department_code: string | null;
  departments: string | null;
};

/**
 * An event row after `isoDate`. Written out rather than derived with Omit,
 * because Omit over RowDataPacket's index signature drops the named properties
 * and leaves every field to be read as an index lookup.
 */
type Event = {
  id: string;
  title: string;
  event_date: string;
  event_category: EventCategory;
  student_category: string | null;
  level: string | null;
  department_code: string | null;
  departments: string | null;
};

type PersonRow = RowDataPacket & {
  id: string;
  name: string;
  code: string;
  level: string | null;
  category: string | null;
  department: string | null;
};

/** One event's scope, worked out so a period of events can be checked in JS. */
type EventScope = {
  event: Event;
  /** null means "everyone". */
  category: string | null;
  level: string | null;
  departments: string[] | null;
};

export type ResolvedScope = {
  from: string;
  to: string;
  /** A full sentence, used in the UI and in the CSV's own header comment. */
  periodLabel: string;
  shortLabel: string;
  events: EventScope[];
};

/**
 * Works out which events a request covers, and says so in words.
 *
 * Throws rather than guessing: a request that names an event which is not there,
 * or a range that runs backwards, is a mistake worth telling the operator about
 * instead of quietly returning an empty file.
 */
export async function resolveScope(request: DownloadRequest): Promise<ResolvedScope> {
  const config = GROUPS[request.group];

  const loadEvents = async (from: string, to: string): Promise<EventScope[]> => {
    const params: SqlParam[] = [from, to];
    const categoryClause = request.category === "all" ? "" : " AND e.event_category = ?";
    if (request.category !== "all") params.push(request.category);

    const rows = await query<EventRow>(
      `SELECT e.id, e.title, e.event_date, e.event_category,
              ${config.scopeColumns ? "e.student_category, e.level, e.department_code," : "NULL AS student_category, NULL AS level, NULL AS department_code,"}
              (SELECT GROUP_CONCAT(d.${config.departmentColumn} ORDER BY d.${config.departmentColumn})
                 FROM ${config.departmentTable} d
                WHERE d.event_id = e.id) AS departments
         FROM ${config.events} e
        WHERE e.event_date BETWEEN ? AND ?${categoryClause}
        ORDER BY e.event_date, e.title`,
      params,
    );

    return rows.map((row) => {
      const list = row.departments ? row.departments.split(",").filter(Boolean) : [];
      return {
        // mysql2 hands a DATE column back as a Date at local midnight, and
        // String() on that produces "Mon Sep 28 2026 00:00:00 GMT+0100
        // (Coordinated Universal Time)". The column is a plain date, so it is
        // narrowed to YYYY-MM-DD here, once, at the only place it enters. Using
        // the local getters is deliberate: the Date is local midnight, so
        // reading it as UTC would shift the day backwards for anyone west of
        // Greenwich.
        event: { ...row, event_date: isoDate(row.event_date) },
        category: row.student_category,
        level: row.level,
        departments: list.length > 0 ? list : null,
      };
    });
  };

  if (request.scopeType === "event") {
    if (!request.eventId) {
      throw new HttpError(400, "Choose which event to download.");
    }
    const events = await loadEvents("1000-01-01", "9999-12-31");
    const found = events.filter((scope) => scope.event.id === request.eventId);
    if (found.length === 0) {
      throw new HttpError(
        404,
        request.category === "all"
          ? "That event no longer exists."
          : "That event is not in the selected event type.",
      );
    }
    const only = found[0];
    if (!only) {
      throw new HttpError(404, "That event no longer exists.");
    }
    return {
      from: only.event.event_date,
      to: only.event.event_date,
      periodLabel: `the event "${only.event.title}" on ${prettyDate(only.event.event_date)}`,
      shortLabel: only.event.event_date,
      events: found,
    };
  }

  let from: string;
  let to: string;
  let periodLabel: string;
  let shortLabel: string;

  if (request.scopeType === "range") {
    if (!request.from || !request.to) {
      throw new HttpError(400, "Give both a start and an end date.");
    }
    const start = parseDate(request.from, "The start date");
    const end = parseDate(request.to, "The end date");
    if (start > end) {
      throw new HttpError(400, "The start date is after the end date.");
    }
    from = iso(start);
    to = iso(end);
    periodLabel =
      from === to
        ? `the single day ${prettyDate(from)}`
        : `every event from ${prettyDate(from)} to ${prettyDate(to)}`;
    shortLabel = from === to ? from : `${from}_to_${to}`;
  } else {
    if (!request.date) {
      throw new HttpError(400, "Pick the date this download is about.");
    }
    const anchor = parseDate(request.date, "The date");
    if (request.scopeType === "day") {
      from = to = iso(anchor);
      periodLabel = `every event on ${prettyDate(from)}`;
      shortLabel = from;
    } else if (request.scopeType === "week") {
      ({ from, to } = weekRange(anchor));
      periodLabel = `every event in the week of ${prettyDate(from)} to ${prettyDate(to)}`;
      shortLabel = `${from}_to_${to}`;
    } else {
      ({ from, to } = monthRange(anchor));
      const month = monthName(anchor);
      periodLabel =
        from === to
          ? `every event on ${prettyDate(from)}`
          : `every event in ${month} ${anchor.getUTCFullYear()}`;
      shortLabel = `${month.slice(0, 3)}-${anchor.getUTCFullYear()}`;
    }
  }

  const events = await loadEvents(from, to);
  if (events.length === 0) {
    throw new HttpError(
      404,
      `There are no ${request.group === "student" ? "student" : "staff"} events between ${from} and ${to} for that event type.`,
    );
  }
  return { from, to, periodLabel, shortLabel, events };
}

/**
 * Whether this event expected this person, worked out from the event's scope.
 *
 * The person's category and department come from the same derived SQL the rest of
 * the app uses (`config.category`, `config.department`), rather than being worked
 * out again here from the matric number. Re-deriving it would be a second copy of
 * that rule, and the two would drift.
 */
function expects(scope: EventScope, person: PersonRow): boolean {
  if (scope.category && scope.category !== person.category) return false;
  if (scope.level && scope.level !== person.level) return false;
  if (scope.departments && scope.departments.length > 0) {
    const department = person.department?.trim().toLowerCase();
    if (!department) return false;
    if (!scope.departments.some((d) => d.trim().toLowerCase() === department)) return false;
  }
  return true;
}

/** One person's attendance at one event, as a plain value. */
type Attendance = {
  eventId: string;
  personId: string;
  scans: number;
  first: Date | string | null;
  last: Date | string | null;
};

/** The shape the scan query returns, before it is keyed and narrowed. */
type AttendanceRow = RowDataPacket & Attendance & { scan_count: number };

export type DownloadRow = {
  event: Event;
  person: PersonRow;
  status: "Present" | "Absent";
  attendance: Attendance | null;
  /** How many of the period's events expected this person. */
  expectedCount: number;
  /** How many of those they turned up to. */
  attendedCount: number;
};

export type DownloadResult = {
  rows: DownloadRow[];
  /** People the period expected at least once, before the status filter. */
  peopleCount: number;
  eventsCount: number;
  presentCount: number;
  absentCount: number;
  from: string;
  to: string;
  periodLabel: string;
  shortLabel: string;
};

export async function buildDownload(request: DownloadRequest): Promise<DownloadResult> {
  const config = GROUPS[request.group];
  const student = request.group === "student";
  const scope = await resolveScope(request);
  const eventIds = scope.events.map((s) => s.event.id);

  // The people in scope of at least one event, worked out in SQL as the union of
  // every event's scope. Which event expected whom is then decided in JS, because
  // "absent" has to be measured against the events that expected that person and
  // not against the whole period.
  const union = scope.events.map((s) => {
    const clauses = ["1 = 1"];
    const params: SqlParam[] = [];
    if (student) {
      if (s.category) {
        clauses.push(`(${config.category}) = ?`);
        params.push(s.category);
      }
      if (s.level) {
        clauses.push(`${config.level} = ?`);
        params.push(s.level);
      }
      if (s.departments) {
        clauses.push(`(${config.department}) IN (${s.departments.map(() => "?").join(", ")})`);
        params.push(...s.departments);
      }
    } else if (s.departments) {
      clauses.push(`(${config.department}) IN (${s.departments.map(() => "?").join(", ")})`);
      params.push(...s.departments);
    }
    return { sql: clauses.join(" AND "), params };
  });

  const whereSql =
    `(${union.map((u) => `(${u.sql})`).join(" OR ")})` +
    // Only people on the registrar's current list are expected.
    ` AND COALESCE(${config.personAlias}.on_current_list, 1) = 1`;
  const unionParams = union.flatMap((u) => u.params);

  const rawPeople = await query<PersonRow>(
    `SELECT ${config.personAlias}.id AS id,
            ${config.name} AS name,
            ${config.code} AS code,
            ${config.level} AS level,
            ${config.category} AS category,
            ${config.department} AS department
       FROM ${config.people} ${config.personAlias}
      WHERE ${whereSql}
      ORDER BY ${config.name}`,
    unionParams,
  );

  // One row per PERSON (src/server/identity.ts): master rows that are the same
  // person become one entry under the id that stands for them, expected at an
  // event when any of their rows is, so nobody is listed twice or shown both
  // present and absent.
  const identity = await loadIdentity(request.group);
  const rowsOf = new Map<string, PersonRow[]>();
  for (const row of rawPeople) {
    const key = identity.canonical(row.id);
    rowsOf.set(key, [...(rowsOf.get(key) ?? []), row]);
  }
  const people: PersonRow[] = [...rowsOf.entries()].map(([key, rows]) => ({
    ...(rows.find((row) => row.id === key) ?? rows[0]!),
    id: key,
  }));
  const expectsPerson = (s: EventScope, person: PersonRow) =>
    (rowsOf.get(person.id) ?? [person]).some((row) => expects(s, row));

  const attendanceRows = await query<AttendanceRow>(
    `SELECT event_id AS eventId, ${config.idColumn} AS personId,
            COUNT(*) AS scan_count, MIN(scanned_at) AS first, MAX(scanned_at) AS last
       FROM ${config.scans}
      WHERE in_scope = 1 AND event_id IN (${eventIds.map(() => "?").join(", ")})
      GROUP BY event_id, ${config.idColumn}`,
    eventIds,
  );

  const attendance = new Map<string, Attendance>();
  const earlier = (a: Date | string | null, b: Date | string | null) =>
    a === null ? b : b === null ? a : String(a) <= String(b) ? a : b;
  const later = (a: Date | string | null, b: Date | string | null) =>
    a === null ? b : b === null ? a : String(a) >= String(b) ? a : b;
  for (const row of attendanceRows) {
    if (!row.personId) continue;
    const personId = identity.canonical(row.personId);
    const key = `${row.eventId}:${personId}`;
    const held = attendance.get(key);
    // Scans of two records of one person at the same event are added together.
    attendance.set(key, {
      eventId: row.eventId,
      personId,
      scans: Number(row.scan_count) + (held?.scans ?? 0),
      first: held ? earlier(held.first, row.first) : row.first,
      last: held ? later(held.last, row.last) : row.last,
    });
  }

  // Staff credited present without a scan. Added to the same map as real
  // attendance, with scans 0 and no first/last, so everything downstream reads
  // one shape and cannot forget to count them. A staff download with an
  // override in it is what makes these rows exist at all; a student download
  // gets an empty map (see overridesForScope).
  const granted = await overridesForScope(request.group, scope.events);
  for (const [eventId, staffIds] of granted) {
    for (const grantedId of staffIds) {
      const personId = identity.canonical(grantedId);
      const key = `${eventId}:${personId}`;
      // A real scan always wins: if the person did scan, the scan is the truth
      // and the grant is redundant. Never overwrite one with a zero.
      if (attendance.has(key)) continue;
      attendance.set(key, { eventId, personId, scans: 0, first: null, last: null });
    }
  }

  // Which events expected each person, so "attended 2 of 3" counts only the
  // three they were actually expected at.
  const expectedBy = new Map<string, string[]>();
  for (const s of scope.events) {
    for (const person of people) {
      if (expectsPerson(s, person)) {
        const list = expectedBy.get(person.id) ?? [];
        list.push(s.event.id);
        expectedBy.set(person.id, list);
      }
    }
  }

  const attendedBy = new Map<string, number>();
  for (const s of scope.events) {
    for (const person of people) {
      if (attendance.has(`${s.event.id}:${person.id}`)) {
        attendedBy.set(person.id, (attendedBy.get(person.id) ?? 0) + 1);
      }
    }
  }

  const rows: DownloadRow[] = [];
  for (const s of scope.events) {
    for (const person of people) {
      const expectedIds = expectedBy.get(person.id);
      if (!expectedIds?.includes(s.event.id)) continue;
      const found = attendance.get(`${s.event.id}:${person.id}`) ?? null;
      rows.push({
        event: s.event,
        person,
        status: found ? "Present" : "Absent",
        attendance: found,
        expectedCount: expectedIds.length,
        attendedCount: attendedBy.get(person.id) ?? 0,
      });
    }
  }

  const peopleCount = expectedBy.size;
  const presentCount = [...expectedBy.keys()].filter((id) => (attendedBy.get(id) ?? 0) > 0).length;

  return {
    rows,
    peopleCount,
    eventsCount: scope.events.length,
    presentCount,
    // Absent over a period means missed every one of the events that expected
    // them, so this is a count of people, not of person-event pairs.
    absentCount: peopleCount - presentCount,
    from: scope.from,
    to: scope.to,
    periodLabel: scope.periodLabel,
    shortLabel: scope.shortLabel,
  };
}

/** The period's absences, one row per person, not one per event. */
function absentRows(result: DownloadResult): DownloadResult["rows"] {
  const byPerson = new Map<string, DownloadResult["rows"][number]>();
  for (const row of result.rows) {
    if (row.status !== "Absent") continue;
    const held = byPerson.get(row.person.id);
    if (!held || row.attendance === null) byPerson.set(row.person.id, row);
  }
  return [...byPerson.values()];
}

function stamp(value: Date | string | null): string {
  if (!value) return "";
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  const pad = (n: number) => String(n).padStart(2, "0");
  return (
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ` +
    `${pad(date.getHours())}:${pad(date.getMinutes())}`
  );
}

const DETAIL_WORD: Record<DownloadDetail, string> = {
  present: "present only",
  absent: "absent only (missed every event)",
  combined: "present and absent",
};

const DETAIL_SLUG: Record<DownloadDetail, string> = {
  present: "present",
  absent: "absent",
  combined: "present-and-absent",
};

/**
 * The CSV. One table, no preamble, so Excel sorts and filters it properly. Each
 * row names its own event, date and event type, so a file that gets separated
 * from its filename still says what it is.
 *
 * A UTF-8 BOM goes in front: without one Excel on Windows reads the file as the
 * system code page and mangles any name that is not plain ASCII.
 */
export function downloadCsv(request: DownloadRequest, result: DownloadResult): string {
  const student = request.group === "student";
  const personColumns = student
    ? ["Name", "Matric no", "Level", "Department"]
    : ["Name", "Staff no", "Department"];

  const rows = request.detail === "absent" ? absentRows(result) : result.rows;

  const headers =
    request.detail === "absent"
      ? [...personColumns, "Events expected", "Events attended"]
      : [
          "Event type",
          "Event",
          "Date",
          "Status",
          ...personColumns,
          "Scans",
          "First scan",
          "Last scan",
          // Staff only. A blank cell means the presence came from the override
          // list rather than a scan, so the file says so instead of showing an
          // empty scan time that reads as missing data.
          ...(student ? [] : ["Presence"]),
        ];

  const body = rows.map((row) => {
    const person = student
      ? [row.person.name, row.person.code, row.person.level ?? "", row.person.department ?? ""]
      : [row.person.name, row.person.code, row.person.department ?? ""];

    if (request.detail === "absent") {
      return [...person, row.expectedCount, row.attendedCount];
    }
    return [
      EVENT_CATEGORY_LABEL[row.event.event_category],
      row.event.title,
      row.event.event_date,
      row.status,
      ...person,
      row.attendance?.scans ?? "",
      stamp(row.attendance?.first ?? null),
      stamp(row.attendance?.last ?? null),
      ...(student
        ? []
        : [row.attendance && row.attendance.scans === 0 ? "by override" : "scanned"]),
    ];
  });

  return toCsv(headers, body);
}

/** A filename that says who, when, what and how, so it cannot be mis-filed. */
export function downloadFilename(request: DownloadRequest, result: DownloadResult): string {
  const parts = [
    request.group === "student" ? "students" : "staff",
    request.category === "all" ? "all-events" : request.category.replace("_", "-"),
    DETAIL_SLUG[request.detail],
    result.shortLabel,
  ];
  return `${parts.join("_")}.csv`;
}

/** The one-line description shown in the UI and reused in the confirmation. */
export function describeDownload(request: DownloadRequest, result: DownloadResult): string {
  const who = request.group === "student" ? "Students" : "Staff";
  const what =
    request.detail === "present"
      ? "only those who turned up"
      : request.detail === "absent"
        ? "only those who missed every event in the period"
        : "both those who turned up and those who did not";
  const kind =
    request.category === "all" ? "all event types" : EVENT_CATEGORY_LABEL[request.category];
  const rowWord = result.rows.length === 1 ? "row" : "rows";
  return `${who} · ${kind} · ${result.periodLabel} · ${DETAIL_WORD[request.detail]} — ${result.eventsCount} event(s), ${result.rows.length} ${rowWord}.`;
}
