// What an administrator must confirm before a report -------------------------
//
// Two kinds of question, both answered once and remembered:
//
//   1. Scans the app could not match with certainty (needs_review = 1). The
//      administrator picks the person -- or says the entry is nobody on the
//      list -- and the answer is applied to every pending scan of that machine
//      entry and remembered in scan_aliases, so later uploads of the same entry
//      match the same way without asking.
//   2. A present person who looks like an absent person (src/server/lookalikes.ts).
//      "Same person" merges the two records; "Different people" is remembered
//      in distinct_people.
//
// Until both lists are empty, the report and export endpoints refuse with 409
// and the page opens the review window instead (see reportBlockers).

import { randomUUID } from "node:crypto";
import type { RowDataPacket } from "./db";
import { dialect, query, transaction, utcStamp } from "@/server/db";
import { aliasKey, eventResult, GROUPS, loadLookup, wholeNameMatch } from "@/server/events";
import { rematchScans } from "@/server/rematch";
import { HttpError } from "@/server/http";
import { loadIdentity, type PersonKind } from "@/server/identity";
import {
  loadPeople,
  lookAlikePairs,
  pairKey,
  type LookAlikePair,
  type PersonBrief,
} from "@/server/lookalikes";
import { massResult } from "@/server/mass";
import { mergeInto } from "@/server/masters";
import type { GroupKind, MassUploadParticipant } from "@/lib/types";

export type ReviewContext =
  | { type: "mass"; weekId: string; participantType: MassUploadParticipant }
  | { type: "event"; kind: GroupKind; eventId: string };

export type PendingScan = {
  /** The machine entry, as printed. */
  scanNumber: string | null;
  scannedName: string | null;
  /** How many scans of this entry are waiting. */
  count: number;
  firstScanAt: string | null;
  /** The people it could be, most likely first. */
  candidates: PersonBrief[];
};

export type ReviewItems = {
  kind: PersonKind;
  scans: PendingScan[];
  lookAlikes: LookAlikePair[];
};

function kindOf(context: ReviewContext): PersonKind {
  return context.type === "mass" ? context.participantType : context.kind;
}

function scansWhere(context: ReviewContext): { table: string; where: string; params: string[] } {
  if (context.type === "mass") {
    return {
      table: "mass_scans",
      where: "mass_week_id = ? AND participant_type = ?",
      params: [context.weekId, context.participantType],
    };
  }
  return {
    table: context.kind === "staff" ? "staff_scans" : "student_scans",
    where: "event_id = ?",
    params: [context.eventId],
  };
}

function briefOf(row: {
  id: string;
  code: string | null;
  last_name: string | null;
  first_name: string | null;
  middle_name: string | null;
  department: string | null;
  machine: string | null;
}): PersonBrief {
  return {
    id: row.id,
    code: row.code,
    name: [row.last_name, row.first_name, row.middle_name].filter(Boolean).join(" "),
    department: row.department,
    machine: row.machine,
  };
}

