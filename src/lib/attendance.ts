/**
 * Shared rules for the attendance system.
 *
 * Machine identity rule (from the institution):
 *  - Students are recognised by their record id number.
 *  - Staff are recognised by the digits inside their staff number (letters and
 *    spaces are ignored), and the machine often stores them with a "99" prefix.
 */

export type PersonType = "student" | "staff";

export function digitsOnly(value: string | null | undefined): string {
  if (!value) return "";
  const digits = String(value).replace(/\D/g, "");
  return digits.replace(/^0+(?=\d)/, "");
}

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

/** Candidate machine keys for one uploaded id, most specific first. */
export function candidateKeys(rawId: string | null | undefined): string[] {
  const base = digitsOnly(rawId);
  if (!base) return [];
  const keys = new Set<string>([base]);
  if (base.length > 2 && base.startsWith("99")) {
    keys.add(base.slice(2).replace(/^0+(?=\d)/, ""));
  }
  return [...keys];
}

/** Parse "VPG/PGD/ECO/15/1040" into its programme and department code. */
export function parseMatric(matric: string | null | undefined) {
  const parts = String(matric ?? "")
    .split("/")
    .map((p) => p.trim())
    .filter(Boolean);
  if (parts.length < 3) return { programme: null as string | null, departmentCode: null as string | null };
  return { programme: parts[1] ?? null, departmentCode: parts[2] ?? null };
}

export function fullName(last?: string | null, first?: string | null, middle?: string | null) {
  return [last, first, middle]
    .map((p) => (p ?? "").trim())
    .filter((p) => p && p.toUpperCase() !== "NULL")
    .join(" ")
    .replace(/\s+/g, " ");
}

/** Read a date/time cell from the machine export. */
export function parseScanTime(value: unknown): string | null {
  if (value == null || value === "") return null;
  const text = String(value).trim().replace(/\//g, "-");
  const date = new Date(text.includes("T") ? text : text.replace(" ", "T"));
  if (Number.isNaN(date.getTime())) return null;
  return date.toISOString();
}

export function toCsv(rows: Array<Record<string, unknown>>): string {
  if (rows.length === 0) return "";
  const headers = Object.keys(rows[0]);
  const escape = (v: unknown) => {
    const s = v == null ? "" : String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return [headers.join(","), ...rows.map((r) => headers.map((h) => escape(r[h])).join(","))].join("\n");
}

export function downloadCsv(fileName: string, rows: Array<Record<string, unknown>>) {
  const blob = new Blob([toCsv(rows)], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = fileName;
  link.click();
  URL.revokeObjectURL(url);
}

export async function chunked<T>(items: T[], size: number, run: (batch: T[]) => Promise<void>) {
  for (let i = 0; i < items.length; i += size) {
    await run(items.slice(i, i + size));
  }
}
