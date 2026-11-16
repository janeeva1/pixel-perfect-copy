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
import { lookAlikePairs } from "@/server/lookalikes";
import { onlyNewScans, storedScanKeys } from "@/server/scan-dedup";
import { HttpError } from "@/server/http";
import { UnmatchedList, type UnmatchedEntry } from "@/server/unmatched";
import {
  compareNames,
  loadIdentity,
  nameWords,
  staffNumberDigits,
  wordSimilarity,
  type Identity,
} from "@/server/identity";
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

type Candidate = {
  /** The id that stands for the person (src/server/identity.ts). */
  id: string;
  /** Sorted name forms (full, and surname + first name) of every record of theirs. */
  names: string[];
  /** The words of each of their records' full names. */
  words: string[][];
  /** On the current staff list (always true for students). */
  current: boolean;
};

type Lookup = {
  kind: GroupKind;
  /**
   * The number the attendance machine knows the person by -> the people it
   * could mean: the machine id for staff (Staff_ID_on_machine), the tail of the
   * matric number for students. Checked FIRST.
   */
  byMachine: Map<string, Candidate[]>;
  /** Staff only: the digits of the staff number ("SAT417", "SA 417" -> 417). Checked second. */
  byStaffNo: Map<string, Candidate[]>;
  /** normalized name -> person id. A null value means two people share it. */
  byName: Map<string, string | null>;
  /** Everyone, for the name-resemblance step. */
  everyone: Candidate[];
  /** Every whole name word -> the people with it, so a name is checked fast. */
  byWord: Map<string, Candidate[]>;
  /** Answers an administrator gave for a machine entry, by aliasKey(). */
  aliases: Map<string, string | null>;
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
 * The key an administrator's answer is remembered under: the number and the
 * name exactly as the machine prints them for that person (leading zeros, case,
 * spacing and word order ignored).
 */
export function aliasKey(scanNumber: string | null, name: string | null): string {
  const number = (scanNumber ?? "").trim().replace(/^0+(?=\d)/, "");
  return `${number}|${normalizeName(name)}`;
}

/**
 * Load the whole master list for one group and index it for matching. Rows that
 * are the same person become ONE candidate under the id that stands for them,
 * carrying every spelling of their name, so a number shared by a person's two
 * records is one candidate, not a coin toss between two.
 */
async function loadLookup(config: GroupConfig): Promise<Lookup> {
  const staff = config.kind === "staff";
  const rows = await query<
    RowDataPacket & {
      id: string;
      machine_number: string | null;
      machine_number2: string | null;
      staff_no: string | null;
      last_name: string | null;
      first_name: string | null;
      middle_name: string | null;
      current: number | null;
    }
  >(
    staff
      ? `SELECT f.id, f.staff_id_on_machine AS machine_number, f.machine_id AS machine_number2,
                f.staff_no, f.last_name, f.first_name, f.middle_name,
                COALESCE(f.on_current_list, 1) AS current
         FROM staff f`
      : `SELECT s.id, ${config.scanNumber} AS machine_number, NULL AS machine_number2,
                NULL AS staff_no, s.last_name, s.first_name, s.middle_name, 1 AS current
         FROM students s`,
  );
  const [identity, aliasRows] = await Promise.all([
    loadIdentity(config.kind),
    query<RowDataPacket & { scan_number: string; name_key: string; person_id: string | null }>(
      "SELECT scan_number, name_key, person_id FROM scan_aliases WHERE kind = ?",
      [config.kind],
    ),
  ]);

  const candidates = new Map<string, Candidate>();
  const candidateFor = (id: string): Candidate => {
    const canonical = identity.canonical(id);
    let candidate = candidates.get(canonical);
    if (!candidate) {
      candidate = { id: canonical, names: [], words: [], current: false };
      candidates.set(canonical, candidate);
    }
    return candidate;
  };
  const addTo = (map: Map<string, Candidate[]>, key: string, candidate: Candidate) => {
    const list = map.get(key) ?? [];
    if (!list.includes(candidate)) list.push(candidate);
    map.set(key, list);
  };

  const byMachine = new Map<string, Candidate[]>();
  const byStaffNo = new Map<string, Candidate[]>();
  const byName = new Map<string, string | null>();
  const byWord = new Map<string, Candidate[]>();
  for (const row of rows) {
    const names = nameForms(row.last_name ?? "", row.first_name ?? "", row.middle_name ?? "");
    const candidate = candidateFor(row.id);
    if (Number(row.current ?? 1) === 1) candidate.current = true;
    for (const name of names) if (!candidate.names.includes(name)) candidate.names.push(name);
    const words = nameWords(row.last_name, row.first_name, row.middle_name);
    if (words.length > 0) candidate.words.push(words);
    for (const word of new Set(words)) addTo(byWord, word, candidate);
    for (const number of [row.machine_number, row.machine_number2]) {
      for (const key of numberKeys(number ?? "")) addTo(byMachine, key, candidate);
    }
    if (staff) {
      const digits = staffNumberDigits(row.staff_no);
      if (digits) addTo(byStaffNo, digits, candidate);
    }
    for (const name of names) claim(byName, name, candidate.id);
  }
  const aliases = new Map<string, string | null>();
  for (const row of aliasRows) {
    aliases.set(
      `${row.scan_number}|${row.name_key}`,
      row.person_id ? identity.canonical(row.person_id) : null,
    );
  }
  return {
    kind: config.kind,
    byMachine,
    byStaffNo,
    byName,
    everyone: [...candidates.values()],
    byWord,
    aliases,
  };
}

type Match = {
  id: string | null;
  method: "number" | "name" | "none";
  originalMethod: "machine_id" | "number" | "name" | "fuzzy_name" | "none";
  /** True when the app is not certain: an administrator must pick the person. */
  review: boolean;
  /** For a review: the people it could be, most likely first. */
  candidates: string[];
};

const NO_MATCH: Match = {
  id: null,
  method: "none",
  originalMethod: "none",
  review: false,
  candidates: [],
};

/** How well a scanned name fits a candidate: their best-agreeing record. */
function fit(scannedWords: string[], candidate: Candidate): { exact: number; total: number } {
  let best = { exact: 0, total: 0 };
  for (const words of candidate.words) {
    const agreement = compareNames(scannedWords, words, true);
    if (
      agreement.total > best.total ||
      (agreement.total === best.total && agreement.exact > best.exact)
    ) {
      best = { exact: agreement.exact, total: agreement.total };
    }
  }
  return best;
}

/**
 * How completely a printed name is this person's name, using their best record:
 *
 *   3  every printed word is one of their name words, spelled the same;
 *   2  every printed word is one of their words, or the start of one (the
 *      machine cuts long names: "LAWRE" for LAWRENCE, "ADEBOL" for ADEBOLA, an
 *      initial "N" for NNAMDI);
 *   1  as 2, but a word may also be a spelling variant ("SUCESS" / "SUCCESS");
 *   0  not their name.
 *
 * Each of their words is used once, and at least one printed word must be a
 * whole word of theirs (an initial alone is nobody). Printed words may be
 * fewer than theirs: the machine leaves out middle names.
 */
function nameLevel(printed: string[], candidate: Candidate): number {
  if (printed.length === 0) return 0;
  let best = 0;
  for (const words of candidate.words) {
    const remaining = [...words];
    let exact = 0;
    let level = 3;
    const rest: string[] = [];
    for (const word of printed) {
      const index = remaining.indexOf(word);
      if (index >= 0) {
        remaining.splice(index, 1);
        exact += 1;
      } else rest.push(word);
    }
    if (exact === 0) continue;
    let ok = true;
    // Longest first, so a short piece cannot take the word a longer one needs.
    for (const word of rest.sort((a, b) => b.length - a.length)) {
      let index = remaining.findIndex(
        (theirs) => theirs.startsWith(word) && (word.length >= 3 || word.length === 1),
      );
      if (index >= 0) {
        level = Math.min(level, 2);
      } else {
        index = remaining.findIndex(
          (theirs) =>
            word.length >= 4 && theirs.length >= 4 && wordSimilarity(word, theirs) >= 0.88,
        );
        if (index < 0) {
          ok = false;
          break;
        }
        level = Math.min(level, 1);
      }
      remaining.splice(index, 1);
    }
    if (ok) best = Math.max(best, level);
    if (best === 3) break;
  }
  return best;
}

/** People who have at least one of the printed words: the only ones whose name it can be. */
function namePool(lookup: Lookup, printed: string[]): Candidate[] {
  const pool = new Set<Candidate>();
  for (const word of printed) for (const person of lookup.byWord.get(word) ?? []) pool.add(person);
  return [...pool];
}

type Ranked = { person: Candidate; level: number; owner: boolean };

/**
 * The single best person, or null with the tied ones when there is no single
 * best. `order` says what counts first.
 */
function pickBest(
  ranked: Ranked[],
  order: Array<(entry: Ranked) => number>,
): { winner: Candidate | null; tied: Candidate[] } {
  if (ranked.length === 0) return { winner: null, tied: [] };
  const key = (entry: Ranked) => order.map((score) => score(entry));
  const sorted = [...ranked].sort((a, b) => {
    const ka = key(a);
    const kb = key(b);
    for (let index = 0; index < ka.length; index++) {
      if (ka[index] !== kb[index]) return kb[index]! - ka[index]!;
    }
    return 0;
  });
  const top = key(sorted[0]!).join("|");
  const tied = sorted.filter((entry) => key(entry).join("|") === top).map((entry) => entry.person);
  return tied.length === 1 ? { winner: tied[0]!, tied } : { winner: null, tied };
}

/**
 * The one person whose name contains every printed word (two words or more,
 * spelled exactly); when several do, the one on the current list if only one
 * is. Null when nobody, or no single person, fits.
 */
function wholeNameMatch(lookup: Lookup, scannedWords: string[]): string | null {
  if (scannedWords.length < 2) return null;
  const full = namePool(lookup, scannedWords).filter(
    (person) => nameLevel(scannedWords, person) === 3,
  );
  if (full.length === 1) return full[0]!.id;
  const current = full.filter((person) => person.current);
  return current.length === 1 ? current[0]!.id : null;
}

/** People whose name resembles the printed name, best first (for the review window). */
function resembling(lookup: Lookup, scannedWords: string[], limit = 5): string[] {
  if (scannedWords.length === 0) return [];
  return namePool(lookup, scannedWords)
    .map((person) => ({ person, ...fit(scannedWords, person) }))
    .filter((entry) => entry.total >= Math.min(2, scannedWords.length) && entry.exact >= 1)
    .sort((a, b) => b.total - a.total || b.exact - a.exact)
    .slice(0, limit)
    .map((entry) => entry.person.id);
}

/**
 * Students: every matric number, and so every number the machine prints for a
 * student (its last part), is unique -- checked on the real list: 7,683
 * students, 7,683 different numbers. The number alone decides, the name is not
 * second-guessed, and nothing is ever put to an administrator. Without a known
 * number, a name that exactly one student has decides; otherwise the scan is
 * unmatched.
 */
function matchStudent(
  lookup: Lookup,
  scanNumber: string | null,
  machineId: string | null,
  scannedName: string,
): Match {
  for (const value of [machineId, scanNumber]) {
    if (!value) continue;
    const people = new Set<Candidate>();
    for (const key of numberKeys(value.trim()))
      for (const person of lookup.byMachine.get(key) ?? []) people.add(person);
    if (people.size === 1) {
      const [person] = [...people];
      return {
        id: person!.id,
        method: "number",
        originalMethod: "machine_id",
        review: false,
        candidates: [],
      };
    }
  }
  const byName = scannedName ? lookup.byName.get(scannedName) : undefined;
  if (byName) {
    return { id: byName, method: "name", originalMethod: "name", review: false, candidates: [] };
  }
  // A mistyped number ("149111" for 14911) with the student's name: the name
  // decides when exactly one student has every printed word, or when exactly
  // one student's name it is, cut short by the machine ("ONI MICHELLE P").
  const words = scannedName ? scannedName.split(" ") : [];
  const whole = wholeNameMatch(lookup, words);
  if (whole) {
    return { id: whole, method: "name", originalMethod: "name", review: false, candidates: [] };
  }
  if (words.length >= 2) {
    let found: string | null = null;
    for (const person of lookup.everyone) {
      if (!person.names.some((full) => isShortenedName(scannedName, full, 2))) continue;
      if (found !== null && found !== person.id) return NO_MATCH;
      found = person.id;
    }
    if (found) {
      return {
        id: found,
        method: "name",
        originalMethod: "fuzzy_name",
        review: false,
        candidates: [],
      };
    }
  }
  return NO_MATCH;
}

/**
 * Resolve one scan row to a person, in this order:
 *
 *   0. an answer an administrator already gave for this machine entry ("not
 *      anyone on the list" never beats a printed full name that is exactly one
 *      person's name, so nobody is both absent and unmatched);
 *   1. the machine ID (the scan's ID column, or its machine-id column), when
 *      the printed name agrees with that person;
 *   2. the staff number's digits ("SAT417", "SA 417" and "417" are one number),
 *      when the printed name agrees;
 *   3. the full printed name, when it is exactly one person's name (2+ words);
 *      this also overrides 1-2 when the number's owner shares only part of it;
 *   4. the exact name, when only one person has it.
 *
 * A number that points at people the scanned name does not fit, or a name that
 * only resembles someone, is never guessed: the scan is returned for review
 * with the people it could be, and an administrator decides.
 */
function matchRow(
  lookup: Lookup,
  scanNumber: string | null,
  name: string | null,
  machineId: string | null,
): Match {
  const scannedName = normalizeName(name);
  const scannedWords = scannedName ? scannedName.split(" ") : [];
  if (lookup.kind === "student") return matchStudent(lookup, scanNumber, machineId, scannedName);

  // 0. A remembered answer that names a person.
  const remembered = lookup.aliases.get(aliasKey(scanNumber, name));
  if (remembered) {
    return {
      id: remembered,
      method: "number",
      originalMethod: "number",
      review: false,
      candidates: [],
    };
  }

  const certain = (person: Candidate, by: "number" | "name"): Match => ({
    id: person.id,
    method: by,
    originalMethod: by === "number" ? "machine_id" : "name",
    review: false,
    candidates: [],
  });

  // Whose name is printed: everyone whose name it is (full, cut short, an
  // initial, a spelling variant), from the people who share a word with it.
  const nameRanked: Ranked[] = namePool(lookup, scannedWords)
    .map((person) => ({ person, level: nameLevel(scannedWords, person), owner: false }))
    .filter((entry) => entry.level > 0);

  // 0b. "Not anyone on the list" was answered for this entry. It holds -- except
  //     when the printed name is clearly one person's (full or cut short): then
  //     that person scanned, and leaving the scan unmatched would show them
  //     absent AND unmatched.
  if (remembered === null) {
    if (scannedWords.length < 2) return NO_MATCH;
    const { winner } = pickBest(
      nameRanked.filter((entry) => entry.level >= 2),
      [(entry) => entry.level, (entry) => (entry.person.current ? 1 : 0)],
    );
    return winner ? certain(winner, "name") : NO_MATCH;
  }

  // 1. Who the number is: the machine id first, then the staff number's digits.
  //    Two different people can share a number ("SA39" and "SW39"; a member of
  //    staff registered on the machine under a colleague's number), so the
  //    number only ever narrows the field -- the printed name says which of
  //    them scanned.
  const owners = new Map<Candidate, number>();
  const steps: Array<[Map<string, Candidate[]>, string | null, number]> = [
    [lookup.byMachine, machineId, 2],
    [lookup.byMachine, scanNumber, 2],
    [lookup.byStaffNo, scanNumber ? staffNumberDigits(scanNumber) : null, 1],
  ];
  for (const [map, value, weight] of steps) {
    if (!value) continue;
    for (const key of numberKeys(value.trim())) {
      for (const person of map.get(key) ?? []) {
        owners.set(person, Math.max(owners.get(person) ?? 0, weight));
      }
    }
  }

  if (scannedWords.length === 0) {
    // No name printed: the number alone, when it is one person's.
    const ownerList = [...owners.keys()];
    if (ownerList.length === 1) return certain(ownerList[0]!, "number");
    const current = ownerList.filter((person) => person.current);
    if (current.length === 1) return certain(current[0]!, "number");
    return ownerList.length === 0
      ? NO_MATCH
      : {
          id: null,
          method: "none",
          originalMethod: "none",
          review: true,
          candidates: ownerList.map((person) => person.id),
        };
  }

  // 2. An owner of the number whose name this is: the current staff list first
  //    (an old record of the same person is not expected anywhere), then the
  //    closest name, then the machine id over the staff number.
  const ownerRanked: Ranked[] = [...owners.entries()]
    .map(([person]) => ({ person, level: nameLevel(scannedWords, person), owner: true }))
    .filter((entry) => entry.level > 0);
  const byOwner = pickBest(ownerRanked, [
    (entry) => (entry.person.current ? 1 : 0),
    (entry) => entry.level,
    (entry) => owners.get(entry.person) ?? 0,
  ]);
  if (byOwner.winner) return certain(byOwner.winner, "number");

  // 3. Nobody with that number has that name: the machine has the person under
  //    another number. The name alone decides when it is clearly one person's
  //    (full or cut short, not just a similar spelling), the current staff list
  //    first.
  const byPrintedName = pickBest(
    nameRanked.filter((entry) => entry.level >= 2),
    [(entry) => entry.level, (entry) => (entry.person.current ? 1 : 0)],
  );
  //    One printed word is too little to name someone without the number.
  if (byOwner.tied.length === 0 && byPrintedName.winner && scannedWords.length >= 2) {
    return certain(byPrintedName.winner, "name");
  }

  // 3b. Nobody has the printed name exactly, but the number's owner shares part
  //     of it (a typo, "MWOKORIE" for NWOKORIE; a maiden or married name,
  //     "ODU JANE" for Anyanwu Jane): the machine registered them under that
  //     number, so the scan is theirs. The current staff list first.
  if (byOwner.tied.length === 0 && byPrintedName.tied.length === 0) {
    const partly = pickBest(
      [...owners.entries()]
        .map(([person, weight]) => ({ person, weight, ...fit(scannedWords, person) }))
        .filter((entry) => entry.total >= 1)
        .map((entry) => ({
          person: entry.person,
          level: entry.total * 10 + entry.exact,
          owner: true,
        })),
      [
        (entry) => (entry.person.current ? 1 : 0),
        (entry) => entry.level,
        (entry) => owners.get(entry.person) ?? 0,
      ],
    );
    if (partly.winner) return certain(partly.winner, "number");
  }

  // 4. Not certain -- two people fit equally, or the name only resembles
  //    someone: an administrator decides, with the likely people offered.
  const reviewWith: string[] = [];
  const add = (id: string) => {
    if (!reviewWith.includes(id)) reviewWith.push(id);
  };
  for (const person of byOwner.tied) add(person.id);
  for (const person of byPrintedName.tied) add(person.id);
  for (const entry of nameRanked.sort((a, b) => b.level - a.level)) add(entry.person.id);
  for (const id of resembling(lookup, scannedWords)) add(id);
  for (const person of owners.keys()) add(person.id);
  if (reviewWith.length === 0) return NO_MATCH;
  return {
    id: null,
    method: "none",
    originalMethod: "none",
    review: true,
    candidates: reviewWith.slice(0, 6),
  };
}

/**
 * Whether `scanned` is `full` as the machine prints it when the name is too
 * long for its display: every scanned word is one of the person's name words,
 * or the start of one (down to an initial), each word used once, at least two
 * scanned words, and at least `minWholeWords` of them agreeing in full. Both arguments are normalizeName() forms (upper case, sorted).
 *
 *   "ANOMU JAMES OBOYO"   fits "ANOMUOGHARAN JAMES OBOYO"
 *   "AKPAN EDUOK MARIA"   fits "AKPAN ASSUMPTA EDUOK MARIA"
 *   "MICHELLE ONI P"      fits "MICHELLE ONI PRINCESS"
 *   "AMANDA IDAH"         does not fit "AMANA ANTHONY"
 */
function isShortenedName(scanned: string, full: string, minWholeWords = 1): boolean {
  if (!scanned || !full) return false;
  if (scanned === full) return true;
  const scannedWords = scanned.split(" ").sort((a, b) => b.length - a.length);
  if (scannedWords.length < 2) return false;
  const remaining = full.split(" ");
  let wholeWords = 0;
  // Whole words first, so a shortened word cannot take a word another needs.
  const shortWords: string[] = [];
  for (const word of scannedWords) {
    const index = remaining.indexOf(word);
    if (index === -1) shortWords.push(word);
    else {
      remaining.splice(index, 1);
      wholeWords += 1;
    }
  }
  for (const word of shortWords) {
    // A shortened word may be as short as an initial ("P" for "PRINCESS"); the
    // caller's minWholeWords keeps that from matching on initials alone.
    const index = remaining.findIndex((candidate) => candidate.startsWith(word));
    if (index === -1) return false;
    remaining.splice(index, 1);
  }
  return wholeWords >= minWholeWords;
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

/**
 * The `WHERE` fragment for who an event expects. An open event expects whoever
 * its scope covers on the staff or student list as it is now. A closed event
 * ("finalized") expects exactly the people it expected when it was closed
 * (event_expected), so people added to the list afterwards are never counted
 * there.
 */
async function expectedWhereFor(
  kind: GroupKind,
  event: StudentEvent | StaffEvent,
  params: SqlParam[],
  alias: string,
): Promise<string> {
  if (event.status !== "finalized") return openExpectedWhere(kind, event, params, alias);
  await freezeExpected(kind, event);
  params.push(kind, event.id);
  return `${alias}.id IN (SELECT person_id FROM event_expected WHERE kind = ? AND event_id = ?)`;
}

/**
 * Who an open event expects: the people its scope covers -- except anyone
 * added to the staff or student list after the event's last file was
 * uploaded, who is expected only if they scanned. Someone who was not on the
 * list when the attendance was taken is never counted absent for it.
 */
function openExpectedWhere(
  kind: GroupKind,
  event: StudentEvent | StaffEvent,
  params: SqlParam[],
  alias: string,
): string {
  const config = GROUPS[kind];
  const scope = scopeWhereFor(kind, scopeOf(event), params, alias);
  params.push(event.id, event.id);
  return `(${scope}) AND (
    ${alias}.created_at IS NULL
    OR ${alias}.created_at <= COALESCE(
         (SELECT MAX(uploaded_at) FROM ${config.uploads} WHERE event_id = ?), ${alias}.created_at)
    OR ${alias}.id IN (SELECT ${config.idColumn} FROM ${config.scans}
                        WHERE event_id = ? AND ${config.idColumn} IS NOT NULL))`;
}

/**
 * Write down who a closed event expects, once. An event closed by an older
 * version has no list yet; it gets one the first time it is read.
 */
async function freezeExpected(kind: GroupKind, event: StudentEvent | StaffEvent): Promise<void> {
  const existing = await queryOne<RowDataPacket & { ok: number }>(
    "SELECT 1 AS ok FROM event_expected WHERE kind = ? AND event_id = ? LIMIT 1",
    [kind, event.id],
  );
  if (existing) return;
  const config = GROUPS[kind];
  const params: SqlParam[] = [];
  const where = openExpectedWhere(kind, event, params, config.personAlias);
  await query(
    `INSERT INTO event_expected (kind, event_id, person_id)
     SELECT ?, ?, ${config.personAlias}.id FROM ${config.people} ${config.personAlias}
     WHERE ${where}`,
    [kind, event.id, ...params],
  );
}

/** Refuse a change to a closed event's attendance. */
export function assertEventOpen(event: { status: string; title?: string | null }): void {
  if (event.status === "finalized") {
    throw new HttpError(
      409,
      "This event is closed, so its attendance no longer changes. Reopen it first to add or change files.",
    );
  }
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
  const before = await getEvent(kind, eventId);
  // Closing writes down who is expected now; reopening forgets it, so an open
  // event follows the staff or student list again.
  await query("DELETE FROM event_expected WHERE kind = ? AND event_id = ?", [kind, eventId]);
  await query(
    `UPDATE ${config.events} SET status = ?, finalized_at = ?, updated_at = ? WHERE id = ?`,
    [status, status === "finalized" ? new Date() : null, utcStamp(), eventId],
  );
  if (status === "finalized") {
    await (await import("@/server/rematch")).ensureRematched(kind);
    await freezeExpected(kind, { ...before, status: "finalized" });
  }
  return getEvent(kind, eventId);
}

export async function deleteEvent(kind: GroupKind, eventId: string): Promise<void> {
  const config = GROUPS[kind];
  await getEvent(kind, eventId);
  await query("DELETE FROM event_expected WHERE kind = ? AND event_id = ?", [kind, eventId]);
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
/** "8:05", "08:05" or "08:05:30" as a comparable "08:05:00"; null when unset or unreadable. */
function clockOf(value: string | null | undefined): string | null {
  const match = /^\s*(\d{1,2}):(\d{2})(?::(\d{2}))?/.exec(value ?? "");
  if (!match) return null;
  const [, hours = "0", minutes = "00", seconds = "00"] = match;
  return `${hours.padStart(2, "0")}:${minutes}:${seconds}`;
}

/** The local calendar day ("2026-11-13") and clock ("07:45:00") of a moment. */
function localDayAndClock(moment: Date): { day: string; clock: string } {
  const pad = (value: number) => String(value).padStart(2, "0");
  return {
    day: `${moment.getFullYear()}-${pad(moment.getMonth() + 1)}-${pad(moment.getDate())}`,
    clock: `${pad(moment.getHours())}:${pad(moment.getMinutes())}:${pad(moment.getSeconds())}`,
  };
}

export async function uploadScans(
  kind: GroupKind,
  eventId: string,
  input: ScanUploadInput,
  actorId: string,
): Promise<{ upload: EventUpload | null; summary: EventSummary; added: number; skipped: number }> {
  const config = GROUPS[kind];
  const event = await getEvent(kind, eventId);
  assertEventOpen(event);
  const scope = scopeOf(event);
  const lookup = await loadLookup(config);
  const uploadId = randomUUID();

  const startAt = clockOf(event.start_time);
  const endAt = clockOf(event.end_time);

  type Prepared = {
    scanNumber: string | null;
    name: string | null;
    machineId: string | null;
    scannedAt: Date;
    personId: string | null;
    method: "machine_id" | "number" | "name" | "none";
    originalMethod: "machine_id" | "number" | "name" | "fuzzy_name" | "none";
    inScope: boolean;
    outsideWindow: boolean;
    review: boolean;
    candidates: string[];
  };

  const parsed: Prepared[] = [];
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
    // The event's date and hours are local wall-clock values, and so is the
    // time the machine printed, so both are compared in local time. Using the
    // UTC form here shifted every scan by the machine's offset (an hour in
    // Lagos) and moved scans near midnight onto the wrong day.
    const { day, clock } = localDayAndClock(scannedAt);
    const outsideWindow =
      day !== event.event_date ||
      (startAt !== null && clock < startAt) ||
      (endAt !== null && clock > endAt);

    parsed.push({
      scanNumber,
      name,
      machineId,
      scannedAt,
      personId: match.id,
      method: match.method,
      originalMethod: match.originalMethod,
      review: match.review,
      candidates: match.candidates,
      inScope,
      outsideWindow,
    });
  }

  // Rows already stored for this event are skipped: only new scans are added.
  const { fresh: prepared, skipped } = onlyNewScans(
    parsed,
    await storedScanKeys(config.scans, "event_id = ?", [eventId]),
  );
  if (prepared.length === 0) {
    return { upload: null, added: 0, skipped, summary: await eventSummary(kind, eventId) };
  }

  const counts = { present: new Set<string>(), outOfScope: new Set<string>(), unmatched: 0 };
  for (const row of prepared) {
    if (row.personId === null) {
      // A scan waiting for an administrator is not "unmatched" (yet).
      if (!row.review) counts.unmatched += 1;
    } else if (row.inScope) counts.present.add(row.personId);
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
          row.review ? 1 : 0,
          row.review ? JSON.stringify(row.candidates) : null,
        );
      }
      await connection.query(
        `INSERT INTO ${config.scans}
           (id, event_id, upload_id, scan_number, scanned_name, scanned_at,
            ${config.idColumn}, match_method, in_scope, outside_window, machine_id,
            needs_review, review_candidates)
         VALUES ${placeholders(batch.length, 13)}`,
        values,
      );
    }

    await connection.execute(`UPDATE ${config.events} SET updated_at = ? WHERE id = ?`, [
      utcStamp(),
      eventId,
    ]);
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
  return { upload, summary, added: prepared.length, skipped };
}

