// Who is the same person ---------------------------------------------------
//
// The master lists can hold one human being under more than one row. The real
// case is a re-import of the registrar's staff file that writes the staff
// number differently ("SA 534" before, "SAC534" now; "AT 600" and "A600";
// "954" and "JT954"). The attendance machine prints the same number for both
// rows, so a scan can only ever land on one of them, and the other row stays
// "absent". The result was the same person listed as present AND absent.
//
// This module is the single answer to "are these two rows the same person?",
// used by scan matching, the Weekly Mass expected list and results, the staff
// import, and the duplicate-merge tool, so they can never disagree.
//
// Staff rows are the same person ONLY when the staff number is the same number
// written differently: spaces and capitals aside ("AT1430" = "AT 1430"). Shared
// digits with different letters ("SA39" / "SW39"), a shared machine number, or
// similar names never join two rows: those are often different people (twins,
// relatives, two staff the machine both knows as 39), and joining deletes a
// record. Who scanned is decided by the printed name when the number is shared
// or wrong (src/server/events.ts), and old records left off the current staff
// list are not expected anywhere, so keeping rows apart never makes a person
// absent.
// Students are the same person when their matric numbers are equal once case,
// spaces, punctuation and leading zeros are ignored. Two students with the same
// name and different matric numbers are different people.
//
// Every group of rows that are one person has one "canonical" id that stands
// for all of them. It is chosen deterministically: the row the attendance
// machine knows (it has a machine id), then the most recently updated row (the
// registrar's latest file), then the lowest id.

import type { RowDataPacket } from "./db";
import { query } from "@/server/db";
import { normalizeName } from "@/lib/attendance";

export type PersonKind = "student" | "staff";

export type StaffIdentityRow = {
  id: string;
  staff_no: string | null;
  last_name: string | null;
  first_name: string | null;
  middle_name?: string | null;
  staff_id_on_machine?: string | null;
  machine_id?: string | null;
  updated_at?: string | null;
  /** 0 when a complete-list import left the person out (src/server/masters.ts). */
  on_current_list?: number | null;
};

export type StudentIdentityRow = {
  id: string;
  matric_no: string | null;
  updated_at?: string | null;
};

/** Surname + first name, sorted and normalised; "" when the row has no name. */
export function staffNameKey(row: Pick<StaffIdentityRow, "last_name" | "first_name">): string {
  return normalizeName(`${row.last_name ?? ""} ${row.first_name ?? ""}`);
}

/** The digits of a staff number without leading zeros: "SA 063" -> "63". */
export function staffNumberDigits(staffNo: string | null | undefined): string {
  return (staffNo ?? "").replace(/\D/g, "").replace(/^0+/, "");
}

/** A staff number with case and spaces ignored: "sa 534" -> "SA534". */
export function compactStaffNumber(staffNo: string | null | undefined): string {
  return (staffNo ?? "").toUpperCase().replace(/[^A-Z0-9]/g, "");
}

/**
 * A matric number reduced to what identifies the student: its parts in order,
 * with case, spaces, punctuation and leading zeros ignored, so
 * "VUG/CSC/25/1001", "vug/csc/25/1001 ", "VUG-CSC-25-01001" and
 * "VUG / CSC / 25 / 1001" are one student. The parts themselves must all agree:
 * a different department, year or serial is a different student.
 */
export function matricKey(matricNo: string | null | undefined): string {
  return (matricNo ?? "")
    .toUpperCase()
    .split(/[^A-Z0-9]+/)
    .filter(Boolean)
    .map((part) => (/^\d+$/.test(part) ? part.replace(/^0+(?=\d)/, "") : part))
    .join("/");
}

function machineNumbers(row: StaffIdentityRow): string[] {
  const out = new Set<string>();
  for (const value of [row.staff_id_on_machine, row.machine_id]) {
    const trimmed = (value ?? "").trim().replace(/^0+(?=\d)/, "");
    if (trimmed) out.add(trimmed);
  }
  return [...out];
}

// Names --------------------------------------------------------------------

/** Every word of a person's full name, upper case, punctuation removed. */
export function nameWords(...parts: Array<string | null | undefined>): string[] {
  return normalizeName(parts.filter(Boolean).join(" ")).split(" ").filter(Boolean);
}

