// Mass debts -----------------------------------------------------------------
//
// Every absence from a Weekly Mass costs a fixed amount: staff 10,000 naira,
// students 5,000 (changeable by an administrator, table debt_rates).
//
// Nothing is stored per person. The debts are worked out from the same
// per-person results the week's page shows (massResult) each time they are
// asked for, so anything that improves a week -- a scan matched after review,
// a duplicate merged, a re-upload, someone added to the always-present list --
// changes the debts by itself.
//
// Which weeks count: a week counts for a group (staff or students) only once a
// machine file for that group has been uploaded to it. A week with no upload
// has collected nothing, and would otherwise charge everyone expected.

import { uploadLevels } from "@/lib/attendance";
import type { RowDataPacket } from "./db";
import { dialect, query, utcStamp } from "@/server/db";
import { HttpError } from "@/server/http";
import { massResult } from "@/server/mass";
import type { ReportTable } from "@/server/mass-reports";
import type {
  DebtGroupTotal,
  DebtMonth,
  DebtPerson,
  DebtRates,
  DebtReport,
  DebtView,
  DebtWeek,
  MassUploadParticipant,
} from "@/lib/types";

export type { DebtReport, DebtView } from "@/lib/types";

export const DEFAULT_RATES: DebtRates = { staff: 10000, student: 5000 };

export async function debtRates(): Promise<DebtRates> {
  try {
    const rows = await query<RowDataPacket & { participant_type: string; amount: number }>(
      "SELECT participant_type, amount FROM debt_rates",
    );
    const rates = { ...DEFAULT_RATES };
    for (const row of rows) {
      if (row.participant_type === "staff") rates.staff = Number(row.amount);
      if (row.participant_type === "student") rates.student = Number(row.amount);
    }
    return rates;
  } catch {
    // A database without the table (a hosted MariaDB set up by hand) still works.
    return { ...DEFAULT_RATES };
  }
}

export async function setDebtRates(rates: DebtRates, actorId: string): Promise<DebtRates> {
  for (const [group, amount] of Object.entries(rates)) {
    if (!Number.isInteger(amount) || amount < 0 || amount > 10_000_000) {
      throw new HttpError(400, "Enter each amount in whole naira, 0 or more.");
    }
    await query(
      `INSERT INTO debt_rates (participant_type, amount, updated_by, updated_at) VALUES (?, ?, ?, ?)
       ${dialect.upsert(["participant_type"], ["amount", "updated_by", "updated_at"])}`,
      [group, amount, actorId, utcStamp()],
    );
  }
  return debtRates();
}

/** One absence = one charge. */
type Charge = {
  weekId: string;
  month: string;
  group: MassUploadParticipant;
  personId: string;
  number: string | null;
  name: string | null;
  department: string | null;
  amount: number;
};

