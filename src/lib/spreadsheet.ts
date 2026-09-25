import * as XLSX from "xlsx";

export type SheetRow = Record<string, string>;

/** Read the first sheet of an Excel (.xls/.xlsx) or CSV file into plain rows. */
export async function readSpreadsheet(file: File): Promise<{ rows: SheetRow[]; headers: string[] }> {
  const buffer = await file.arrayBuffer();
  const workbook = XLSX.read(buffer, { type: "array", raw: false });
  const sheetName = workbook.SheetNames[0];
  if (!sheetName) return { rows: [], headers: [] };
  const matrix = XLSX.utils.sheet_to_json<string[]>(workbook.Sheets[sheetName], {
    header: 1,
    raw: false,
    defval: "",
    blankrows: false,
  });
  if (matrix.length === 0) return { rows: [], headers: [] };
  const headers = (matrix[0] ?? []).map((h) => String(h ?? "").trim());
  const rows = matrix.slice(1).map((line) => {
    const row: SheetRow = {};
    headers.forEach((header, index) => {
      row[header] = String(line?.[index] ?? "").trim();
    });
    return row;
  });
  return { rows: rows.filter((row) => Object.values(row).some((value) => value !== "")), headers };
}

/** Find a column by any of several likely names. */
export function pick(row: SheetRow, ...names: string[]): string {
  const keys = Object.keys(row);
  for (const name of names) {
    const key = keys.find((k) => k.toLowerCase().replace(/[\s_]/g, "") === name.toLowerCase().replace(/[\s_]/g, ""));
    if (key && row[key] !== "") return row[key];
  }
  return "";
}
