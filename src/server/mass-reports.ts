// Downloadable Community Mass reports: CSV, Excel and PDF, all from the same
// saved calculation results and the same header block, so the three formats
// can never disagree about what a week said.
//
// Every file carries the institution's name and, when the logo asset can be
// found on disk, its logo; the report title names the week and the category
// ("Week 1 Community Mass — Absent Students Report"), and the header states
// the scope, participant, level and the weekdays the week was selected for.
// Excel and PDF are formatted for reading: merged title block,
// column widths, borders, and table headings repeated on every PDF page.
//
// The same table writers serve the existing event reports, so an event's
// xlsx/pdf export is branded the same way as a Mass week's.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import ExcelJS from "exceljs";
import { jsPDF } from "jspdf";
import autoTable from "jspdf-autotable";
import { toCsv } from "@/lib/attendance";
import { massResult } from "@/server/mass";
import type { EventResult, MassUploadParticipant } from "@/lib/types";

/**
 * The institution's name, as the reports print it. The application has no
 * settings table holding one, and inventing a different name per export would
 * be worse than a single honest constant.
 */
export const INSTITUTION_NAME = "Veritas University, Abuja";

/**
 * Where the official logo lives. The app ships one asset (public/bmx.png,
 * also used in the sidebar); an override is honoured for an install that has
 * the university's own file. When nothing is found the reports still generate,
 * with the name in words rather than a made-up image.
 */
function logoPath(): string | null {
  const candidates = [
    process.env["INSTITUTION_LOGO_PATH"],
    path.resolve(process.cwd(), "public", "bmx.png"),
    path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "public", "bmx.png"),
  ].filter((candidate): candidate is string => Boolean(candidate));
  for (const candidate of candidates) {
    try {
      if (fs.existsSync(candidate)) return candidate;
    } catch {
      // An unreadable candidate is treated the same as a missing one.
    }
  }
  return null;
}

export type ReportTable = {
  title: string;
  /** Header lines under the title: level, weekdays, and so on. */
  meta: Array<[string, string]>;
  columns: string[];
  rows: Array<Array<string | number>>;
};

export type ReportFormat = "csv" | "xlsx" | "pdf";

const CONTENT_TYPES: Record<ReportFormat, string> = {
  csv: "text/csv;charset=utf-8",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  pdf: "application/pdf",
};

function slug(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
}

/** CSV: the header block as lines, then the table. No styling. */
export function reportCsv(table: ReportTable): string {
  const lines = [
    `${INSTITUTION_NAME}`,
    table.title,
    ...table.meta.map(([key, value]) => `${key}: ${value}`),
    `Records: ${table.rows.length}`,
    "",
    toCsv(table.columns, table.rows),
  ];
  return lines.join("\n");
}

/** Excel: merged title block, logo when available, bordered table, widths. */
export async function reportXlsx(table: ReportTable): Promise<Buffer> {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet("Report");
  const span = Math.max(table.columns.length, 4);

  let rowIndex = 1;
  sheet.mergeCells(rowIndex, 1, rowIndex, span);
  const institutionCell = sheet.getCell(rowIndex, 1);
  institutionCell.value = INSTITUTION_NAME;
  institutionCell.font = { bold: true, size: 14 };
  institutionCell.alignment = { vertical: "middle" };
  sheet.getRow(rowIndex).height = 24;
  rowIndex += 1;

  sheet.mergeCells(rowIndex, 1, rowIndex, span);
  const titleCell = sheet.getCell(rowIndex, 1);
  titleCell.value = table.title;
  titleCell.font = { bold: true, size: 12 };
  rowIndex += 1;

  for (const [key, value] of table.meta) {
    sheet.getCell(rowIndex, 1).value = key;
    sheet.getCell(rowIndex, 1).font = { bold: true };
    sheet.getCell(rowIndex, 2).value = value;
    rowIndex += 1;
  }
  sheet.getCell(rowIndex, 1).value = `Records: ${table.rows.length}`;
  sheet.getCell(rowIndex, 1).font = { italic: true };
  rowIndex += 2;

  const logo = logoPath();
  if (logo) {
    try {
      const imageId = workbook.addImage({ filename: logo, extension: "png" });
      sheet.addImage(imageId, {
        tl: { col: Math.max(table.columns.length - 1, 0), row: 0.2 },
        ext: { width: 56, height: 56 },
      });
    } catch {
      // A logo that cannot be embedded drops the picture, not the report.
    }
  }

  const headerRowIndex = rowIndex;
  const headerRow = sheet.getRow(headerRowIndex);
  table.columns.forEach((column, index) => {
    const cell = headerRow.getCell(index + 1);
    cell.value = column;
    cell.font = { bold: true, color: { argb: "FFFFFFFF" } };
    cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF1E293B" } };
    cell.alignment = { vertical: "middle", wrapText: true };
    cell.border = {
      top: { style: "thin" },
      left: { style: "thin" },
      bottom: { style: "thin" },
      right: { style: "thin" },
    };
  });
  headerRow.commit();
  rowIndex += 1;

  for (const rowValues of table.rows) {
    const row = sheet.getRow(rowIndex);
    table.columns.forEach((_, index) => {
      const cell = row.getCell(index + 1);
      cell.value = rowValues[index] ?? "";
      cell.border = {
        top: { style: "hair" },
        left: { style: "hair" },
        bottom: { style: "hair" },
        right: { style: "hair" },
      };
      cell.alignment = { vertical: "top" };
    });
    rowIndex += 1;
  }

  table.columns.forEach((column, index) => {
    let max = column.length;
    for (const rowValues of table.rows) {
      const text = String(rowValues[index] ?? "");
      if (text.length > max) max = Math.min(text.length, 48);
    }
    sheet.getColumn(index + 1).width = Math.min(Math.max(max + 2, 10), 50);
  });
  sheet.views = [{ state: "frozen", ySplit: headerRowIndex - 1 }];

  const buffer = await workbook.xlsx.writeBuffer();
  return Buffer.from(buffer as ArrayBuffer);
}