/** Jaro-Winkler similarity of two words, 0..1. */
export function wordSimilarity(a: string, b: string): number {
  if (a === b) return 1;
  if (!a || !b) return 0;
  const range = Math.max(0, Math.floor(Math.max(a.length, b.length) / 2) - 1);
  const aHit = new Array<boolean>(a.length).fill(false);
  const bHit = new Array<boolean>(b.length).fill(false);
  let matches = 0;
  for (let i = 0; i < a.length; i++) {
    for (let j = Math.max(0, i - range); j < Math.min(b.length, i + range + 1); j++) {
      if (!bHit[j] && a[i] === b[j]) {
        aHit[i] = true;
        bHit[j] = true;
        matches++;
        break;
      }
    }
  }
  if (matches === 0) return 0;
  let k = 0;
  let transpositions = 0;
  for (let i = 0; i < a.length; i++) {
    if (!aHit[i]) continue;
    while (!bHit[k]) k++;
    if (a[i] !== b[k]) transpositions++;
    k++;
  }
  const jaro =
    (matches / a.length + matches / b.length + (matches - transpositions / 2) / matches) / 3;
  let prefix = 0;
  while (prefix < Math.min(4, a.length, b.length) && a[prefix] === b[prefix]) prefix++;
  return jaro + 0.1 * prefix * (1 - jaro);
}

export type NameAgreement = {
  /** Words matched exactly. */
  exact: number;
  /** Words matched as a shortened form, an initial, or a spelling variant. */
  close: number;
  /** exact + close */
  total: number;
};

/**
 * How many words two names have in common, each word used once, any order.
 * A word matches exactly, as the start of the other (an initial counts only
 * when `initials` is set), or as a spelling variant (similarity >= 0.88 on
 * words of four letters or more).
 */
export function compareNames(a: string[], b: string[], initials = false): NameAgreement {
  const remaining = [...b];
  let exact = 0;
  let close = 0;
  const rest: string[] = [];
  for (const word of a) {
    const index = remaining.indexOf(word);
    if (index === -1) rest.push(word);
    else {
      remaining.splice(index, 1);
      exact++;
    }
  }
  for (const word of rest.sort((x, y) => y.length - x.length)) {
    let best = -1;
    let bestScore = 0;
    remaining.forEach((other, index) => {
      const short = word.length <= other.length ? word : other;
      const long = word.length <= other.length ? other : word;
      let score = 0;
      if (long.startsWith(short) && (short.length >= 3 || (initials && short.length === 1))) {
        score = 0.95;
      } else if (word.length >= 4 && other.length >= 4) {
        const similarity = wordSimilarity(word, other);
        if (similarity >= 0.88) score = similarity;
      }
      if (score > bestScore) {
        bestScore = score;
        best = index;
      }
    });
    if (best !== -1) {
      remaining.splice(best, 1);
      close++;
    }
  }
  return { exact, close, total: exact + close };
}

/** Two staff rows' names are the same person's when 2+ words agree (or both are one equal word). */
export function staffNamesAgree(a: StaffIdentityRow, b: StaffIdentityRow): boolean {
  const wa = nameWords(a.last_name, a.first_name, a.middle_name);
  const wb = nameWords(b.last_name, b.first_name, b.middle_name);
  if (wa.length === 0 || wb.length === 0) return false;
  const agreement = compareNames(wa, wb, true);
  if (agreement.total >= 2 && agreement.exact >= 1) return true;
  return wa.length === 1 && wb.length === 1 && wa[0] === wb[0];
}

/**
 * The numbers that put two staff rows in the same bucket to be compared:
 * the staff-number digits and every machine number. Rows that share no bucket
 * are never compared, so a name alone never joins two people.
 */
export function staffIdentityKeys(row: StaffIdentityRow): string[] {
  const keys: string[] = [];
  const digits = staffNumberDigits(row.staff_no);
  if (digits) keys.push(`no:${digits}`);
  for (const machine of machineNumbers(row)) keys.push(`no:${machine}`);
  return [...new Set(keys)];
}

/**
 * Whether two staff rows are one person: ONLY when the staff number is the same
 * number written differently -- spaces and capitals aside ("AT1430" = "AT 1430"
 * = "at1430").
 *
 * Shared digits are not enough ("SA39" and "SW39" are two people the machine
 * both knows as 39), and neither are similar names ("AKWUTE Sylvester" and
 * "AKWUTE Sylvia" are twins). Joining two records deletes one of them, so it is
 * done only when there is no doubt. Old records that are no longer on the
 * current staff list are not expected anywhere, so leaving them separate never
 * makes anyone absent; and who scanned is decided by the printed name
 * (src/server/events.ts), not by joining records.
 */
export function sameStaffPerson(a: StaffIdentityRow, b: StaffIdentityRow): boolean {
  const ca = compactStaffNumber(a.staff_no);
  return ca !== "" && ca === compactStaffNumber(b.staff_no);
}

export function studentIdentityKeys(row: StudentIdentityRow): string[] {
  const matric = matricKey(row.matric_no);
  return matric ? [`matric:${matric}`] : [];
}

type Ranked = { id: string; hasMachine: boolean; updatedAt: string; current?: boolean };

/**
 * Better canonical first: on the registrar's current list, then known to the
 * machine, then newest, then lowest id.
 */
