/**
 * Reconcile the staff and student master tables with the registrar's roster.
 *
 *   npx tsx db/reconcile-staff.ts            apply
 *   npx tsx db/reconcile-staff.ts --dry-run  report only
 *
 * The live tables came from an earlier export whose department names are the
 * student-style spellings ("Pharmacy", "Medical Sciences", "Computer and
 * Information Technology") and whose staff_no carries a space ("SA 1407"). The
 * registrar's roster (staffmapping.txt) is the authoritative naming the Mass
 * weekday assignments use, and a person whose department is not one of those
 * names is never expected at Mass. This script makes the two agree:
 *
 *   1. a roster row that matches a live person  -> department becomes the roster's
 *   2. a roster row with no live person         -> the person is inserted
 *   3. a live person the roster does not list   -> department is normalised to the
 *      roster's name for that old value, so nothing points at a name no longer
 *      seeded
 *   4. two live rows that are the same person   -> one is kept, the duplicate is
 *      deleted, so a person is counted once
 *   5. a student department in the old spelling -> normalised to the roster's
 *      name, so every student resolves to a weekday
 *
 * It is idempotent: matching is by staff_no (falling back to name), the insert
 * uses the unique staff_no, and every write is a no-op the second time. The
 * desktop app pulls these rows through the hub, so re-running it is safe.
 *
 * A department the script cannot place is reported and left untouched -- which
 * day it belongs to is a question for a person, not a guess -- and a department
 * not seeded in mass_department_weekdays is simply never expected at Mass.
 */
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { File } from "node:buffer";
import { closeDb, query, transaction, utcStamp } from "../src/server/db";
import { STAFF_ROSTER } from "./seed/staff-roster";
import { MASS_WEEKDAY_DEPARTMENTS } from "./seed/mass-weekday-departments";

const dryRun = process.argv.includes("--dry-run");

/**
 * The registrar's own staff export. It is the file of record for staff numbers:
 * the number in it is the one the scanning machine prints. The roster
 * (staffmapping.txt) numbers people by an older scheme, so the two can differ
 * ("A605" in the roster, "AT 605" in the export) and the export is the one to
 * keep.
 *
 * The file sits next to the project, not inside it, so its path can be given:
 *
 *   npx tsx db/reconcile-staff.ts --export "C:\path\to\staff.csv"
 *   set STAFF_EXPORT_CSV=C:\path\to\staff.csv
 *
 * When it is not there the script still runs; it then keeps the number that
 * looks like a written-out one and says so.
 */
const exportFlag = process.argv.indexOf("--export");
const exportPath =
  (exportFlag > -1 ? process.argv[exportFlag + 1] : undefined) ??
  process.env["STAFF_EXPORT_CSV"] ??
  resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "staff.csv");

const normNo = (s: string | null | undefined): string =>
  (s ?? "").toUpperCase().replace(/[^A-Z0-9]/g, "");
const normName = (s: string | null | undefined): string =>
  (s ?? "")
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, " ")
    .replace(/\s+/g, " ")
    .trim();

/**
 * The departments that have a weekday, which is the set of names the Mass
 * snapshot resolves. A person whose department is one of these is expected; a
 * person whose department is not one is simply never expected, which is not an
 * error. The comparison is case-insensitive, because that is how the database
 * compares a department name to a weekday assignment.
 */
const CANONICAL_DEPARTMENTS = new Set(
  MASS_WEEKDAY_DEPARTMENTS.map((row) => row.department.trim().toLowerCase()),
);
const isCanonical = (value: string | null | undefined): boolean =>
  CANONICAL_DEPARTMENTS.has((value ?? "").trim().toLowerCase());

/**
 * The digits of a staff number: "SA 1188" -> "1188". These identify a person,
 * which is the rule the app itself uses to read a scan (see
 * `staffScanNumberSql` in src/server/masters.ts): the letters are how the
 * office writes the number down, the digits are what the machine prints.
 *
 * So "G1033" and "J1033" are the same person, and "JT 067" and "J1067" are not.
 */
const normDigits = (s: string | null | undefined): string => (s ?? "").replace(/[^0-9]/g, "");

/**
 * The department a person is really in: the department column, or the admin
 * department when there is no department. This is the same order the app uses
 * (see `staffDepartmentSql`), so the script agrees with what every report
 * will say.
 */
