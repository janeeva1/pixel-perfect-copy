// Present-and-absent look-alikes ----------------------------------------------
//
// The identity rule (src/server/identity.ts) joins two master records only when
// it is certain they are one person. What it is not certain about must not be
// left to look like two people either: a person shown present under one record
// and absent under another is exactly the mistake this app must not make.
//
// So after every result is worked out, each present person is compared with
// each absent person, and any pair that looks like it could be one person is
// put to an administrator, who answers once:
//
//   * "Same person"     -> the two records are merged (src/server/review.ts);
//   * "Different people" -> the pair is remembered in distinct_people and never
//                          asked about again.
//
// Reports are not produced while such a pair is open.
//
// What counts as "could be one person":
//   staff:    the same number (staff-number digits or machine number), whatever
//             the names -- on screen that is "the same staff number" on both
//             lists, so it is always confirmed; or,
//             with different numbers, at least two complete name words in
//             common ("Otusanya Esther" / "ESTHER OTUSANYA IYABO"), or one in
//             common and another spelled nearly the same ("OKECHUKWU OKONKWO" /
//             "IKECHUKWU OKONKWO PETER"). Two people
//             who merely share a first name and an initial are not asked about.
//   students: never -- matric numbers are unique, so student records are
//             not compared at all.

import type { RowDataPacket } from "./db";
import { query } from "@/server/db";
import {
  compareNames,
  compactStaffNumber,
  nameWords,
  staffNumberDigits,
  type PersonKind,
} from "@/server/identity";

export type PersonBrief = {
  id: string;
  code: string | null;
  name: string;
  department: string | null;
  machine: string | null;
};

export type LookAlikePair = {
  kind: PersonKind;
  /** The person who scanned: shown present, or out of scope. */
  present: PersonBrief;
  /** How the scanned person is shown. */
  shownAs: "present" | "out_of_scope";
  /** The person shown absent. */
  absent: PersonBrief;
  reason: string;
  /** What the machine printed for the scanned person (number and name). */
  printed?: string[];
};

type MasterRow = RowDataPacket & {
  id: string;
  code: string | null;
  last_name: string | null;
  first_name: string | null;
  middle_name: string | null;
  department: string | null;
  machine: string | null;
};

export async function loadPeople(kind: PersonKind, ids: string[]): Promise<Map<string, MasterRow>> {
  const out = new Map<string, MasterRow>();
  for (let index = 0; index < ids.length; index += 500) {
    const batch = ids.slice(index, index + 500);
    if (batch.length === 0) continue;
    const marks = batch.map(() => "?").join(", ");
    const rows = await query<MasterRow>(
      kind === "staff"
        ? `SELECT id, staff_no AS code, last_name, first_name, middle_name, department,
                  COALESCE(NULLIF(TRIM(staff_id_on_machine), ''), NULLIF(TRIM(machine_id), '')) AS machine
             FROM staff WHERE id IN (${marks})`
        : `SELECT id, matric_no AS code, last_name, first_name, middle_name, department,
                  NULL AS machine
             FROM students WHERE id IN (${marks})`,
      batch,
    );
    for (const row of rows) out.set(row.id, row);
  }
  return out;
}

/** Pairs an administrator already said are different people. */
export async function distinctPairs(kind: PersonKind): Promise<Set<string>> {
  const rows = await query<RowDataPacket & { person_a: string; person_b: string }>(
    "SELECT person_a, person_b FROM distinct_people WHERE kind = ?",
    [kind],
  );
  return new Set(rows.map((row) => pairKey(row.person_a, row.person_b)));
}

export function pairKey(a: string, b: string): string {
  return a < b ? `${a}|${b}` : `${b}|${a}`;
}

function brief(row: MasterRow): PersonBrief {
  return {
    id: row.id,
    code: row.code,
    name: [row.last_name, row.first_name, row.middle_name].filter(Boolean).join(" "),
    department: row.department,
    machine: row.machine,
  };
}

function numbersOf(kind: PersonKind, row: MasterRow): string[] {
  if (kind !== "staff") return [];
  const out = new Set<string>();
  const digits = staffNumberDigits(row.code);
  if (digits) out.add(digits);
  const machine = (row.machine ?? "").replace(/^0+(?=\d)/, "");
  if (machine) out.add(machine);
  return [...out];
}