/** Everything still waiting for an administrator in one Mass week or event. */
export async function reviewItems(context: ReviewContext): Promise<ReviewItems> {
  const kind = kindOf(context);
  // Scans stored before a rule improved, or before a person was added to the
  // list, may be certain now: settle those first so nobody is asked needlessly.
  await rematchScans(kind, { onlyUnresolved: true });
  const { table, where, params } = scansWhere(context);
  const pending = await query<
    RowDataPacket & {
      scan_number: string | null;
      scanned_name: string | null;
      count: number;
      first_scan_at: string | null;
      candidates: string | null;
    }
  >(
    `SELECT scan_number, scanned_name, COUNT(*) AS count, MIN(scanned_at) AS first_scan_at,
            MAX(review_candidates) AS candidates
       FROM ${table}
      WHERE ${where} AND needs_review = 1
      GROUP BY scan_number, scanned_name
      ORDER BY scanned_name`,
    params,
  );

  const identity = await loadIdentity(kind);
  const ids = new Set<string>();
  const parsed = pending.map((row) => {
    let list: string[] = [];
    try {
      list = (JSON.parse(row.candidates ?? "[]") as string[]).map((id) => identity.canonical(id));
    } catch {
      list = [];
    }
    for (const id of list) ids.add(id);
    return { row, list: [...new Set(list)] };
  });
  const people = await loadPeople(kind, [...ids]);
  const scans: PendingScan[] = parsed.map(({ row, list }) => ({
    scanNumber: row.scan_number,
    scannedName: row.scanned_name,
    count: Number(row.count),
    firstScanAt: row.first_scan_at ? String(row.first_scan_at) : null,
    candidates: list.flatMap((id) => {
      const person = people.get(id);
      return person ? [briefOf(person)] : [];
    }),
  }));

  let lookAlikes: LookAlikePair[] = [];
  if (context.type === "mass") {
    const result = await massResult(context.weekId, context.participantType, null);
    lookAlikes = await lookAlikePairs(
      kind,
      result.presentList.map((row) => row.person_id),
      result.absentList.map((row) => row.person_id),
      result.outOfScopeList.map((row) => row.person_id),
    );
  } else {
    const result = await eventResult(context.kind, context.eventId);
    lookAlikes = await lookAlikePairs(
      kind,
      result.presentList.map((row) => row.person_id),
      result.absentList.map((row) => row.person_id),
      result.outOfScopeList.map((row) => row.person_id),
    );
  }
  // What the machine printed for each scanned person in a pair: the evidence
  // the administrator answers from.
  if (lookAlikes.length > 0) {
    const ids = [...new Set(lookAlikes.map((pair) => pair.present.id))];
    const printed = new Map<string, string[]>();
    const { table: scanTable, where: scanWhere, params: scanParams } = scansWhere(context);
    const idColumn =
      context.type === "mass" ? "person_id" : context.kind === "staff" ? "staff_id" : "student_id";
    const rows = await query<
      RowDataPacket & {
        person: string | null;
        scan_number: string | null;
        scanned_name: string | null;
      }
    >(
      `SELECT DISTINCT ${idColumn} AS person, scan_number, scanned_name
         FROM ${scanTable} WHERE ${scanWhere} AND ${idColumn} IS NOT NULL`,
      scanParams,
    );
    const wanted = new Set(ids);
    for (const row of rows) {
      const person = identity.canonical(row.person ?? "");
      if (!wanted.has(person)) continue;
      const text = [row.scan_number, row.scanned_name].filter(Boolean).join(" ");
      const list = printed.get(person) ?? [];
      if (text && !list.includes(text) && list.length < 3) list.push(text);
      printed.set(person, list);
    }
    lookAlikes = lookAlikes.map((pair) => ({
      ...pair,
      printed: printed.get(pair.present.id) ?? [],
    }));
  }
  return { kind, scans, lookAlikes };
}

/**
 * Refuse a report while anything is waiting, with a message that says what to
 * do. Called by every endpoint that produces a report file.
 */
export async function assertNoBlockers(context: ReviewContext): Promise<void> {
  const items = await reviewItems(context);
  const scans = items.scans.reduce((sum, scan) => sum + scan.count, 0);
  if (scans === 0 && items.lookAlikes.length === 0) return;
  const parts: string[] = [];
  if (scans > 0) parts.push(`${scans} scan(s) need you to confirm who they are`);
  if (items.lookAlikes.length > 0) {
    parts.push(`${items.lookAlikes.length} scanned/absent pair(s) may be the same person`);
  }
  throw new HttpError(
    409,
    `The report is not ready: ${parts.join(" and ")}. Open the page and answer the review first.`,
  );
}

/**
 * The administrator's answer for one machine entry. Applied to every pending
 * scan of that entry, in Weekly Mass and in events, and remembered.
 * `personId` null means "this entry is not anyone on the list".
 */
