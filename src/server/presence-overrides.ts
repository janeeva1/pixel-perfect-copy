// Staff presence overrides.
//
// A few staff are expected at every staff event whether or not the machine saw
// them. This module decides which people those are for a given event, and owns
// the admin list that adds and removes them.
//
// The design constraint is the one in db/migrations/001's header: attendance is
// never stored on a person. So this does not write scan rows, and it does not
// add a column to staff. It widens the question "who is present at this event"
// from "who has an in-scope scan" to "who has an in-scope scan, plus whoever
// this table grants". Deleting a row therefore rewrites history, which is the
// correct behaviour: the grant was a claim, and withdrawing the claim withdraws
// the presence it produced.
//
// Two deliberate limits, both of which keep the record honest:
//
//   * The grant only applies to an event that has at least one staff machine
//     upload. Uploading staff machine data is what triggers it. An event with
//     no upload still reports everyone absent, because nothing has been
//     collected and nothing is being asserted about it.
//   * A granted person has no scan, so their scan count is 0 and their first and
//     last scan are empty. They are in the present list and in the present
//     count, and the "present by override" reason travels with them. No time is
//     invented for them, because a time on this row means a machine wrote it.

import { query, queryOne, utcStamp, type SqlParam } from "@/server/db";
import { HttpError } from "@/server/http";
import { staffDepartmentSql, staffScanNumberSql, staffScopeWhere } from "@/server/masters";
import type { GroupKind, StaffEvent } from "@/lib/types";
import type { RowDataPacket } from "./db";
import { randomUUID } from "node:crypto";
import { loadIdentity } from "@/server/identity";

/** The staff numbers seeded by migration 002, kept here for the admin UI. */
export const BUILTIN_OVERRIDE_NUMBERS = ["1500", "140", "979"] as const;

export type PresenceOverride = {
  scanNumber: string;
  reason: string;
  isBuiltin: boolean;
  /** Null when the staff number matches nobody in the master list. */
  staffId: string | null;
  staffNo: string | null;
  name: string | null;
  department: string | null;
  createdAt: string;
  addedBy: string | null;
};

type OverrideRow = RowDataPacket & {
  scan_number: string;
  reason: string;
  is_builtin: number;
  created_at: string;
  added_by: string | null;
  staff_id: string | null;
  staff_no: string | null;
  name: string | null;
  department: string | null;
};

/**
 * Every override, with the person it resolves to where the master list has one.
 *
 * The join is on the derived scan number and is deliberately a LEFT JOIN: a
 * number that matches nobody is still shown, because a number that silently
 * disappears is a number someone will eventually re-add by hand.
 */
export async function listOverrides(): Promise<PresenceOverride[]> {
  const rows = await query<OverrideRow>(
    `SELECT o.scan_number, o.reason, o.is_builtin, o.created_at,
            u.full_name AS added_by,
            f.id AS staff_id, f.staff_no,
            TRIM(f.last_name || ' ' || f.first_name ||
                 ' ' || COALESCE(f.middle_name, '')) AS name,
            ${staffDepartmentSql("f")} AS department
     FROM staff_presence_overrides o
     LEFT JOIN staff f ON ${staffScanNumberSql("f")} = o.scan_number
     LEFT JOIN users u ON u.id = o.created_by
     ORDER BY o.is_builtin DESC, o.scan_number`,
  );
  return rows.map(mapOverride);
}

function mapOverride(row: OverrideRow): PresenceOverride {
  return {
    scanNumber: row.scan_number,
    reason: row.reason,
    isBuiltin: Number(row.is_builtin) === 1,
    staffId: row.staff_id,
    staffNo: row.staff_no,
    name: row.name,
    department: row.department,
    createdAt: row.created_at,
    addedBy: row.added_by,
  };
}

/**
 * Does this event have a staff machine upload to be reacting to?
 *
 * Checked separately rather than folded into the main query so the answer is one
 * boolean, and so the "no upload, no grant" rule is written down in one place
 * instead of being re-derived wherever presence is computed.
 */
export async function hasUpload(eventId: string): Promise<boolean> {
  const row = await queryOne<RowDataPacket & { n: number }>(
    `SELECT COUNT(*) AS n FROM staff_event_uploads WHERE event_id = ?`,
    [eventId],
  );
  return Number(row?.n ?? 0) > 0;
}