/**
 * Every (present, absent) pair that could be one person and has not been
 * answered yet. `presentIds` and `absentIds` are the ids results use (the id
 * that stands for each person).
 */
export async function lookAlikePairs(
  kind: PersonKind,
  presentIds: Iterable<string>,
  absentIds: Iterable<string>,
  outOfScopeIds: Iterable<string> = [],
): Promise<LookAlikePair[]> {
  // Someone who scanned under an old record (out of scope) while their current
  // record is absent is the same mistake as present-and-absent, so both kinds
  // of scanned person are compared with the absent.
  const shownAs = new Map<string, "present" | "out_of_scope">();
  for (const id of outOfScopeIds) shownAs.set(id, "out_of_scope");
  for (const id of presentIds) shownAs.set(id, "present");
  // Students' matric numbers are unique, so two student records are never
  // "maybe one person": nothing is put to an administrator for students.
  if (kind === "student") return [];
  const present = [...shownAs.keys()];
  const absent = [...new Set(absentIds)];
  if (present.length === 0 || absent.length === 0) return [];

  const [people, answered] = await Promise.all([
    loadPeople(kind, [...present, ...absent]),
    distinctPairs(kind),
  ]);

  // Index the absent by every name word and every number, so each present
  // person is compared only with absent people who share something.
  const byWord = new Map<string, string[]>();
  const byNumber = new Map<string, string[]>();
  const wordsOf = new Map<string, string[]>();
  for (const id of absent) {
    const row = people.get(id);
    if (!row) continue;
    const words = nameWords(row.last_name, row.first_name, row.middle_name);
    wordsOf.set(id, words);
    for (const word of new Set(words)) byWord.set(word, [...(byWord.get(word) ?? []), id]);
    for (const number of numbersOf(kind, row)) {
      byNumber.set(number, [...(byNumber.get(number) ?? []), id]);
    }
  }

  const pairs: LookAlikePair[] = [];
  for (const id of present) {
    const row = people.get(id);
    if (!row) continue;
    const words = nameWords(row.last_name, row.first_name, row.middle_name);
    const numbers = numbersOf(kind, row);
    const sameNumber = new Set(numbers.flatMap((number) => byNumber.get(number) ?? []));
    const nearby = new Set<string>(sameNumber);
    for (const word of words) for (const other of byWord.get(word) ?? []) nearby.add(other);
    // Spelling variants share no exact word; compare everyone of the same
    // number too, which is already in `nearby`.

    for (const otherId of nearby) {
      if (otherId === id || answered.has(pairKey(id, otherId))) continue;
      const other = people.get(otherId);
      const otherWords = wordsOf.get(otherId);
      if (!other || !otherWords) continue;
      const agreement = compareNames(words, otherWords, true);
      let reason: string | null = null;
      if (kind === "staff") {
        if (sameNumber.has(otherId) && agreement.total >= 1) {
          reason = "Same staff/machine number and a similar name";
        } else if (sameNumber.has(otherId)) {
          // "SW39" absent while "SA39" is present reads as one staff member on
          // both lists. The names differ, so it is probably two people sharing
          // a number -- but only an administrator can say, once.
          reason = "Same staff/machine number, different name";
        } else if (agreement.exact >= 2) {
          const sameExact =
            compactStaffNumber(row.code) !== "" &&
            compactStaffNumber(row.code) === compactStaffNumber(other.code);
          reason = sameExact ? "Same staff number" : "Very similar name";
        } else {
          // One word the same and another spelled nearly the same
          // ("OKECHUKWU OKONKWO" / "IKECHUKWU OKONKWO PETER"). Initials do not
          // count here, or every "A. JOSEPH" would look like every Joseph.
          const strict = compareNames(words, otherWords, false);
          if (strict.exact >= 1 && strict.total >= 2) reason = "Similar name";
        }
      } else {
        const shorter = Math.min(words.length, otherWords.length);
        if (agreement.exact >= 2 && agreement.exact >= shorter) {
          reason = "Same name";
        }
      }
      if (reason) {
        pairs.push({
          kind,
          present: brief(row),
          shownAs: shownAs.get(id) ?? "present",
          absent: brief(other),
          reason,
        });
      }
    }
  }
  return pairs;
}