export async function resolveScan(input: {
  kind: PersonKind;
  scanNumber: string | null;
  scannedName: string | null;
  personId: string | null;
  actorId: string;
}): Promise<{ updated: number }> {
  const identity = await loadIdentity(input.kind);
  const personId = input.personId ? identity.canonical(input.personId) : null;
  if (input.personId) {
    const exists = await query<RowDataPacket & { id: string }>(
      `SELECT id FROM ${input.kind === "staff" ? "staff" : "students"} WHERE id = ?`,
      [personId],
    );
    if (exists.length === 0) throw new HttpError(404, "That person is not on the list any more.");
  }
  const number = input.scanNumber ?? "";
  const name = input.scannedName ?? "";
  const method = personId ? "number" : "none";
  const eventsTable = input.kind === "staff" ? "staff_scans" : "student_scans";
  const idColumn = input.kind === "staff" ? "staff_id" : "student_id";
  const key = aliasKey(input.scanNumber, input.scannedName);
  const [aliasNumber, aliasName] = [
    key.slice(0, key.indexOf("|")),
    key.slice(key.indexOf("|") + 1),
  ];

  return transaction(async (connection) => {
    const [mass] = await connection.query<Array<RowDataPacket & { total: number }>>(
      `SELECT COUNT(*) AS total FROM mass_scans
        WHERE participant_type = ? AND needs_review = 1
          AND COALESCE(scan_number, '') = ? AND COALESCE(scanned_name, '') = ?`,
      [input.kind, number, name],
    );
    const [events] = await connection.query<Array<RowDataPacket & { total: number }>>(
      `SELECT COUNT(*) AS total FROM ${eventsTable}
        WHERE needs_review = 1 AND COALESCE(scan_number, '') = ? AND COALESCE(scanned_name, '') = ?`,
      [number, name],
    );
    await connection.execute(
      `UPDATE mass_scans
          SET person_id = ?, match_method = ?, needs_review = 0, review_candidates = NULL
        WHERE participant_type = ? AND needs_review = 1
          AND COALESCE(scan_number, '') = ? AND COALESCE(scanned_name, '') = ?`,
      [personId, method, input.kind, number, name],
    );
    // in_scope stays 0: results count the person present when the event
    // expects them (events.ts peopleOutcome), out of scope otherwise.
    await connection.execute(
      `UPDATE ${eventsTable}
          SET ${idColumn} = ?, match_method = ?, needs_review = 0, review_candidates = NULL
        WHERE needs_review = 1 AND COALESCE(scan_number, '') = ? AND COALESCE(scanned_name, '') = ?`,
      [personId, method, number, name],
    );
    await connection.execute(
      `INSERT INTO scan_aliases (kind, scan_number, name_key, person_id, created_by, created_at)
       VALUES (?, ?, ?, ?, ?, ?)
       ${dialect.upsert(["kind", "scan_number", "name_key"], ["person_id", "created_by", "created_at"])}`,
      [input.kind, aliasNumber, aliasName, personId, input.actorId, utcStamp()],
    );
    await connection.execute(
      "INSERT INTO audit_logs (id, actor_id, action, entity, details) VALUES (?, ?, ?, ?, ?)",
      [
        randomUUID(),
        input.actorId,
        "scan.review_resolved",
        input.kind,
        JSON.stringify({ scanNumber: input.scanNumber, scannedName: input.scannedName, personId }),
      ],
    );
    return { updated: Number(mass[0]?.total ?? 0) + Number(events[0]?.total ?? 0) };
  });
}

/**
 * The administrator's answer for a present/absent look-alike pair. "Same
 * person" merges the two records into the one the attendance machine knows (or
 * the one on the current list, or the present one); "different people" is
 * remembered so the pair is not asked about again.
 */
export async function resolvePair(input: {
  kind: PersonKind;
  presentId: string;
  absentId: string;
  same: boolean;
  actorId: string;
}): Promise<{ kept: string | null }> {
  if (input.presentId === input.absentId) throw new HttpError(400, "Pick two different people.");
  if (!input.same) {
    const [a, b] = pairKey(input.presentId, input.absentId).split("|");
    await query(
      `INSERT INTO distinct_people (kind, person_a, person_b, created_by, created_at)
       VALUES (?, ?, ?, ?, ?)
       ${dialect.upsert(["kind", "person_a", "person_b"], ["created_by", "created_at"])}`,
      [input.kind, a!, b!, input.actorId, utcStamp()],
    );
    return { kept: null };
  }

  const table = input.kind === "staff" ? "staff" : "students";
  const rows = await query<
    RowDataPacket & { id: string; machine: string | null; current: number | null }
  >(
    input.kind === "staff"
      ? `SELECT id, COALESCE(NULLIF(TRIM(staff_id_on_machine), ''), NULLIF(TRIM(machine_id), '')) AS machine,
                on_current_list AS current
           FROM staff WHERE id IN (?, ?)`
      : `SELECT id, NULL AS machine, 1 AS current FROM students WHERE id IN (?, ?)`,
    [input.presentId, input.absentId],
  );
  if (rows.length !== 2) throw new HttpError(404, `One of those records is no longer in ${table}.`);
  const score = (row: (typeof rows)[number]) =>
    (row.machine ? 4 : 0) +
    (Number(row.current ?? 1) === 1 ? 2 : 0) +
    (row.id === input.presentId ? 1 : 0);
  const [keep, drop] = [...rows].sort((a, b) => score(b) - score(a));
  await transaction(async (connection) => {
    await mergeInto(connection, input.kind, keep!.id, [drop!.id], utcStamp());
    await connection.execute(
      "INSERT INTO audit_logs (id, actor_id, action, entity, details) VALUES (?, ?, ?, ?, ?)",
      [
        randomUUID(),
        input.actorId,
        `${input.kind}.merged_by_review`,
        table,
        JSON.stringify({ kept: keep!.id, removed: drop!.id }),
      ],
    );
  });
  return { kept: keep!.id };
}