const effectiveDepartment = (row: {
  department: string | null;
  admin_department: string | null;
}): string => (row.department ?? "").trim() || (row.admin_department ?? "").trim();

/**
 * Old (live) department name or admin_department -> the roster's department name.
 * Every value the current export uses is covered; see db/seed/staff-roster.ts for
 * the roster side. Keyed case-sensitively on the trimmed live value.
 */
const DEPARTMENT_NORMALISATION: Record<string, string> = {
  // admin_department values (people whose `department` is empty)
  Registry: "Registry",
  "Vice Chancellor": "VCs Office",
  Bursary: "Bursary",
  Library: "Library",
  "Medical Centre": "Medical Centre",
  "Students Affairs": "Student Affairs",
  Education: "Office of the Dean - Education",
  // student-style department values
  Accounting: "Accounting",
  Biochemistry: "Biochemistry",
  "Biotechnology and Environmental Biology": "Biotechnology/Environmental Biology",
  "Business Administration": "Business Administration",
  "Computer and Information Technology": "Computer Science",
  Economics: "Economics",
  "Educational Foundations": "Educational Foundation",
  "Electrical and Electronic Engineering": "Electrical and Electronic Engineering",
  "English and Literary Studies": "English and Literary Studies",
  Entrepreneurship: "Entrepreneurship",
  "Guidance and Counselling": "GUIDANCE AND COUNSELLING",
  "History and International Relations": "History and International Relations",
  Law: "Law",
  Marketing: "Marketing",
  "Mass Communication": "Mass Communication",
  Mathematics: "MATHEMATICAL SCIENCES",
  "Medical Laboratory Sciences": "Medical Laboratory Science",
  "Medical Sciences": "Medicine",
  Microbiology: "Microbiology",
  "Nursing Sciences": "Nursing",
  "Pharmaceutical And Medicinal Chemistry": "Pharmaceutical Science",
  "Pharmaceutical Microbiology and Biotechnology": "Pharmaceutical Science",
  "Pharmaceutics And Pharmaceutical Technology": "Pharmaceutical Science",
  Pharmacy: "Pharmaceutical Science",
  Philosophy: "Philosophy",
  "Public Administration": "Public Administration",
  "Pure and Applied Chemistry": "Pure and Applied Chemistry",
  "Pure and Applied Physics": "Pure and Applied Physics/Mathematics",
  "Religion and Intercultural Studies": "Religious Studies",
  "Software Engineering": "Software Engineering",
  "Theatre Arts": "Performing Arts",
  Theology: "Theology",
};

/**
 * Old student department spelling -> the roster's department name. The registrar
 * file that the students came from uses a few names the staff roster spells
 * differently; both point at the same department, so they are folded together so
 * a student resolves to the same weekday the department's staff do.
 */
const STUDENT_DEPARTMENT_NORMALISATION: Record<string, string> = {
  "Computer and Information Technology": "Computer Science",
  "Educational Foundations": "Educational Foundation",
  Finance: "Accounting",
  "Medical Laboratory Sciences": "Medical Laboratory Science",
  "Medical Sciences": "Medicine",
  "Nursing Sciences": "Nursing",
  "Peace And Conflict Studies": "Political Science and Diplomacy",
  Pharmacy: "Pharmaceutical Science",
  "Pure and Applied Physics": "Pure and Applied Physics/Mathematics",
  "Religion and Intercultural Studies": "Religious Studies",
  "Theatre Arts": "Performing Arts",
};

type LiveRow = {
  id: string;
  staff_no: string | null;
  last_name: string | null;
  first_name: string | null;
  middle_name: string | null;
  department: string | null;
  admin_department: string | null;
};

/**
 * The words of a name, in no particular order.
 *
 * The two sources write a name differently. The roster writes "Surname, Other
 * names" ("Emeaba Kalu Onuoha" is the surname Emeaba); the registrar's file
 * writes given names first ("EMEABA ONUOHA KALU" is the surname Kalu). One of
 * them has the parts in the wrong order for this person, and there is no way
 * to tell which, so a name is compared as the set of its words. Two names
 * that share two words are the same name, whatever order the words are in.
 */