function localDay(value: string | null): string | null {
  if (!value) return null;
  const text = String(value).replace(" ", "T");
  const date = new Date(/Z$|[+-]\d\d:?\d\d$/.test(text) ? text : `${text}Z`);
  if (Number.isNaN(date.getTime())) return null;
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/** Every (week, group) that counts, with its date. */
async function countedWeeks(): Promise<
  Array<{ weekId: string; weekName: string; date: string; group: MassUploadParticipant }>
> {
  const rows = await query<
    RowDataPacket & {
      id: string;
      name: string;
      created_at: string | null;
      participant_type: MassUploadParticipant;
      first_scan: string | null;
    }
  >(
    `SELECT w.id, w.name, w.created_at, u.participant_type,
            (SELECT MIN(s.scanned_at) FROM mass_scans s
              WHERE s.mass_week_id = w.id AND s.participant_type = u.participant_type) AS first_scan
       FROM mass_weeks w
       JOIN (SELECT DISTINCT mass_week_id, participant_type FROM mass_uploads) u
         ON u.mass_week_id = w.id`,
  );
  return rows.map((row) => ({
    weekId: row.id,
    weekName: row.name,
    group: row.participant_type === "staff" ? "staff" : "student",
    date: localDay(row.first_scan) ?? localDay(row.created_at) ?? "",
  }));
}

/**
 * The debts, worked out now. `month` ("2026-10") and `group` narrow every
 * section; search and department filters are applied on the page.
 */
export async function debtReport(filters: {
  month?: string | null;
  group?: MassUploadParticipant | null;
}): Promise<DebtReport> {
  const rates = await debtRates();
  const all = await countedWeeks();
  const months = [...new Set(all.map((week) => week.date.slice(0, 7)).filter(Boolean))]
    .sort()
    .reverse();
  const month = filters.month && /^\d{4}-\d{2}$/.test(filters.month) ? filters.month : null;
  const group = filters.group ?? null;
  const wanted = all.filter(
    (week) => (!month || week.date.startsWith(month)) && (!group || week.group === group),
  );

  const byWeek: DebtWeek[] = [];
  const charges: Charge[] = [];
  for (const week of wanted) {
    const result = await massResult(week.weekId, week.group, null);
    const rate = week.group === "staff" ? rates.staff : rates.student;
    // Student files are often uploaded per level ("100L", "200L"). Until a
    // level's file is in, its students have not been checked, so they are not
    // charged. An upload with no level covers every level.
    const levels = await query<RowDataPacket & { level: string | null }>(
      "SELECT DISTINCT level FROM mass_uploads WHERE mass_week_id = ? AND participant_type = ?",
      [week.weekId, week.group],
    );
    const everyLevel = levels.some((row) => !row.level || !row.level.trim());
    const uploadedLevels = new Set(levels.flatMap((row) => uploadLevels(row.level)));
    const absentees = everyLevel
      ? result.absentList
      : result.absentList.filter((row) => uploadedLevels.has((row.level ?? "").trim()));
    const counted = everyLevel
      ? { expected: result.expected, present: result.present }
      : {
          expected:
            result.presentList.filter((row) => uploadedLevels.has((row.level ?? "").trim()))
              .length + absentees.length,
          present: result.presentList.filter((row) => uploadedLevels.has((row.level ?? "").trim()))
            .length,
        };
    byWeek.push({
      weekId: week.weekId,
      weekName: week.weekName,
      date: week.date,
      month: week.date.slice(0, 7),
      group: week.group,
      expected: counted.expected,
      present: counted.present,
      absent: absentees.length,
      rate,
      amount: absentees.length * rate,
      levels: everyLevel ? null : [...uploadedLevels].sort(),
      provisional: result.pending_review + result.look_alikes > 0,
    });
    for (const row of absentees) {
      charges.push({
        weekId: week.weekId,
        month: week.date.slice(0, 7),
        group: week.group,
        personId: row.person_id,
        number: row.person_no,
        name: row.full_name,
        department: row.department,
        amount: rate,
      });
    }
  }
  byWeek.sort((a, b) => b.date.localeCompare(a.date) || a.weekName.localeCompare(b.weekName));

  const weekName = new Map(byWeek.map((week) => [week.weekId, week.weekName]));
  const people = new Map<string, DebtPerson>();
  for (const charge of charges) {
    const key = `${charge.group}|${charge.personId}`;
    let person = people.get(key);
    if (!person) {
      person = {
        group: charge.group,
        personId: charge.personId,
        number: charge.number,
        name: charge.name,
        department: charge.department,
        absences: 0,
        amount: 0,
        weeks: [],
      };
      people.set(key, person);
    }
    person.absences += 1;
    person.amount += charge.amount;
    const name = weekName.get(charge.weekId);
    if (name && !person.weeks.includes(name)) person.weeks.push(name);
  }
  const peopleList = [...people.values()].sort(
    (a, b) => b.amount - a.amount || (a.name ?? "").localeCompare(b.name ?? "", "en"),
  );

  const departments = new Map<string, DebtGroupTotal & { ids: Set<string> }>();
  for (const charge of charges) {
    const department = charge.department?.trim() || "(no department)";
    const key = `${charge.group}|${department}`;
    let entry = departments.get(key);
    if (!entry) {
      entry = {
        group: charge.group,
        department,
        people: 0,
        absences: 0,
        amount: 0,
        ids: new Set(),
      };
      departments.set(key, entry);
    }
    entry.absences += 1;
    entry.amount += charge.amount;
    entry.ids.add(charge.personId);
  }
  const byDepartment: DebtGroupTotal[] = [...departments.values()]
    .map(({ ids, ...entry }) => ({ ...entry, people: ids.size }))
    .sort((a, b) => b.amount - a.amount);

  const monthly = new Map<string, DebtMonth>();
  for (const week of byWeek) {
    let entry = monthly.get(week.month);
    if (!entry) {
      entry = {
        month: week.month,
        weeks: 0,
        staffAmount: 0,
        studentAmount: 0,
        amount: 0,
        absences: 0,
      };
      monthly.set(week.month, entry);
    }
    entry.weeks += 1;
    entry.absences += week.absent;
    entry.amount += week.amount;
    if (week.group === "staff") entry.staffAmount += week.amount;
    else entry.studentAmount += week.amount;
  }
  const byMonth = [...monthly.values()].sort((a, b) => b.month.localeCompare(a.month));

  const staffAmount = byWeek.filter((w) => w.group === "staff").reduce((s, w) => s + w.amount, 0);
  const studentAmount = byWeek
    .filter((w) => w.group === "student")
    .reduce((s, w) => s + w.amount, 0);
  return {
    rates,
    filters: { month, group },
    months,
    totals: {
      amount: staffAmount + studentAmount,
      staffAmount,
      studentAmount,
      absences: charges.length,
      people: peopleList.length,
      staffPeople: peopleList.filter((p) => p.group === "staff").length,
      studentPeople: peopleList.filter((p) => p.group === "student").length,
      weeks: byWeek.length,
    },
    byMonth,
    byWeek,
    byDepartment,
    people: peopleList,
  };
}

const naira = (amount: number) => `₦${amount.toLocaleString("en-NG")}`;
const groupName = (group: MassUploadParticipant) => (group === "staff" ? "Staff" : "Student");

/** One section of the debt report as a downloadable table. */
export function debtTable(
  report: DebtReport,
  view: DebtView,
  narrow: { department?: string | null; text?: string | null } = {},
): ReportTable {
  const meta: Array<[string, string]> = [
    ["Month", report.filters.month ?? "All months"],
    ["Who", report.filters.group ? groupName(report.filters.group) : "Staff and students"],
    [
      "Rates",
      `Staff ${naira(report.rates.staff)} · Students ${naira(report.rates.student)} per absence`,
    ],
    ["Total owed", naira(report.totals.amount)],
  ];
  if (view === "people") {
    const department = narrow.department?.trim() || null;
    const text = narrow.text?.trim().toUpperCase() || null;
    const rows = report.people.filter(
      (person) =>
        (!department || (person.department ?? "") === department) &&
        (!text ||
          `${person.name ?? ""} ${person.number ?? ""} ${person.department ?? ""}`
            .toUpperCase()
            .includes(text)),
    );
    if (department) meta.push(["Department / unit", department]);
    return {
      title: "Mass debts — each person owing",
      meta,
      columns: [
        "Name",
        "Number",
        "Group",
        "Department / unit",
        "Weeks missed",
        "Absences",
        "Amount (₦)",
      ],
      rows: rows.map((person) => [
        person.name ?? "",
        person.number ?? "",
        groupName(person.group),
        person.department ?? "",
        person.weeks.join(", "),
        person.absences,
        person.amount,
      ]),
    };
  }
  if (view === "departments") {
    return {
      title: "Mass debts — by department / unit",
      meta,
      columns: ["Group", "Department / unit", "People owing", "Absences", "Amount (₦)"],
      rows: report.byDepartment.map((entry) => [
        groupName(entry.group),
        entry.department,
        entry.people,
        entry.absences,
        entry.amount,
      ]),
    };
  }
  if (view === "weeks") {
    return {
      title: "Mass debts — by week",
      meta,
      columns: [
        "Week",
        "Date",
        "Group",
        "Expected",
        "Present",
        "Absent",
        "Rate (₦)",
        "Amount (₦)",
        "Status",
      ],
      rows: report.byWeek.map((week) => [
        week.weekName,
        week.date,
        week.levels
          ? `${groupName(week.group)} (level ${week.levels.join(", ")})`
          : groupName(week.group),
        week.expected,
        week.present,
        week.absent,
        week.rate,
        week.amount,
        week.provisional ? "Provisional: matches to confirm" : "Final",
      ]),
    };
  }
  return {
    title: "Mass debts — by month",
    meta,
    columns: ["Month", "Weeks", "Absences", "Staff (₦)", "Students (₦)", "Total (₦)"],
    rows: report.byMonth.map((entry) => [
      entry.month,
      entry.weeks,
      entry.absences,
      entry.staffAmount,
      entry.studentAmount,
      entry.amount,
    ]),
  };
}