/** PDF: A4 portrait, logo and title block, table with headings on every page. */
export function reportPdf(table: ReportTable): Buffer {
  const doc = new jsPDF({ unit: "pt", format: "a4" });
  const pageWidth = doc.internal.pageSize.getWidth();
  const margin = 40;

  let y = margin;
  const logo = logoPath();
  let drewLogo = false;
  if (logo) {
    try {
      const data = fs.readFileSync(logo);
      doc.addImage(data, "PNG", margin, y, 44, 44);
      doc.setFont("helvetica", "bold");
      doc.setFontSize(13);
      doc.text(INSTITUTION_NAME, margin + 56, y + 20);
      doc.setFont("helvetica", "normal");
      doc.setFontSize(10);
      doc.text(table.title, margin + 56, y + 36);
      y += 56;
      drewLogo = true;
    } catch {
      drewLogo = false;
    }
  }
  if (!drewLogo) {
    doc.setFont("helvetica", "bold");
    doc.setFontSize(13);
    doc.text(INSTITUTION_NAME, margin, y);
    y += 16;
    doc.setFontSize(11);
    doc.text(table.title, margin, y);
    y += 14;
  }

  doc.setFont("helvetica", "normal");
  doc.setFontSize(9);
  for (const [key, value] of table.meta) {
    doc.text(`${key}: ${value}`, margin, y);
    y += 12;
  }
  doc.text(`Records: ${table.rows.length}`, margin, y);
  y += 8;
  doc.setDrawColor(200);
  doc.line(margin, y, pageWidth - margin, y);
  y += 10;

  autoTable(doc, {
    startY: y,
    head: [table.columns],
    body: table.rows.map((row) => row.map((cell) => String(cell ?? ""))),
    margin: { left: margin, right: margin },
    styles: { fontSize: 8, cellPadding: 3, overflow: "linebreak" },
    headStyles: { fillColor: [30, 41, 59], textColor: 255, fontStyle: "bold" },
    alternateRowStyles: { fillColor: [248, 250, 252] },
    didDrawPage: () => {
      const pageNumber = doc.getNumberOfPages();
      doc.setFontSize(8);
      doc.setTextColor(120);
      doc.text(
        `${INSTITUTION_NAME} · ${table.title} · page ${pageNumber}`,
        margin,
        doc.internal.pageSize.getHeight() - 20,
      );
      doc.setTextColor(0);
    },
  });

  return Buffer.from(doc.output("arraybuffer"));
}

/** One table, three formats: the same ReportTable in each. */
export async function renderReport(
  table: ReportTable,
  format: ReportFormat,
): Promise<{ body: Buffer | string; contentType: string }> {
  if (format === "csv") {
    return { body: reportCsv(table), contentType: CONTENT_TYPES.csv };
  }
  if (format === "xlsx") {
    return { body: await reportXlsx(table), contentType: CONTENT_TYPES.xlsx };
  }
  return { body: reportPdf(table), contentType: CONTENT_TYPES.pdf };
}

// Community Mass reports ---------------------------------------------------------

export type MassReportCategory = "present" | "absent" | "out_of_scope" | "unmatched" | "summary";

