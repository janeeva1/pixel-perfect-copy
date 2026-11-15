// Matching stored scans again ------------------------------------------------
//
// A scan is matched when it is uploaded. When the rules improve, a person is
// added to the master list, or an administrator takes back an answer, scans that
// are already stored can be matched again here. Only scans with nobody yet are
// touched by default, so a confirmed match never moves on its own.

import type { RowDataPacket } from "./db";
import { query, transaction } from "@/server/db";
import { GROUPS, loadLookup, matchRow } from "@/server/events";
import { loadIdentity, type PersonKind } from "@/server/identity";

export type StoredScan = RowDataPacket & {
  id: string;
  scan_number: string | null;
  scanned_name: string | null;
  machine_id: string | null;
  person_id: string | null;
  needs_review: number | null;
};

/**
 * Match stored scans again with the current rules, master list and answers.
 * `onlyUnresolved` limits it to scans with nobody yet (waiting for review, or
 * unmatched); `pick` narrows it further. Returns how many scans changed.
 */
export async function rematchScans(
  kind: PersonKind,
  options: { onlyUnresolved: boolean; pick?: (scan: StoredScan) => boolean },
): Promise<number> {
  const lookup = await loadLookup(GROUPS[kind]);
  const identity = await loadIdentity(kind);
  const eventsTable = kind === "staff" ? "staff_scans" : "student_scans";
  const idColumn = kind === "staff" ? "staff_id" : "student_id";
  const unresolved = (column: string) => (options.onlyUnresolved ? `AND ${column} IS NULL` : "");
  const [massRows, eventRows] = await Promise.all([
    query<StoredScan>(
      `SELECT id, scan_number, scanned_name, machine_id, person_id, needs_review
         FROM mass_scans WHERE participant_type = ? ${unresolved("person_id")}`,
      [kind],
    ),
    query<StoredScan>(
      `SELECT id, scan_number, scanned_name, machine_id, ${idColumn} AS person_id, needs_review
         FROM ${eventsTable} WHERE 1 = 1 ${unresolved(idColumn)}`,
    ),
  ]);

  type Change = {
    id: string;
    personId: string | null;
    method: string;
    review: number;
    candidates: string | null;
  };
  const changesFor = (rows: StoredScan[]): Change[] => {
    const changes: Change[] = [];
    for (const row of rows) {
      if (options.pick && !options.pick(row)) continue;
      const match = matchRow(lookup, row.scan_number, row.scanned_name, row.machine_id);
      const personId = match.id === null ? null : identity.canonical(match.id);
      const review = match.review ? 1 : 0;
      if (personId === row.person_id && review === Number(row.needs_review ?? 0)) continue;
      changes.push({
        id: row.id,
        personId,
        method: match.method,
        review,
        candidates: match.review
          ? JSON.stringify(match.candidates.map((id) => identity.canonical(id)))
          : null,
      });
    }
    return changes;
  };
  const massChanges = changesFor(massRows);
  const eventChanges = changesFor(eventRows);
  if (massChanges.length + eventChanges.length === 0) return 0;

  await transaction(async (connection) => {
    for (const change of massChanges) {
      await connection.execute(
        `UPDATE mass_scans SET person_id = ?, match_method = ?, needs_review = ?, review_candidates = ?
          WHERE id = ?`,
        [change.personId, change.method, change.review, change.candidates, change.id],
      );
    }
    for (const change of eventChanges) {
      await connection.execute(
        `UPDATE ${eventsTable} SET ${idColumn} = ?, match_method = ?, needs_review = ?, review_candidates = ?
          WHERE id = ?`,
        [change.personId, change.method, change.review, change.candidates, change.id],
      );
    }
  });
  return massChanges.length + eventChanges.length;
}

const settled = new Set<PersonKind>();

/**
 * Re-match unresolved scans once per running app and kind, so results stored by
 * an older version are read with today's rules. Cheap: only scans with nobody
 * are looked at. Imports call markStale() so new people are picked up.
 */
export async function ensureRematched(kind: PersonKind): Promise<void> {
  if (settled.has(kind)) return;
  settled.add(kind);
  try {
    await rematchScans(kind, { onlyUnresolved: true });
  } catch (error) {
    settled.delete(kind);
    throw error;
  }
}

/** The master list changed: re-match unresolved scans on the next read. */
export function markStale(kind: PersonKind): void {
  settled.delete(kind);
}
