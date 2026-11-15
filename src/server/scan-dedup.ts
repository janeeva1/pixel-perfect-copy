// Keeping one copy of each scan ---------------------------------------------
//
// The same machine export is often uploaded twice, or a later export repeats
// the earlier rows (clock-in file, then the whole day again). A scan is the
// same scan when the machine printed the same number and name at the same
// second; such rows are skipped, so an upload only adds what was not there.

import type { RowDataPacket } from "./db";
import { query, type SqlParam } from "@/server/db";
import { normalizeName } from "@/lib/attendance";

/** The stored time, to the second, as UTC text ("2026-10-05 10:30:01"). */
function secondOf(value: unknown): string {
  if (value instanceof Date) return value.toISOString().replace("T", " ").slice(0, 19);
  return String(value ?? "")
    .replace("T", " ")
    .replace(/Z$/, "")
    .slice(0, 19);
}

/** One scan's identity: number (leading zeros ignored), name (any order), time. */
export function scanKey(
  scanNumber: string | null | undefined,
  name: string | null | undefined,
  at: Date | string | null | undefined,
): string {
  const number = (scanNumber ?? "").trim().replace(/^0+(?=\d)/, "");
  return `${number}|${normalizeName(name)}|${secondOf(at)}`;
}

/** Keys of the scans already stored for one week (and group) or one event. */
export async function storedScanKeys(
  table: string,
  where: string,
  params: SqlParam[],
): Promise<Set<string>> {
  const rows = await query<
    RowDataPacket & { scan_number: string | null; scanned_name: string | null; scanned_at: unknown }
  >(`SELECT scan_number, scanned_name, scanned_at FROM ${table} WHERE ${where}`, params);
  return new Set(
    rows.map((row) => scanKey(row.scan_number, row.scanned_name, row.scanned_at as string)),
  );
}

/**
 * Drop the rows already stored, and repeats within the file itself. Returns
 * the rows to add and how many were skipped.
 */
export function onlyNewScans<
  T extends { scanNumber: string | null; name: string | null; scannedAt: Date },
>(rows: T[], stored: Set<string>): { fresh: T[]; skipped: number } {
  const seen = new Set(stored);
  const fresh: T[] = [];
  for (const row of rows) {
    const key = scanKey(row.scanNumber, row.name, row.scannedAt);
    if (seen.has(key)) continue;
    seen.add(key);
    fresh.push(row);
  }
  return { fresh, skipped: rows.length - fresh.length };
}