const CATEGORY_TITLES: Record<MassReportCategory, string> = {
  present: "Present",
  absent: "Absent",
  out_of_scope: "Out of Scope",
  unmatched: "Unmatched",
  summary: "Attendance Summary",
};

const WEEKDAY_NAMES: Record<number, string> = {
  1: "Monday",
  2: "Tuesday",
  3: "Wednesday",
  4: "Thursday",
  5: "Friday",
};

function weekdaysWord(weekdays: number[], scope: string): string {
  if (scope === "sunday") return "Sunday Mass (all departments)";
  return weekdays.map((day) => WEEKDAY_NAMES[day] ?? String(day)).join(", ") || "—";
}

function personWord(participantType: MassUploadParticipant, level: string | null): string {
  if (participantType === "staff") return "Staff";
  return level ? `Students — ${level} Level` : "Students — all levels";
}

/**
 * One Mass report, built from the saved calculation results for the chosen
 * week, participant type, level and category. The same table feeds all three
 * formats, so a CSV, an Excel file and a PDF of the same report are the same
 * report.
 */
export async function buildMassReport(
  weekId: string,
  participantType: MassUploadParticipant,
  level: string | null,
  category: MassReportCategory,
  format: ReportFormat,
): Promise<{ body: Buffer | string; contentType: string; filename: string }> {
  const result = await massResult(weekId, participantType, level);
  const { week } = result;
  const categoryWord = CATEGORY_TITLES[category];
  const participantLabel = participantType === "student" ? "Students" : "Staff";
  const title = `${week.name} — ${categoryWord} ${participantLabel} Report`;
  const studentColumns = participantType === "student";
  const numberColumn = studentColumns ? "Matric no" : "Staff no";

  const meta: Array<[string, string]> = [
    ["Scope", week.scope === "sunday" ? "Sunday Mass" : "Weekday Community Mass"],
    ["Participants", personWord(participantType, level)],
    ["Selected weekdays", weekdaysWord(week.weekdays, week.scope)],
    ["Generated", new Date().toISOString().slice(0, 16).replace("T", " ")],
    [
      "Totals",
      `Expected ${result.expected} · Present ${result.present} · Absent ${result.absent} · ` +
        `Out of scope ${result.out_of_scope} · Unmatched ${result.unmatched}` +
        (result.percent !== null ? ` · ${result.percent}% present` : ""),
    ],
  ];

  let table: ReportTable;
  if (category === "summary") {
    table = {
      title,
      meta,
      columns: ["Metric", "Count"],
      rows: [
        ["Expected participants", result.expected],
        ["Present", result.present],
        ["Absent", result.absent],
        ["Out of scope", result.out_of_scope],
        ["Unmatched", result.unmatched],
        ["Attendance percentage", result.percent === null ? "—" : `${result.percent}%`],
        [
          "Absence percentage",
          result.percent === null ? "—" : `${Math.round((100 - result.percent) * 10) / 10}%`,
        ],
        ["Uploads", result.uploads.length],
      ],
    };
  } else if (category === "present") {
    table = {
      title,
      meta,
      columns: [
        "S/N",
        numberColumn,
        "Name",
        "Department",
        ...(studentColumns ? ["Level"] : []),
        "Scans",
        "First scan",
        "Last scan",
      ],
      rows: result.presentList.map((row, index) => [
        index + 1,
        row.person_no ?? "",
        row.full_name ?? "",
        row.department ?? "",
        ...(studentColumns ? [row.level ?? ""] : []),
        row.scan_count,
        row.first_scan_at.replace("T", " ").slice(0, 16),
        row.last_scan_at.replace("T", " ").slice(0, 16),
      ]),
    };
  } else if (category === "absent") {
    table = {
      title,
      meta,
      columns: [
        "S/N",
        numberColumn,
        "Name",
        "Department",
        ...(studentColumns ? ["Level"] : []),
        "Assigned weekday",
      ],
      rows: result.absentList.map((row, index) => [
        index + 1,
        row.person_no ?? "",
        row.full_name ?? "",
        row.department ?? "",
        ...(studentColumns ? [row.level ?? ""] : []),
        row.day_of_week === null ? "" : weekdaysWord([row.day_of_week], "weekday"),
      ]),
    };
  } else if (category === "out_of_scope") {
    table = {
      title,
      meta,
      columns: [
        "S/N",
        numberColumn,
        "Name",
        "Department",
        ...(studentColumns ? ["Level"] : []),
        "Scans",
      ],
      rows: result.outOfScopeList.map((row, index) => [
        index + 1,
        row.person_no ?? "",
        row.full_name ?? "",
        row.department ?? "",
        ...(studentColumns ? [row.level ?? ""] : []),
        row.scan_count,
      ]),
    };
  } else {
    table = {
      title,
      meta,
      columns: [
        "S/N",
        "Number on the machine",
        "Name on the machine",
        "Scans",
        "First scan",
        "Last scan",
      ],
      rows: result.unmatchedList.map((row, index) => [
        index + 1,
        row.scan_number ?? "",
        row.scanned_name ?? "",
        row.scan_count,
        row.first_scan_at.replace("T", " ").slice(0, 16),
        row.last_scan_at.replace("T", " ").slice(0, 16),
      ]),
    };
  }

  const { body, contentType } = await renderReport(table, format);
  const levelPart = level ? `-${level}` : "";
  return {
    body,
    contentType,
    filename: `${slug(week.name)}-${category}-${participantType}${levelPart}.${format}`,
  };
}

