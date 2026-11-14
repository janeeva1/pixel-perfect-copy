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
// Staff rows are the same person when, and only when, they share the person's
// name (surname + first name, any order, case and punctuation ignored) AND
// either
//   * the digits of the staff number (leading zeros ignored), or
//   * the number the attendance machine prints for them (machine id).
// A shared name alone is not enough: two members of staff can have the same
// name. A shared number alone is not enough: the machine prints the same number
// for different people (39 and 65 in the registrar's roster).
//
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
  staff_id_on_machine?: string | null;
  machine_id?: string | null;
  updated_at?: string | null;
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

/**
 * The keys that tie a staff row to its twins. Two rows sharing any key are the
 * same person. A row with no name has no keys and is always a person of its own.
 */
export function staffIdentityKeys(row: StaffIdentityRow): string[] {
  const name = staffNameKey(row);
  if (!name) return [];
  const keys: string[] = [];
  const digits = staffNumberDigits(row.staff_no);
  if (digits) keys.push(`no:${digits}|${name}`);
  for (const machine of machineNumbers(row)) keys.push(`machine:${machine}|${name}`);
  return keys;
}

export function studentIdentityKeys(row: StudentIdentityRow): string[] {
  const matric = matricKey(row.matric_no);
  return matric ? [`matric:${matric}`] : [];
}

type Ranked = { id: string; hasMachine: boolean; updatedAt: string };

/** Better canonical first: known to the machine, then newest, then lowest id. */
function rank(a: Ranked, b: Ranked): number {
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
  return clusterByKeys(
    rows.map((row) => ({
      id: row.id,
      keys: staffIdentityKeys(row),
      ranked: {
        id: row.id,
        hasMachine: machineNumbers(row).length > 0,
        updatedAt: String(row.updated_at ?? ""),
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
      `SELECT id, staff_no, last_name, first_name, staff_id_on_machine, machine_id, updated_at
         FROM staff`,
    );
    return identityFrom(staffCanonicalMap(rows));
  }
  const rows = await query<RowDataPacket & StudentIdentityRow>(
    "SELECT id, matric_no, updated_at FROM students",
  );
  return identityFrom(studentCanonicalMap(rows));
}