const nameWords = (last: string, first: string, middle: string): Set<string> => {
  const words = `${last} ${first} ${middle}`
    .toUpperCase()
    .replace(/[^A-Z0-9 ]/g, " ")
    .split(/\s+/)
    .filter(Boolean);
  return new Set(words);
};

const sharedWords = (a: Set<string>, b: Set<string>): number => {
  let count = 0;
  for (const word of a) if (b.has(word)) count += 1;
  return count;
};

/**
 * Whether a live person can be the roster's person of that name, judged by the
 * department.
 *
 * Two people can share a name -- the registrar's file carries a PATRICIA
 * PETER in the Medical Centre (J1067) and another in the Vice Chancellor's
 * office (JT 067) -- so a name on its own is not enough to say that a live row
 * is the roster's person. The department has to agree, either directly or
 * through the old spelling the normalisation table knows about.
 */
const departmentAgrees = (
  live: LiveRow,
  rosterDepartment: string,
  normalise: (value: string) => string | undefined,
): boolean => {
  const wanted = rosterDepartment.trim().toLowerCase();
  const effective = effectiveDepartment(live).trim().toLowerCase();
  const admin = (live.admin_department ?? "").trim().toLowerCase();
  if (effective === wanted || admin === wanted) return true;
  if (effective && normalise(effective) === wanted) return true;
  // A person with no department at all is not contradicted by anything.
  return effective === "" && admin === "";
};

/**
 * The staff numbers the registrar's own export carries, normalised the same way
 * the script normalises a number everywhere else.
 *
 * Used for one decision only: when the same person is in the live table twice,
 * the row whose number the export also carries is the one to keep, because that
 * is the number the scanning machine prints. The other row is the one written
 * from the roster, which numbers people by an older scheme.
 */
async function readExportNumbers(): Promise<Set<string>> {
  if (!existsSync(exportPath)) {
    console.log(
      `The registrar's export is not at ${exportPath}, so the staff number kept for a duplicated person is the one that looks written out.`,
    );
    return new Set();
  }
  const { readSpreadsheet } = await import("../src/lib/spreadsheet");
  const text = await readFile(exportPath);
  const { rows } = await readSpreadsheet(new File([text], "staff.csv"));
  const numbers = new Set<string>();
  for (const row of rows) {
    const value = (row["staff_no"] ?? "").trim();
    if (!value || value === "NULL" || value === "-") continue;
    numbers.add(normNo(value));
  }
  console.log(`Read ${numbers.size} staff numbers from ${exportPath}`);
  return numbers;
}

async function readFile(path: string): Promise<Buffer> {
  const { readFile: read } = await import("node:fs/promises");
  return read(path);
}

