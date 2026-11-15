import { useRef, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { api } from "@/lib/api";
import {
  buildImportTemplate,
  pick,
  readSpreadsheet,
  staffRecordFromRow,
  type ImportTemplate,
} from "@/lib/spreadsheet";
import { EmptyState } from "@/components/attendance-ui";
import { Download } from "lucide-react";

const BATCH = 500;
/** Staff go in one request (the server takes up to 2000), so "complete list" sees everyone. */
const STAFF_BATCH = 2000;

type MappedRow = {
  matricNo?: string | null;
  staffNo?: string | null;
  lastName: string | null;
  firstName: string | null;
  middleName: string | null;
  faculty?: string | null;
  department?: string | null;
  adminDepartment?: string | null;
  machineId?: string | null;
  staffIdOnMachine?: string | null;
  designation?: string | null;
  staffCategory?: string | null;
  level?: string | null;
  maritalStatus?: string | null;
};

/**
 * A student's row is only importable with a matric number, so the type guard is
 * what lets the upload send `MappedRow[]` to either endpoint without a cast.
 */
function hasMatricNo(row: MappedRow): row is MappedRow & { matricNo: string } {
  return Boolean(row.matricNo);
}

/**
 * Master list importer. The columns are matched by name, so a file with
 * `matric_no` or `matricNo`, `lname` or `last_name` all work.
 *
 * The file's `id` column is deliberately not read. It is the machine's own
 * numbering, not a field the app needs: for a student the number the machine
 * prints is the tail of the matric number, and for staff it is the digits of
 * the staff number, both of which are already here. The undergraduate/postgraduate
 * category and the department code are worked out of the matric number by the
 * server; the department's full name and the marital status are stored exactly
 * as the file spells them, for display and for the Sunday Mass rule.
 */
export function MasterImport({ group }: { group: "student" | "staff" }) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [file, setFile] = useState<File | null>(null);
  const [rows, setRows] = useState<MappedRow[]>([]);
  const [problem, setProblem] = useState<string | null>(null);
  // The registrar's staffdb.xlsx is the complete, current list of staff.
  const [completeList, setCompleteList] = useState(true);
  const queryClient = useQueryClient();

  const student = group === "student";

  /**
   * The template is the registrar's own export, so a file that came from the
   * portal can be uploaded as it stands. It is offered here as well as on the
   * Import page, because this is where somebody is about to choose a file.
   */
  function downloadTemplate() {
    const type: ImportTemplate = student ? "students" : "staff";
    const blob = new Blob([buildImportTemplate(type)], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${type}_import_template.csv`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }

  const upload = useMutation({
    mutationFn: async (): Promise<{
      saved: number;
      skipped: number;
      merged: number;
      notCurrent: number;
    }> => {
      let saved = 0;
      let skipped = 0;
      let merged = 0;
      let notCurrent = 0;
      const size = student ? BATCH : STAFF_BATCH;
      // "Complete list" only means something when the server sees every row at once.
      const whole = !student && completeList && rows.length <= STAFF_BATCH;
      for (let index = 0; index < rows.length; index += size) {
        const batch = rows.slice(index, index + size);
        const result = student
          ? await api.importStudents({ records: batch.filter(hasMatricNo) })
          : await api.importStaff({ records: batch, completeList: whole });
        saved += result.saved;
        skipped += result.skipped;
        merged += result.duplicatesMerged ?? 0;
        notCurrent += result.notOnCurrentList ?? 0;
      }
      await queryClient.invalidateQueries();
      return { saved, skipped, merged, notCurrent };
    },
  });

  async function onFile(file: File | null) {
    if (!file) return;
    setProblem(null);
    upload.reset();
    try {
      const { rows: sheet } = await readSpreadsheet(file);
      const mapped = sheet
        .map((row): MappedRow =>
          student
            ? {
                matricNo: pick(row, "matric_no", "matricNo", "matric", "Matric") || null,
                lastName: pick(row, "lname", "last_name", "surname") || null,
                firstName: pick(row, "fname", "first_name") || null,
                middleName: pick(row, "mname", "middle_name") || null,
                level: pick(row, "level", "Level") || null,
                department: pick(row, "department", "dept", "dept_name") || null,
                maritalStatus: pick(row, "marital_status", "maritalStatus", "marital") || null,
              }
            : staffRecordFromRow(row),
        )
        // Staff rows are not filtered: the two staff whose file has no staff
        // number are matched on their name instead, so they still belong here.
        .filter((row) => (student ? Boolean(row.matricNo) : true));

      if (mapped.length === 0) {
        setProblem(
          student
            ? "No rows with a matric number were found. Check the column headings."
            : "No rows were found in that file.",
        );
        return;
      }
      setFile(file);
      setRows(mapped);
    } catch {
      setProblem("That file could not be read. Use a CSV or Excel export.");
    }
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-3">
        <input
          ref={inputRef}
          type="file"
          accept=".csv,.xlsx,.xls"
          className="hidden"
          onChange={(event) => onFile(event.target.files?.[0] ?? null)}
        />
        <Button variant="outline" onClick={() => inputRef.current?.click()}>
          Choose file
        </Button>
        <Button variant="ghost" onClick={downloadTemplate}>
          <Download className="mr-2 h-4 w-4" />
          Download template
        </Button>
        {file ? <span className="text-sm text-muted-foreground">{file.name}</span> : null}
      </div>

      {problem ? <p className="text-sm text-rose-600">{problem}</p> : null}

      {rows.length > 0 ? (
        <>
          <p className="text-sm">
            {rows.length.toLocaleString()} rows ready to import
            {student ? ", undergraduate and postgraduate worked out from the matric number" : ""}.
          </p>
          <div className="max-h-40 overflow-auto rounded-md border border-border text-xs">
            <table className="w-full">
              <thead className="bg-card">
                <tr>
                  {(student
                    ? ["matric", "name", "level", "department"]
                    : ["staff no", "name", "department"]
                  ).map((label) => (
                    <th
                      key={label}
                      className="border-b border-border px-2 py-1 text-left font-medium"
                    >
                      {label}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {rows.slice(0, 8).map((row, index) => (
                  <tr key={index} className="border-b border-border/60 last:border-0">
                    <td className="px-2 py-1">{student ? row.matricNo : row.staffNo}</td>
                    <td className="px-2 py-1">
                      {[row.lastName, row.firstName, row.middleName].filter(Boolean).join(" ")}
                    </td>
                    {student ? (
                      <>
                        <td className="px-2 py-1">{row.level}</td>
                        <td className="px-2 py-1">{row.department || "—"}</td>
                      </>
                    ) : (
                      <td className="px-2 py-1">{row.adminDepartment || row.department || "—"}</td>
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {student ? null : (
            <label className="flex items-start gap-2 text-sm">
              <input
                type="checkbox"
                className="mt-1"
                checked={completeList}
                onChange={(event) => setCompleteList(event.target.checked)}
              />
              <span>
                <span className="font-medium">
                  This file is the complete, current staff list (e.g. staffdb.xlsx)
                </span>
                <span className="block text-muted-foreground">
                  Staff not in this file stop being expected at Mass and events. They are kept on
                  record (a scan of theirs still matches) and come back if a later file includes
                  them.
                </span>
              </span>
            </label>
          )}

          <Button
            disabled={upload.isPending}
            onClick={() => {
              upload.mutate(undefined, {
                onSuccess: () => {
                  setRows([]);
                  setFile(null);
                  if (inputRef.current) inputRef.current.value = "";
                },
              });
            }}
          >
            {upload.isPending
              ? "Importing…"
              : `Import ${rows.length.toLocaleString()} ${student ? "students" : "staff"}`}
          </Button>
        </>
      ) : (
        <EmptyState title="No file chosen yet">
          {student
            ? "Expected columns: student_id, fname, lname, mname, marital_status, matric_no, department, level. Only the matric number is required."
            : "Expected columns: fname, mname, lname, marital_status, staff_no, admin_department, department, department_category, faculty. Only the staff number is required."}
        </EmptyState>
      )}

      {upload.isError ? (
        <p className="text-sm text-rose-600">{(upload.error as Error).message}</p>
      ) : null}
      {upload.isSuccess ? (
        <p className="text-sm text-emerald-600">
          Imported {upload.data.saved.toLocaleString()} rows. The master list is now up to date.
          {upload.data.merged > 0
            ? ` ${upload.data.merged.toLocaleString()} duplicate record(s) of the same person were merged.`
            : ""}
          {upload.data.notCurrent > 0
            ? ` ${upload.data.notCurrent.toLocaleString()} staff not in this file are no longer expected.`
            : ""}
        </p>
      ) : null}
    </div>
  );
}