function rank(a: Ranked, b: Ranked): number {
  const ac = a.current !== false;
  const bc = b.current !== false;
  if (ac !== bc) return ac ? -1 : 1;
  if (a.hasMachine !== b.hasMachine) return a.hasMachine ? -1 : 1;
  if (a.updatedAt !== b.updatedAt) return a.updatedAt > b.updatedAt ? -1 : 1;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/**
 * Group rows that share a key (transitively) and map every id to its group's
 * canonical id. Rows that share nothing map to themselves.
 */
export function clusterByKeys(
  rows: Array<{ id: string; keys: string[]; ranked: Ranked }>,
): Map<string, string> {
  const parent = new Map<string, string>();
  const find = (id: string): string => {
    let root = id;
    while (parent.get(root) !== root) root = parent.get(root)!;
    let node = id;
    while (parent.get(node) !== root) {
      const next = parent.get(node)!;
      parent.set(node, root);
      node = next;
    }
    return root;
  };
  for (const row of rows) parent.set(row.id, row.id);

  const owner = new Map<string, string>();
  for (const row of rows) {
    for (const key of row.keys) {
      const other = owner.get(key);
      if (other === undefined) owner.set(key, row.id);
      else parent.set(find(row.id), find(other));
    }
  }

  const best = new Map<string, Ranked>();
  for (const row of rows) {
    const root = find(row.id);
    const current = best.get(root);
    if (!current || rank(row.ranked, current) < 0) best.set(root, row.ranked);
  }
  const canonical = new Map<string, string>();
  for (const row of rows) canonical.set(row.id, best.get(find(row.id))!.id);
  return canonical;
}

export function staffCanonicalMap(rows: StaffIdentityRow[]): Map<string, string> {
  // Compare only rows that share a number bucket, then join the pairs that are
  // one person. Joining is transitive: A=B and B=C makes one person of three.
  const buckets = new Map<string, StaffIdentityRow[]>();
  for (const row of rows) {
    const compact = compactStaffNumber(row.staff_no);
    if (compact) buckets.set(`exact:${compact}`, [...(buckets.get(`exact:${compact}`) ?? []), row]);
  }
  const links: string[] = [];
  const seen = new Set<string>();
  for (const bucket of buckets.values()) {
    if (bucket.length < 2) continue;
    for (let i = 0; i < bucket.length; i++) {
      for (let j = i + 1; j < bucket.length; j++) {
        const a = bucket[i]!;
        const b = bucket[j]!;
        const pair = a.id < b.id ? `${a.id}|${b.id}` : `${b.id}|${a.id}`;
        if (seen.has(pair)) continue;
        seen.add(pair);
        if (sameStaffPerson(a, b)) links.push(pair);
      }
    }
  }
  return clusterByKeys(
    rows.map((row) => ({
      id: row.id,
      // One synthetic key per joined pair makes clusterByKeys union them.
      keys: links.filter((pair) => pair.split("|").includes(row.id)),
      ranked: {
        id: row.id,
        hasMachine: machineNumbers(row).length > 0,
        updatedAt: String(row.updated_at ?? ""),
        current: row.on_current_list == null ? true : Number(row.on_current_list) === 1,
      },
    })),
  );
}

export function studentCanonicalMap(rows: StudentIdentityRow[]): Map<string, string> {
  return clusterByKeys(
    rows.map((row) => ({
      id: row.id,
      keys: studentIdentityKeys(row),
      ranked: { id: row.id, hasMachine: false, updatedAt: String(row.updated_at ?? "") },
    })),
  );
}

/** Every id in a master list mapped to the id that stands for that person. */
export type Identity = {
  /** The id that stands for this person. An id not in the list maps to itself. */
  canonical(id: string): string;
  /** Number of master rows that are a duplicate of another row. */
  duplicateRows: number;
};

export function identityFrom(map: Map<string, string>): Identity {
  let duplicateRows = 0;
  for (const [id, canonical] of map) if (id !== canonical) duplicateRows += 1;
  return { canonical: (id) => map.get(id) ?? id, duplicateRows };
}

/** Read one master list and work out who is the same person. */
export async function loadIdentity(kind: PersonKind): Promise<Identity> {
  if (kind === "staff") {
    const rows = await query<RowDataPacket & StaffIdentityRow>(
      `SELECT id, staff_no, last_name, first_name, middle_name, staff_id_on_machine, machine_id,
              updated_at, on_current_list
         FROM staff`,
    );
    return identityFrom(staffCanonicalMap(rows));
  }
  const rows = await query<RowDataPacket & StudentIdentityRow>(
    "SELECT id, matric_no, updated_at FROM students",
  );
  return identityFrom(studentCanonicalMap(rows));
}