/** People to pick from when none of the suggestions is right. */
export async function searchPeople(kind: PersonKind, text: string): Promise<PersonBrief[]> {
  const term = text.trim();
  if (term.length < 2) return [];
  const words = term.toUpperCase().split(/\s+/).filter(Boolean).slice(0, 4);
  const clauses = words.map(() =>
    kind === "staff"
      ? `(UPPER(COALESCE(last_name,'') || ' ' || COALESCE(first_name,'') || ' ' || COALESCE(middle_name,'') || ' ' || COALESCE(staff_no,'') || ' ' || COALESCE(machine_id,'') || ' ' || COALESCE(staff_id_on_machine,'')) LIKE ?)`
      : `(UPPER(COALESCE(last_name,'') || ' ' || COALESCE(first_name,'') || ' ' || COALESCE(middle_name,'') || ' ' || COALESCE(matric_no,'')) LIKE ?)`,
  );
  const params = words.map((word) => `%${word}%`);
  const rows = await query<
    RowDataPacket & {
      id: string;
      code: string | null;
      last_name: string | null;
      first_name: string | null;
      middle_name: string | null;
      department: string | null;
      machine: string | null;
    }
  >(
    kind === "staff"
      ? `SELECT id, staff_no AS code, last_name, first_name, middle_name, department,
                COALESCE(NULLIF(TRIM(staff_id_on_machine), ''), NULLIF(TRIM(machine_id), '')) AS machine
           FROM staff WHERE ${clauses.join(" AND ")} ORDER BY last_name, first_name LIMIT 15`
      : `SELECT id, matric_no AS code, last_name, first_name, middle_name, department, NULL AS machine
           FROM students WHERE ${clauses.join(" AND ")} ORDER BY last_name, first_name LIMIT 15`,
    params,
  );
  const identity = await loadIdentity(kind);
  const seen = new Set<string>();
  const out: PersonBrief[] = [];
  for (const row of rows) {
    const id = identity.canonical(row.id);
    if (seen.has(id)) continue;
    seen.add(id);
    out.push({ ...briefOf(row), id });
  }
  return out;
}

// Re-matching and saved answers ---------------------------------------------

export type SavedAnswer = {
  scanNumber: string;
  nameKey: string;
  /** Null: the administrator said this entry is nobody on the list. */
  person: PersonBrief | null;
  /**
   * For a "not on the list" answer: the person the printed name now matches
   * beyond doubt, if any -- a sign the answer was a mistake.
   */
  nameMatches: PersonBrief | null;
  createdAt: string | null;
};

/** The answers given in the review window, newest first. */
export async function savedAnswers(kind: PersonKind): Promise<SavedAnswer[]> {
  const rows = await query<
    RowDataPacket & {
      scan_number: string;
      name_key: string;
      person_id: string | null;
      created_at: string | null;
    }
  >(
    `SELECT scan_number, name_key, person_id, created_at FROM scan_aliases
      WHERE kind = ? ORDER BY created_at DESC`,
    [kind],
  );
  const identity = await loadIdentity(kind);
  const lookup = await loadLookup(GROUPS[kind]);
  const named = new Map<string, string | null>();
  for (const row of rows) {
    if (row.person_id) continue;
    const words = row.name_key ? row.name_key.split(" ") : [];
    named.set(`${row.scan_number}|${row.name_key}`, wholeNameMatch(lookup, words));
  }
  const ids = [
    ...rows.flatMap((row) => (row.person_id ? [identity.canonical(row.person_id)] : [])),
    ...[...named.values()].flatMap((id) => (id ? [id] : [])),
  ];
  const people = await loadPeople(kind, ids);
  return rows.map((row) => {
    const person = row.person_id ? people.get(identity.canonical(row.person_id)) : undefined;
    const suggested = named.get(`${row.scan_number}|${row.name_key}`);
    const match = suggested ? people.get(suggested) : undefined;
    return {
      scanNumber: row.scan_number,
      nameKey: row.name_key,
      person: person ? briefOf(person) : null,
      nameMatches: match ? briefOf(match) : null,
      createdAt: row.created_at ? String(row.created_at) : null,
    };
  });
}

/**
 * Take back an answer: forget it and match that machine entry's scans again,
 * so they go back to the review window (or match by themselves when the rules
 * are now certain).
 */
export async function forgetAnswer(input: {
  kind: PersonKind;
  scanNumber: string;
  nameKey: string;
  actorId: string;
}): Promise<{ updated: number }> {
  await query("DELETE FROM scan_aliases WHERE kind = ? AND scan_number = ? AND name_key = ?", [
    input.kind,
    input.scanNumber,
    input.nameKey,
  ]);
  const key = `${input.scanNumber}|${input.nameKey}`;
  const updated = await rematchScans(input.kind, {
    onlyUnresolved: false,
    pick: (scan) => aliasKey(scan.scan_number, scan.scanned_name) === key,
  });
  await query(
    "INSERT INTO audit_logs (id, actor_id, action, entity, details) VALUES (?, ?, ?, ?, ?)",
    [
      randomUUID(),
      input.actorId,
      "scan.review_forgotten",
      input.kind,
      JSON.stringify({ scanNumber: input.scanNumber, nameKey: input.nameKey }),
    ],
  );
  return { updated };
}