// Event reports (xlsx/pdf) --------------------------------------------------------

function eventScopeWord(event: EventResult["event"]): string {
  const parts: string[] = [];
  const category = "category" in event ? event.category : null;
  const level = "level" in event ? event.level : null;
  const departments = "departments" in event ? event.departments : null;
  const legacyCode = "department_code" in event ? event.department_code : null;

  parts.push(category ?? "everyone");
  if (level) parts.push(`level ${level}`);

  const codes = departments?.length ? departments : legacyCode ? [legacyCode] : [];
  if (codes.length === 1) parts.push(`department ${codes[0]}`);
  else if (codes.length > 1) parts.push(`departments ${codes.join(" + ")}`);

  return parts.join(" + ");
}

/**
 * The same event totals and four lists the CSV export carries, as a branded
 * table for xlsx/pdf. The CSV path in reports.ts stays as it is, so the plain
 * download an office already relies on is byte-for-byte unchanged.
 */
export async function buildEventReport(
  result: EventResult,
  format: Exclude<ReportFormat, "csv">,
): Promise<{ body: Buffer; contentType: string; filename: string }> {
  const event = result.event;
  const isStudent = "level" in event || "category" in event;
  const numberColumn = isStudent ? "Matric no" : "Staff no";
  const title = `${event.title} — Attendance Report`;

  const meta: Array<[string, string]> = [
    ["Event date", event.event_date],
    ["Scope", eventScopeWord(event)],
    [
      "Totals",
      `Expected ${result.expected} · Present ${result.present} · Absent ${result.absent} · ` +
        `Out of scope ${result.outOfScope} · Unmatched ${result.unmatched}` +
        (result.percent !== null ? ` · ${result.percent}% present` : ""),
    ],
    ["Generated", new Date().toISOString().slice(0, 16).replace("T", " ")],
    ...(result.hasGrantedPresence
      ? [
          [
            "Note",
            "Present count includes people credited by a staff presence override, not by a scan.",
          ] as [string, string],
        ]
      : []),
  ];

  const table: ReportTable = {
    title,
    meta,
    columns: [
      "Status",
      "Name",
      numberColumn,
      "Level",
      "Department",
      "Scans",
      "First scan",
      "Last scan",
    ],
    rows: [
      ...result.presentList.map((row) => [
        "Present",
        row.name,
        row.code,
        row.level ?? "",
        row.department_code ?? "",
        row.scan_count,
        row.first_scan_at.replace("T", " ").slice(0, 16),
        row.last_scan_at.replace("T", " ").slice(0, 16),
      ]),
      ...result.outOfScopeList.map((row) => [
        "Out of scope",
        row.name,
        row.code,
        row.level ?? "",
        row.department_code ?? "",
        row.scan_count,
        "",
        "",
      ]),
      ...result.absentList.map((row) => [
        "Absent",
        row.name,
        row.code,
        row.level ?? "",
        row.department_code ?? "",
        "",
        "",
        "",
      ]),
      ...result.unmatchedList.map((row) => [
        "Unmatched",
        row.scanned_name ?? "",
        row.scan_number ?? "",
        "",
        "",
        row.scan_count,
        row.first_scan_at.replace("T", " ").slice(0, 16),
        row.last_scan_at.replace("T", " ").slice(0, 16),
      ]),
    ],
  };

  const filename = `${slug(event.title)}-attendance.${format}`;
  if (format === "pdf") {
    return { body: reportPdf(table), contentType: CONTENT_TYPES.pdf, filename };
  }
  const body = await reportXlsx(table);
  return { body, contentType: CONTENT_TYPES.xlsx, filename };
}
