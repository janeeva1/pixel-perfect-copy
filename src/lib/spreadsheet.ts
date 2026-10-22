import * as XLSX from "xlsx";

export type SheetRow = Record<string, string>;

/** Read the first sheet of an Excel (.xls/.xlsx) or CSV file into plain rows. */
export async function readSpreadsheet(
  file: File,
): Promise<{ rows: SheetRow[]; headers: string[] }> {
  const buffer = await file.arrayBuffer();
  const workbook = XLSX.read(buffer, { type: "array", raw: false });
  const sheetName = workbook.SheetNames[0];
  if (!sheetName) return { rows: [], headers: [] };
  const matrix = XLSX.utils.sheet_to_json<string[]>(workbook.Sheets[sheetName] ?? {}, {
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

export type ImportTemplate = "students" | "staff";

/**
 * The registrar's own header rows, verbatim: every field quoted. The template
 * is the file this app already reads, not a friendlier invention, so a portal
 * export can be uploaded unchanged.
 *
 * The student header is the registrar's student export. The staff header is the
 * registrar's staff export, which carries two columns the app does not store --
 * `marital_status` and `department_category` -- and no `id` column: the id in
 * the student file is the machine's own numbering and is never read, and the
 * staff file has no such column at all. Columns are matched by name when a
 * file is read, so the order does not matter and a file with more or fewer
 * columns still imports; the header is here so a person can see what the app
 * expects.
 *
 * `department` and `admin_department` are the registrar's own text and are
 * stored as written. The department code every scope uses is still derived from
 * the matric number, and 'Religious' in a student's marital_status removes that
 * student from Sunday Mass expected populations only.
 */
const TEMPLATE_HEADER: Record<ImportTemplate, string> = {
  students:
    '"student_id","fname","lname","mname","marital_status","matric_no","department","level"',
  staff:
    '"fname","mname","lname","marital_status","staff_no","admin_department","department","department_category","faculty"',
};

/**
 * Two synthetic rows per file so the conventions of a real export are visible: a
 * blank middle name is left empty and unquoted, and a missing faculty or
 * department is the bare word `NULL`, exactly as the registrar writes it.
 */
const TEMPLATE_SAMPLE: Record<ImportTemplate, Array<Array<string | null>>> = {
  students: [
    ["17374", "ADA", "OKONKWO", "NGOZI", "Single", "VUG/CSC/25/1001", "Computer Science", "100"],
    ["17375", "TOLU", "ADEYEMI", "", "Religious", "VPG/PGD/ECO/25/2001", "Economics", "700"],
  ],
  staff: [
    [
      "EWAOCHE",
      "EMMANUEL",
      "AARON",
      "Married",
      "SA 1001",
      "Registry",
      "Computer Science",
      "specialist",
      "Science",
    ],
    ["BALOGUN", "IFE", "", "Single", "SA 1002", null, null, null, null],
  ],
};

function csvLine(fields: Array<string | null>): string {
  return fields
    .map((field) => {
      if (field === null) return "NULL";
      if (field === "") return "";
      return `"${field.replace(/"/g, '""')}"`;
    })
    .join(",");
}

/** A downloadable CSV template for one of the registrar's import files. */
export function buildImportTemplate(type: ImportTemplate): string {
  return `${[TEMPLATE_HEADER[type], ...TEMPLATE_SAMPLE[type].map(csvLine)].join("\r\n")}\r\n`;
}

/** Find a column by any of several likely names. */
export function pick(row: SheetRow, ...names: string[]): string {
  const keys = Object.keys(row);
  for (const name of names) {
    const wanted = name.toLowerCase().replace(/[\s_]/g, "");
    const key = keys.find((k) => k.toLowerCase().replace(/[\s_]/g, "") === wanted);
    const value = key === undefined ? undefined : row[key];
    if (value !== undefined && value !== "") return value;
  }
  return "";
}