/**
 * The staff who are credited present at one staff event, in scope for it.
 *
 * `departments` is the event's own scope: empty means every override qualifies,
 * otherwise only those whose department is named. A grant is scoped exactly the
 * way an expectation is, so an override cannot put someone in the room for a
 * department event they are not part of.
 */
export async function overriddenStaffIds(
  eventId: string,
  departments: string[],
): Promise<string[]> {
  if (!(await hasUpload(eventId))) return [];
  if (departments.length === 0) {
    // An all-staff event: everyone in the override table, whoever they are.
    const all = await query<RowDataPacket & { id: string }>(
      `SELECT f.id FROM staff f
       WHERE ${staffScanNumberSql("f")} IN (SELECT scan_number FROM staff_presence_overrides)
       ORDER BY f.id`,
    );
    return all.map((row) => row.id);
  }
  // A department event: only the overrides whose own department is in scope.
  // staffScopeWhere pushes the departments itself; seeding them here as well
  // passed every department twice and failed with "Too many parameter values"
  // on every department-limited staff event.
  const params: SqlParam[] = [];
  const scoped = await query<RowDataPacket & { id: string }>(
    `SELECT f.id FROM staff f
     WHERE ${staffScanNumberSql("f")} IN (SELECT scan_number FROM staff_presence_overrides)
       AND ${staffScopeWhere({ departments }, params, "f")}
     ORDER BY f.id`,
    params,
  );
  return scoped.map((row) => row.id);
}

/**
 * The same grant, but for a set of events at once, as a map from event id to
 * staff ids. The reports and the CSV both work over a period rather than one
 * event, and asking per event is a query per event for no reason.
 */
export async function overriddenStaffIdsByEvent(
  eventDepartmentsById: Map<string, string[]>,
): Promise<Map<string, string[]>> {
  const result = new Map<string, string[]>();
  if (eventDepartmentsById.size === 0) return result;

  const ids = [...eventDepartmentsById.keys()];
  const withUpload = await query<RowDataPacket & { event_id: string }>(
    `SELECT DISTINCT event_id FROM staff_event_uploads
     WHERE event_id IN (${ids.map(() => "?").join(", ")})`,
    ids,
  );
  const uploaded = new Set(withUpload.map((row) => row.event_id));
  if (uploaded.size === 0) return result;

  // Every override that resolves to a person, with their department. Filtering
  // to the in-scope ones is done here in JS because the departments are per
  // event, and the comparison is case-insensitive to match how staffScopeWhere
  // compares it. The four staff with no department cannot be placed by a
  // department event, and are not: see the header note in 001.
  const people = await query<RowDataPacket & { id: string; department: string | null }>(
    `SELECT f.id, ${staffDepartmentSql("f")} AS department
     FROM staff f
     WHERE ${staffScanNumberSql("f")} IN (SELECT scan_number FROM staff_presence_overrides)`,
  );
  if (people.length === 0) return result;

  for (const [eventId, departments] of eventDepartmentsById) {
    if (!uploaded.has(eventId)) continue;
    const wanted = new Set(departments.map((d) => d.trim().toLowerCase()));
    const ids2 =
      wanted.size === 0
        ? people.map((row) => row.id)
        : people
            .filter(
              (row) => row.department !== null && wanted.has(row.department.trim().toLowerCase()),
            )
            .map((row) => row.id);
    if (ids2.length > 0) result.set(eventId, ids2);
  }
  return result;
}

/**
 * The grant for the events a resolved download scope covers, keyed by event id.
 *
 * A student download never grants anyone: the table is staff-only and a student
 * event has no department list to match, so this returns an empty map for it and
 * the caller can treat the two groups the same way.
 */
export async function overridesForScope(
  group: GroupKind,
  events: { event: { id: string }; departments: string[] | null }[],
): Promise<Map<string, string[]>> {
  if (group !== "staff") return new Map();
  const byEvent = new Map<string, string[]>();
  for (const entry of events) {
    byEvent.set(entry.event.id, entry.departments ?? []);
  }
  return overriddenStaffIdsByEvent(byEvent);
}

/** Typed for a StaffEvent, which is what the scope resolves to on the staff side. */
export function departmentsOf(event: StaffEvent): string[] {
  return event.departments ?? [];
}

// Admin operations ---------------------------------------------------------

