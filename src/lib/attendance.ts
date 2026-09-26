/**
 * Shared rules for the attendance system.
 *
 * Master list identity:
 *  - The master tables hold no number for the machine. The number it prints is
 *    read out of the file column that is already stored: the tail of a student's
 *    matric number, the digits of a staff member's staff number. A scan's number
 *    is joined to that, exactly. Nothing is reduced or rounded first: "149111"
 *    and "14911" are different people.
 *  - Some staff numbers share their digits with another staff member, so the
 *    scanned name picks between them. If it cannot, the scan is left unresolved
 *    rather than guessed.
 *  - A scan whose number is unknown falls back to an exact match on the
 *    normalized name, and only when exactly one person has that name.
 *
 * Student category, from the matric number prefix:
 *  - VUG  = undergraduate (VUGS is the sandwich variant, also undergraduate)
 *  - VPG  = postgraduate
 *  - anything else is left uncategorised rather than guessed
 *
 * The category and department rules are also expressed as SQL in
 * src/server/masters.ts, because reports have to filter and group on them in
 * SQL. This file is for the browser side only.
 *
 * Events are per group: a student event only ever matches students, and a staff
 * event only ever matches staff. That is what keeps a number that exists in both
 * lists from being resolved to the wrong person.
 */

import type { ReportPeriod } from "@/lib/types";

export type PersonType = "student" | "staff";

export type StudentCategory = "undergraduate" | "postgraduate";

export type { ReportPeriod };

/**
 * Reduce a name to a comparable form: upper case, letters and spaces only, word
 * order ignored. So "ada, byron king" and "KING Byron Ada" both become
 * "ADA BYRON KING".
 */
export function normalizeName(value: string | null | undefined): string {
  if (!value) return "";
  return String(value)
    .toUpperCase()
    .replace(/[^A-Z\s]/g, " ")
    .split(/\s+/)
    .filter(Boolean)
    .sort()
    .join(" ");
}

/**
 * Read a machine timestamp. The machine writes "2026/09/02 08:06:03" in local
 * time, and Excel exports vary, so anything unparseable is rejected rather than
 * guessed at.
 */
export function parseScanTime(value: unknown): Date | null {
  if (value == null || value === "") return null;
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value;

  if (typeof value === "number" && Number.isFinite(value)) {
    // Excel serial date: days since 1899-12-30.
    const fromSerial = new Date(Date.UTC(1899, 11, 30) + value * 86_400_000);
    return Number.isNaN(fromSerial.getTime()) ? null : fromSerial;
  }

  const text = String(value).trim();
  if (!text) return null;

  const slash = text.match(/^(\d{4})[/-](\d{1,2})[/-](\d{1,2})[ T]?(\d{1,2}:\d{2}(:\d{2})?)?/);
  if (slash) {
    const [, year = "", month = "", day = "", time = "00:00:00"] = slash;
    const parsed = new Date(
      `${year}-${month.padStart(2, "0")}-${day.padStart(2, "0")}T${time.length === 5 ? `${time}:00` : time}`,
    );
    return Number.isNaN(parsed.getTime()) ? null : parsed;
  }

  const fallback = new Date(text.replace(" ", "T"));
  return Number.isNaN(fallback.getTime()) ? null : fallback;
}

// CSV ---------------------------------------------------------------------

export function toCsv(headers: string[], rows: Array<Array<string | number | null>>): string {
  const escape = (value: string | number | null) => {
    const text = value == null ? "" : String(value);
    return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
  };
  return [headers.join(","), ...rows.map((row) => row.map(escape).join(","))].join("\n");
}

// Report periods ----------------------------------------------------------

/** Bucket key for a date, per reporting period. Weeks start on Monday. */
export function periodKey(date: Date, period: ReportPeriod): string {
  const year = date.getUTCFullYear();
  const month = String(date.getUTCMonth() + 1).padStart(2, "0");
  const day = String(date.getUTCDate()).padStart(2, "0");

  if (period === "monthly") return `${year}-${month}`;
  if (period === "weekly") {
    const monday = new Date(Date.UTC(year, date.getUTCMonth(), date.getUTCDate()));
    const weekday = (monday.getUTCDay() + 6) % 7;
    monday.setUTCDate(monday.getUTCDate() - weekday);
    return `${monday.getUTCFullYear()}-${String(monday.getUTCMonth() + 1).padStart(2, "0")}-${String(
      monday.getUTCDate(),
    ).padStart(2, "0")}`;
  }
  return `${year}-${month}-${day}`;
}

/** Human label for a bucket key produced by periodKey. */
export function periodLabel(key: string, period: ReportPeriod): string {
  if (period === "monthly") {
    const [year = "", month = ""] = key.split("-");
    const date = new Date(Date.UTC(Number(year), Number(month) - 1, 1));
    return date.toLocaleDateString("en-GB", { month: "long", year: "numeric", timeZone: "UTC" });
  }
  if (period === "weekly") return `Week of ${key}`;
  const [year = "", month = "", day = ""] = key.split("-");
  return new Date(Date.UTC(Number(year), Number(month) - 1, Number(day))).toLocaleDateString(
    "en-GB",
    {
      weekday: "short",
      day: "numeric",
      month: "short",
      year: "numeric",
      timeZone: "UTC",
    },
  );
}

/** Every bucket key between two dates, so gaps show as zero rather than vanish. */
export function periodRange(from: Date, to: Date, period: ReportPeriod): string[] {
  const keys: string[] = [];
  const cursor = new Date(Date.UTC(from.getUTCFullYear(), from.getUTCMonth(), from.getUTCDate()));
  const end = Date.UTC(to.getUTCFullYear(), to.getUTCMonth(), to.getUTCDate());
  let guard = 0;
  while (cursor.getTime() <= end && guard < 1000) {
    keys.push(periodKey(cursor, period));
    if (period === "monthly") cursor.setUTCMonth(cursor.getUTCMonth() + 1);
    else if (period === "weekly") cursor.setUTCDate(cursor.getUTCDate() + 7);
    else cursor.setUTCDate(cursor.getUTCDate() + 1);
    guard += 1;
  }
  return [...new Set(keys)];
}

/** Percentage rounded to one decimal, or null when there is no denominator. */
export function percent(part: number, whole: number): number | null {
  if (whole <= 0) return null;
  return Math.round((part / whole) * 1000) / 10;
}