// Results ------------------------------------------------------------------

async function expectedCount(
  config: GroupConfig,
  kind: GroupKind,
  event: StudentEvent | StaffEvent,
): Promise<number> {
  const params: SqlParam[] = [];
  const where = await expectedWhereFor(kind, event, params, config.personAlias);
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

/**
 * An event's unmatched entries (src/server/unmatched.ts) and, per file, which
 * of them it holds -- the one count the cards, the tab, the file table and the
 * downloads all show.
 */
async function eventUnmatched(
  kind: GroupKind,
  eventId: string,
): Promise<{ list: UnmatchedEntry[]; perUpload: Map<string, Set<string>> }> {
  const config = GROUPS[kind];
  const rows = await query<
    RowDataPacket & {
      id: string;
      upload_id: string;
      scan_number: string | null;
      scanned_name: string | null;
      scanned_at: Date | string;
    }
  >(
    `SELECT id, upload_id, scan_number, scanned_name, scanned_at FROM ${config.scans}
      WHERE event_id = ? AND ${config.idColumn} IS NULL AND needs_review = 0`,
    [eventId],
  );
  const list = new UnmatchedList();
  const perUpload = new Map<string, Set<string>>();
  for (const row of rows) {
    const key = list.add({
      id: row.id,
      scan_number: row.scan_number,
      scanned_name: row.scanned_name,
      at: toIso(row.scanned_at) ?? "",
    });
    const set = perUpload.get(row.upload_id) ?? new Set<string>();
    set.add(key);
    perUpload.set(row.upload_id, set);
  }
  return { list: list.entries(), perUpload };
}

export async function eventSummary(kind: GroupKind, eventId: string): Promise<EventSummary> {
  await (await import("@/server/rematch")).ensureRematched(kind);
  const config = GROUPS[kind];
  const event = await getEvent(kind, eventId);
  const scopeParams: SqlParam[] = [];
  const scopeWhere = await expectedWhereFor(kind, event, scopeParams, config.personAlias);
  const [identity, inScope, scanned, counts, uploads, window, granted, unmatched] =
    await Promise.all([
      loadIdentity(kind),
      query<RowDataPacket & { id: string }>(
        `SELECT ${config.personAlias}.id FROM ${config.people} ${config.personAlias}
       WHERE ${scopeWhere}`,
        scopeParams,
      ),
      query<RowDataPacket & { person_id: string; in_scope: number }>(
        `SELECT DISTINCT ${config.idColumn} AS person_id, in_scope FROM ${config.scans}
       WHERE event_id = ? AND ${config.idColumn} IS NOT NULL`,
        [eventId],
      ),
      queryOne<RowDataPacket & { scans: number; pending: number }>(
        `SELECT COUNT(*) AS scans,
              SUM(CASE WHEN needs_review = 1 THEN 1 ELSE 0 END) AS pending
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
      // who did not scan.
      grantedPresentIds(kind, eventId, event),
      eventUnmatched(kind, eventId),
    ]);

  // Counted per PERSON: rows of the master list that are the same person
  // (src/server/identity.ts) count once, so nobody is both present and absent.
  const people = peopleOutcome(identity, inScope, scanned, granted);
  const lookAlikes = await lookAlikePairs(kind, people.present, people.absent, people.outOfScope);

  return {
    pendingReview: Number(counts?.pending ?? 0),
    lookAlikes: lookAlikes.length,
    event,
    uploads: uploads.length,
    scans: Number(counts?.scans ?? 0),
    expected: people.expected.size,
    present: people.present.size,
    absent: people.absent.size,
    outOfScope: people.outOfScope.size,
    unmatched: unmatched.list.length,
    percent: percent(people.present.size, people.expected.size),
    firstScanAt: toIso(window?.first_scan),
    lastScanAt: toIso(window?.last_scan),
  } as EventSummary;
}

/**
 * Who is expected, present, absent and out of scope at an event, as sets of
 * people (the id that stands for each person). Present, absent and out of
 * scope never overlap: present wins over everything, and only an expected
 * person can be absent.
 */
function peopleOutcome(
  identity: Identity,
  inScope: Array<{ id: string }>,
  scanned: Array<{ person_id: string; in_scope: number }>,
  granted: string[],
): { expected: Set<string>; present: Set<string>; absent: Set<string>; outOfScope: Set<string> } {
  const expected = new Set(inScope.map((row) => identity.canonical(row.id)));
  const present = new Set<string>();
  const scannedOutside = new Set<string>();
  for (const row of scanned) {
    const person = identity.canonical(row.person_id);
    // A scan counts when it was in scope at upload, or when the person it
    // matched is expected through another of their master rows.
    if (Number(row.in_scope) === 1 || expected.has(person)) present.add(person);
    else scannedOutside.add(person);
  }
  for (const id of granted) present.add(identity.canonical(id));
  const absent = new Set([...expected].filter((person) => !present.has(person)));
  const outOfScope = new Set([...scannedOutside].filter((person) => !present.has(person)));
  return { expected, present, absent, outOfScope };
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
  await (await import("@/server/rematch")).ensureRematched(kind);
  const config = GROUPS[kind];
  const event = await getEvent(kind, eventId);
  const alias = config.personAlias;
  const columns = personColumns(config);
  const groupBy = personGroupBy(config);
  const summary = await eventSummary(kind, eventId);

  const scopeParams: SqlParam[] = [];
  const scopeWhere = await expectedWhereFor(kind, event, scopeParams, alias);

  const [scannedPeople, inScopePeople, unmatched, uploadList, granted] = await Promise.all([
    // Every matched person with their scans, whether or not the upload judged
    // them in scope: whether they count is decided below, per person, by the
    // same rule as the totals (peopleOutcome).
    query<RowDataPacket & PresentRow & { any_in_scope: number }>(
      `SELECT ${columns}, COUNT(*) AS scan_count,
              MIN(sc.scanned_at) AS first_scan_at, MAX(sc.scanned_at) AS last_scan_at,
              MAX(sc.in_scope) AS any_in_scope
       FROM ${config.scans} sc
       JOIN ${config.people} ${alias} ON ${alias}.id = sc.${config.idColumn}
       WHERE sc.event_id = ?
       GROUP BY ${groupBy}
       ORDER BY name`,
      [eventId],
    ),
    query<RowDataPacket & AbsentRow>(
      `SELECT ${columns}
       FROM ${config.people} ${alias}
       WHERE ${scopeWhere}
       ORDER BY name`,
      scopeParams,
    ),
    eventUnmatched(kind, eventId),
    listUploads(kind, eventId),
    grantedPresentIds(kind, eventId, event),
  ]);

  // One row per PERSON in every list (see src/server/identity.ts): twins of
  // the same person are folded together, their scans added up. The rule is
  // peopleOutcome's, so the lists always agree with the totals and nobody is
  // on two lists.
  const identity = await loadIdentity(kind);
  const person = (id: string) => identity.canonical(id);
  const outcome = peopleOutcome(
    identity,
    inScopePeople.map((row) => ({ id: row.person_id })),
    scannedPeople.map((row) => ({ person_id: row.person_id, in_scope: Number(row.any_in_scope) })),
    granted,
  );
  const ownRowFirst = <T extends { person_id: string }>(current: T | undefined, row: T) =>
    !current || (row.person_id === person(row.person_id) && current.person_id !== row.person_id);

  const presentByPerson = new Map<string, PresentRow>();
  const outOfScopeByPerson = new Map<string, OutOfScopeRow>();
  for (const raw of scannedPeople) {
    const key = person(raw.person_id);
    const row: PresentRow = {
      person_id: raw.person_id,
      name: raw.name,
      code: raw.code,
      level: raw.level,
      department_code: raw.department_code,
      category: raw.category,
      scan_count: Number(raw.scan_count),
      first_scan_at: toIso(raw.first_scan_at) ?? "",
      last_scan_at: toIso(raw.last_scan_at) ?? "",
    };
    if (outcome.present.has(key)) {
      const current = presentByPerson.get(key);
      const base = ownRowFirst(current, row) ? row : current!;
      const firsts = [current?.first_scan_at, row.first_scan_at].filter(Boolean).sort();
      const lasts = [current?.last_scan_at, row.last_scan_at].filter(Boolean).sort();
      presentByPerson.set(key, {
        ...base,
        person_id: key,
        scan_count: row.scan_count + (current?.scan_count ?? 0),
        first_scan_at: firsts[0] ?? "",
        last_scan_at: lasts[lasts.length - 1] ?? "",
      });
    } else if (outcome.outOfScope.has(key)) {
      const current = outOfScopeByPerson.get(key);
      const base = ownRowFirst(current, row) ? row : current!;
      outOfScopeByPerson.set(key, {
        person_id: key,
        name: base.name,
        code: base.code,
        level: base.level,
        department_code: base.department_code,
        category: base.category,
        scan_count: row.scan_count + (current?.scan_count ?? 0),
      });
    }
  }

  // Present by a standing override, with no scan of their own: shown with a
  // scan count of 0 and empty scan times, which is the honest reading.
  const grantedOnly = granted.filter((id) => !presentByPerson.has(person(id)));
  const grantedPeople = await query<RowDataPacket & PresentRow>(
    `SELECT ${columns}, 0 AS scan_count, NULL AS first_scan_at, NULL AS last_scan_at
     FROM ${config.people} ${alias}
     WHERE ${alias}.id IN (${grantedOnly.map(() => "?").join(", ") || "NULL"})`,
    grantedOnly,
  );
  for (const row of grantedPeople) {
    const key = person(row.person_id);
    if (!presentByPerson.has(key)) {
      presentByPerson.set(key, { ...row, person_id: key, first_scan_at: "", last_scan_at: "" });
    }
  }

  const absentByPerson = new Map<string, AbsentRow>();
  for (const row of inScopePeople) {
    const key = person(row.person_id);
    if (!outcome.absent.has(key)) continue;
    if (ownRowFirst(absentByPerson.get(key), row)) {
      absentByPerson.set(key, { ...row, person_id: key });
    }
  }

  // Each file's numbers as they are now, in the same terms as the totals.
  const perFile = await query<RowDataPacket & { upload_id: string; person_id: string }>(
    `SELECT DISTINCT upload_id, ${config.idColumn} AS person_id FROM ${config.scans}
      WHERE event_id = ? AND ${config.idColumn} IS NOT NULL`,
    [eventId],
  );
  const livePresent = new Map<string, Set<string>>();
  const liveOutOfScope = new Map<string, Set<string>>();
  for (const row of perFile) {
    const key = person(row.person_id);
    const target = outcome.present.has(key)
      ? livePresent
      : outcome.outOfScope.has(key)
        ? liveOutOfScope
        : null;
    if (!target) continue;
    const set = target.get(row.upload_id) ?? new Set<string>();
    set.add(key);
    target.set(row.upload_id, set);
  }

  const byListName = (a: { name: string }, b: { name: string }) => a.name.localeCompare(b.name);
  return {
    ...summary,
    presentList: [...presentByPerson.values()].sort(byListName),
    absentList: [...absentByPerson.values()].sort(byListName),
    outOfScopeList: [...outOfScopeByPerson.values()].sort(byListName),
    // True when any row in presentList was granted rather than scanned, so the
    // event page can say the present count includes overrides instead of
    // leaving the reader to infer it from a zero in the scan column.
    hasGrantedPresence: granted.length > 0,
    unmatchedList: unmatched.list,
    uploadList: uploadList.map((upload) => ({
      ...upload,
      present_count: livePresent.get(upload.id)?.size ?? 0,
      out_of_scope_count: liveOutOfScope.get(upload.id)?.size ?? 0,
      unmatched_count: unmatched.perUpload.get(upload.id)?.size ?? 0,
    })),
  };
}

export {
  GROUPS,
  loadLookup,
  matchRow,
  wholeNameMatch,
  stringSimilarity,
  isShortenedName,
  type GroupConfig,
  type Lookup,
  type Match,
};