async function main(): Promise<void> {
  const all = await query<LiveRow>(
    "SELECT id, staff_no, last_name, first_name, middle_name, department, admin_department FROM staff",
  );
  const exportNumbers = await readExportNumbers();

  const wordsOf = new Map<string, Set<string>>();
  for (const s of all) {
    wordsOf.set(s.id, nameWords(s.last_name ?? "", s.first_name ?? "", s.middle_name ?? ""));
  }

  // The same person twice. The export wrote a row for a person whose staff_no
  // gained or lost a space or a dash ("SAC 1353-" vs "SAC 1353--"), and
  // sometimes wrote the same person's name in the other order. Both leave two
  // rows for one person, so a person is counted twice in every report.
  //
  // Two rows are the same person when their staff numbers carry the same
  // digits and their names agree. The digits are the app's own rule for
  // identity (see staffScanNumberSql); the name is what tells apart the
  // sixty-odd staff numbers whose digits collide. Two people can share a name
  // -- the registrar's file has a PATRICIA PETER in the Medical Centre (J1067)
  // and another in the Vice Chancellor's office (JT 067) -- and those two are
  // never folded together.
  //
  // This happens before the roster is matched, so that the roster is matched
  // against the rows that are left: a person who was matched cannot then be
  // deleted out from under the department the roster gives them.
  const deletes: string[] = [];
  const duplicateGroups: Array<{ keep: LiveRow; dropped: LiveRow[] }> = [];
  const byDigitsAll = new Map<string, LiveRow[]>();
  const numberless: LiveRow[] = [];
  for (const s of all) {
    const digits = normDigits(s.staff_no);
    if (digits) (byDigitsAll.get(digits) ?? byDigitsAll.set(digits, []).get(digits)!).push(s);
    else numberless.push(s);
  }

  /** Two rows are the same person when their names agree. */
  const sameName = (a: LiveRow, b: LiveRow): boolean => {
    const aw = wordsOf.get(a.id)!;
    const bw = wordsOf.get(b.id)!;
    if (aw.size === 0 || bw.size === 0) return true; // a row with no name
    return sharedWords(aw, bw) >= 2;
  };

  /**
   * Which row of a group of the same person to keep.
   *
   * First the number the registrar's export also carries, because that is the
   * number the scanning machine prints; the roster's own numbering is older.
   * Then a usable number, a number written cleanly ("SA 1220" rather than
   * "SA 1220-"), a department, and finally the fullest name.
   */
  const bestOf = (group: LiveRow[]): LiveRow =>
    [...group].sort((a, b) => {
      const aExport = exportNumbers.has(normNo(a.staff_no)) ? 1 : 0;
      const bExport = exportNumbers.has(normNo(b.staff_no)) ? 1 : 0;
      if (aExport !== bExport) return bExport - aExport;
      const aNo = (a.staff_no ?? "").trim() ? 1 : 0;
      const bNo = (b.staff_no ?? "").trim() ? 1 : 0;
      if (aNo !== bNo) return bNo - aNo;
      // A number that does not end in a dash or a space is the better one:
      // "SA 1220" rather than "SA 1220-".
      const aClean = /[\s-]$/.test(a.staff_no ?? "") ? 0 : 1;
      const bClean = /[\s-]$/.test(b.staff_no ?? "") ? 0 : 1;
      if (aClean !== bClean) return bClean - aClean;
      const aDept = (a.department ?? "").trim() ? 1 : 0;
      const bDept = (b.department ?? "").trim() ? 1 : 0;
      if (aDept !== bDept) return bDept - aDept;
      return wordsOf.get(b.id)!.size - wordsOf.get(a.id)!.size;
    })[0]!;

  for (const group of byDigitsAll.values()) {
    if (group.length < 2) continue;
    // Split the group into people: each cluster is one person, and the
    // clusters are people whose numbers collide but whose names do not.
    const clusters: LiveRow[][] = [];
    for (const row of group) {
      const cluster = clusters.find((c) => sameName(c[0]!, row));
      if (cluster) cluster.push(row);
      else clusters.push([row]);
    }
    for (const cluster of clusters) {
      if (cluster.length < 2) continue;
      const keep = bestOf(cluster);
      for (const row of cluster) if (row.id !== keep.id) deletes.push(row.id);
      duplicateGroups.push({
        keep,
        dropped: cluster.filter((row) => row.id !== keep.id),
      });
    }
  }

  // A row with no staff number is the same person as a numbered row when it is
  // the only person of that name: the numbered row is the better record.
  for (const row of numberless) {
    const samePerson = [...byDigitsAll.values()].filter((group) =>
      group.some((other) => other.id !== row.id && sameName(other, row)),
    );
    if (samePerson.length === 1) {
      deletes.push(row.id);
      duplicateGroups.push({ keep: samePerson[0]![0]!, dropped: [row] });
    }
  }
  const deleteSet = new Set(deletes);

  // What is left: the people, one row each. The indexes below are built from
  // these rows, not from every row: a row that is about to be deleted must not
  // be matched, or the roster's department would be written to a row that is
  // then removed and the person would keep the old one.
  const staff = all.filter((s) => !deleteSet.has(s.id));

  const byNo = new Map<string, LiveRow[]>();
  const byDigits = new Map<string, LiveRow[]>();
  for (const s of staff) {
    const no = normNo(s.staff_no);
    if (no) (byNo.get(no) ?? byNo.set(no, []).get(no)!).push(s);
    const digits = normDigits(s.staff_no);
    if (digits) (byDigits.get(digits) ?? byDigits.set(digits, []).get(digits)!).push(s);
  }

  const usedIds = new Set<string>();
  type Update = { id: string; department: string; reason: string };
  const updates: Update[] = [];
  type Insert = {
    staffNo: string;
    last: string;
    first: string;
    middle: string;
    department: string;
  };
  const inserts: Insert[] = [];
  const ambiguous: Array<{
    staffNo: string;
    name: string;
    department: string;
    candidates: string[];
  }> = [];

  for (const r of STAFF_ROSTER) {
    /**
     * A roster row is matched to a live person like this:
     *
     *   1. by staff number -- the same number, or the same digits, which is
     *      the app's own rule for "the same person" (see staffScanNumberSql)
     *   2. by name -- the same words, whatever order the two sources write
     *      them in
     *
     * A number match is only believed when the name does not contradict it.
     * The two files disagree about one staff number: the roster's SA1027 is
     * John Mary and the registrar's SA 1027 is Isah Sylvester Bako. The name
     * settles it, so the number is not allowed to.
     *
     * A name match is only believed when the department agrees, because two
     * people can share a name. When it does not agree, the roster's person is
     * not in the live table, and is inserted rather than stealing the other
     * person's department.
     */
    const rosterWords = nameWords(r.last, r.first, r.middle);
    const free = (rows: LiveRow[] | undefined): LiveRow[] =>
      (rows ?? []).filter((s) => !usedIds.has(s.id));

    const byNumber = [
      ...free(byNo.get(normNo(r.staffNo))),
      ...free(byDigits.get(normDigits(r.staffNo))),
    ].filter((s) => sharedWords(rosterWords, wordsOf.get(s.id)!) > 0);

    const byName = staff.filter(
      (s) => !usedIds.has(s.id) && sharedWords(rosterWords, wordsOf.get(s.id)!) >= 2,
    );

    let hit: LiveRow | undefined;
    if (byNumber.length > 0) {
      hit = byNumber[0];
    } else if (byName.length === 1) {
      const candidate = byName[0]!;
      hit = departmentAgrees(candidate, r.department, (v) => DEPARTMENT_NORMALISATION[v])
        ? candidate
        : undefined;
    } else if (byName.length > 1) {
      // Several people share the name: take the one whose number agrees, then
      // the one whose department agrees, and otherwise leave it to a person.
      const sameNumber = byName.find(
        (s) =>
          normNo(s.staff_no) === normNo(r.staffNo) ||
          normDigits(s.staff_no) === normDigits(r.staffNo),
      );
      hit =
        sameNumber ??
        byName.find((s) => departmentAgrees(s, r.department, (v) => DEPARTMENT_NORMALISATION[v]));
      if (!hit) {
        ambiguous.push({
          staffNo: r.staffNo,
          name: `${r.last} ${r.first} ${r.middle}`.trim(),
          department: r.department,
          candidates: byName.map((s) => s.staff_no ?? "(no number)"),
        });
      }
    }

    if (hit) {
      usedIds.add(hit.id);
      // The roster is authoritative about the department a person is in, but
      // only about the department: the staff number stays as the registrar
      // wrote it, because that is the number the machine prints.
      if (effectiveDepartment(hit) !== r.department) {
        updates.push({ id: hit.id, department: r.department, reason: "roster match" });
      }
    } else {
      inserts.push({
        staffNo: r.staffNo,
        last: r.last,
        first: r.first,
        middle: r.middle,
        department: r.department,
      });
    }
  }

  // Live-only rows: normalise their department to the canonical naming.
  // "Canonical" means the department has a weekday assigned. The roster is
  // not the whole story: the departments only the student file knows about are
  // in the weekday list too, so a person in one of those is placed, not
  // reported as a problem.
  const unplaceable: LiveRow[] = [];
  for (const s of staff) {
    if (usedIds.has(s.id)) continue;
    const src = effectiveDepartment(s);
    // Already a canonical department name: nothing to translate.
    if (isCanonical(src)) continue;
    const target = DEPARTMENT_NORMALISATION[src];
    if (target === undefined) {
      if (src === "") continue; // genuinely blank: nothing to place
      unplaceable.push(s);
      continue;
    }
    if (src !== target) {
      updates.push({ id: s.id, department: target, reason: "normalised" });
    }
  }

  // Students: fold the old department spellings into the canonical names, so
  // every student resolves to a weekday. Read the distinct values once. A
  // student whose department is already canonical is left alone and is not
  // reported: there is nothing to fix about it.
  const studentDeptRows = await query<{ department: string }>(
    "SELECT DISTINCT department FROM students WHERE NULLIF(TRIM(department), '') IS NOT NULL",
  );
  const studentUpdates: { from: string; to: string }[] = [];
  const studentUnmapped: string[] = [];
  for (const row of studentDeptRows) {
    const src = (row.department ?? "").trim();
    if (isCanonical(src)) continue; // already resolves to a weekday
    const target = STUDENT_DEPARTMENT_NORMALISATION[src];
    if (target === undefined) {
      studentUnmapped.push(src);
      continue;
    }
    studentUpdates.push({ from: src, to: target });
  }

  console.log(`live staff         : ${staff.length}`);
  console.log(`roster rows        : ${STAFF_ROSTER.length}`);
  console.log(`department edits   : ${updates.length}`);
  console.log(`rows to insert     : ${inserts.length}`);
  console.log(`duplicates to drop : ${deletes.length}`);
  console.log(`student dept edits : ${studentUpdates.length}`);
  console.log(`unplaceable staff  : ${unplaceable.length}`);
  console.log(`ambiguous names    : ${ambiguous.length}`);

  // Say what the edits are, so a count of two is a thing somebody can read
  // rather than a number to wonder about.
  const staffById = new Map(staff.map((s) => [s.id, s]));
  for (const u of updates) {
    const s = staffById.get(u.id);
    console.log(
      `  -> ${s?.staff_no ?? "?"}  ${s?.last_name ?? ""} ${s?.first_name ?? ""}  "${s?.department ?? ""}" => "${u.department}"  (${u.reason})`,
    );
  }
  for (const u of studentUpdates) {
    console.log(`  -> students "${u.from}" => "${u.to}"`);
  }
  for (const r of inserts) {
    console.log(
      `  ++ ${r.staffNo}  ${r.last} ${r.first} ${r.middle}  dept="${r.department}"  (not in the live table)`,
    );
  }
  for (const a of ambiguous) {
    console.log(
      `  ?? ${a.staffNo}  ${a.name}  dept="${a.department}"  is one of several people of that name: ${a.candidates.join(", ")}`,
    );
  }
  for (const group of duplicateGroups) {
    const keptNumber = group.keep.staff_no ?? "";
    const fromExport = exportNumbers.has(normNo(group.keep.staff_no));
    console.log(
      `  -- keep ${JSON.stringify(keptNumber)} ${group.keep.last_name ?? ""} ${group.keep.first_name ?? ""}${fromExport ? " (the export's number)" : ""}  drop ${group.dropped
        .map((r) => JSON.stringify(r.staff_no))
        .join(", ")}`,
    );
  }
  for (const s of unplaceable) {
    console.log(
      `  ?? ${s.staff_no ?? "?"}  ${s.last_name ?? ""} ${s.first_name ?? ""}  dept="${s.department ?? ""}" admin="${s.admin_department ?? ""}"`,
    );
  }
  if (studentUnmapped.length > 0) {
    console.log(`student depts with no mapping: ${studentUnmapped.join(", ")}`);
  }

  if (dryRun) {
    console.log("\n--dry-run: no changes written.");
    await closeDb();
    // Not process.exit(0): exiting while the pool is still winding up trips an
    // assertion in Node's async layer, and the script has nothing left to do.
    return;
  }

  await transaction(async (connection) => {
    for (const id of deleteSet) {
      await connection.execute("DELETE FROM staff WHERE id = ?", [id]);
    }
    for (const u of updates) {
      await connection.execute("UPDATE staff SET department = ?, updated_at = ? WHERE id = ?", [
        u.department,
        utcStamp(),
        u.id,
      ]);
    }
    for (const r of inserts) {
      await connection.execute(
        `INSERT INTO staff (id, staff_no, last_name, first_name, middle_name, department, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          randomUUID(),
          r.staffNo || null,
          r.last,
          r.first,
          r.middle || null,
          r.department,
          utcStamp(),
          utcStamp(),
        ],
      );
    }
    for (const u of studentUpdates) {
      await connection.execute(
        "UPDATE students SET department = ?, updated_at = ? WHERE TRIM(department) = ?",
        [u.to, utcStamp(), u.from],
      );
    }
  });

  console.log(
    `\napplied: ${deletes.length} delete(s), ${updates.length} staff update(s), ${inserts.length} insert(s), ${studentUpdates.length} student dept update(s).`,
  );
  await closeDb();
}

main().catch((error: Error) => {
  console.error(error.message);
  process.exitCode = 1;
});