/** Normalise whatever was typed into the machine's own digits. */
function normaliseScanNumber(value: string): string {
  const digits = value.replace(/[^0-9]/g, "");
  if (digits.length === 0) {
    throw new HttpError(400, "Enter the staff number as digits, e.g. 1500.");
  }
  return digits;
}

export async function addOverride(input: {
  staffNo: string;
  reason?: string;
  actorId: string;
}): Promise<PresenceOverride> {
  const scanNumber = normaliseScanNumber(input.staffNo);
  const reason = (input.reason ?? "").trim();

  // Refuse a number that matches nobody, rather than storing a grant that can
  // never apply. A typo here would look like it worked and quietly do nothing.
  // (The alias matters: staffScanNumberSql("f") names f.staff_no, so the table
  // must be "staff f". Without it every add failed with "no such column".)
  const people = await query<RowDataPacket & { id: string; staff_no: string; name: string }>(
    `SELECT f.id, f.staff_no, TRIM(f.last_name || ' ' || f.first_name) AS name
       FROM staff f WHERE ${staffScanNumberSql("f")} = ?`,
    [scanNumber],
  );
  if (people.length === 0) {
    throw new HttpError(
      404,
      `No staff member has the number ${scanNumber}. Check the digits, since a number that matches nobody would never apply.`,
    );
  }
  // A machine number two different people share would make both of them
  // "always present". Refuse, and say who shares it, rather than over-grant.
  const identity = await loadIdentity("staff");
  const distinct = new Map(people.map((row) => [identity.canonical(row.id), row]));
  if (distinct.size > 1) {
    throw new HttpError(
      409,
      `The number ${scanNumber} belongs to more than one person (${[...distinct.values()]
        .map((row) => `${row.staff_no} ${row.name}`)
        .join(", ")}). Give one of them their own machine number first.`,
    );
  }

  const existing = await queryOne<RowDataPacket & { scan_number: string; is_builtin: number }>(
    `SELECT scan_number, is_builtin FROM staff_presence_overrides WHERE scan_number = ?`,
    [scanNumber],
  );
  if (existing) {
    throw new HttpError(409, `Staff number ${scanNumber} is already on the list.`);
  }

  await query(
    `INSERT INTO staff_presence_overrides (scan_number, reason, is_builtin, created_by, updated_at)
     VALUES (?, ?, 0, ?, ?)`,
    [scanNumber, reason, input.actorId, utcStamp()],
  );
  return (await listOverrides()).find((row) => row.scanNumber === scanNumber)!;
}

export async function removeOverride(scanNumberInput: string, actorId: string): Promise<void> {
  const scanNumber = normaliseScanNumber(scanNumberInput);
  const existing = await queryOne<RowDataPacket & { is_builtin: number }>(
    `SELECT is_builtin FROM staff_presence_overrides WHERE scan_number = ?`,
    [scanNumber],
  );
  if (!existing) {
    throw new HttpError(404, `Staff number ${scanNumber} is not on the list.`);
  }
  if (Number(existing.is_builtin) === 1) {
    throw new HttpError(403, `${scanNumber} is one of the built-in numbers and cannot be removed.`);
  }
  await query(`UPDATE staff_presence_overrides SET updated_at = ? WHERE scan_number = ?`, [
    utcStamp(),
    scanNumber,
  ]);
  await query(`DELETE FROM staff_presence_overrides WHERE scan_number = ?`, [scanNumber]);
  await query(
    "INSERT INTO audit_logs (id, actor_id, action, entity, entity_id) VALUES (?, ?, ?, ?, ?)",
    [
      randomUUID(),
      actorId,
      "staff_presence_override.removed",
      "staff_presence_overrides",
      scanNumber,
    ],
  );
}

/**
 * Every staff member on the always-present list (the ids that stand for each
 * person). Used by Weekly Mass and the debt page: such a person is present in
 * any staff Mass week that has an upload, never absent, never owing.
 */
export async function exemptStaffIds(): Promise<Set<string>> {
  const rows = await query<RowDataPacket & { id: string }>(
    `SELECT f.id FROM staff f
      WHERE ${staffScanNumberSql("f")} IN (SELECT scan_number FROM staff_presence_overrides)`,
  );
  const identity = await loadIdentity("staff");
  return new Set(rows.map((row) => identity.canonical(row.id)));
}
