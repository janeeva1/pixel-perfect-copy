import { useRef, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { api } from "@/lib/api";
import { pick, readSpreadsheet } from "@/lib/spreadsheet";
import { EmptyState } from "@/components/attendance-ui";

const BATCH = 500;

type MappedRow = {
  matricNo?: string | null;
  staffNo?: string | null;
  lastName: string | null;
  firstName: string | null;
  middleName: string | null;
  faculty?: string | null;
  department?: string | null;
  adminDepartment?: string | null;
  level?: string | null;
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
 * the staff number, both of which are already here. Nothing derived is stored
 * either: the server works the undergraduate/postgraduate category and the
 * department out of the matric number when a report needs them.
 */
export function MasterImport({ group }: { group: "student" | "staff" }) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [file, setFile] = useState<File | null>(null);
  const [rows, setRows] = useState<MappedRow[]>([]);
  const [problem, setProblem] = useState<string | null>(null);
  const queryClient = useQueryClient();

  const student = group === "student";

  const upload = useMutation({
    mutationFn: async (): Promise<{ saved: number; skipped: number }> => {
      let saved = 0;
      let skipped = 0;
      for (let index = 0; index < rows.length; index += BATCH) {
        const batch = rows.slice(index, index + BATCH);
        const result = student
          ? await api.importStudents({ records: batch.filter(hasMatricNo) })
          : await api.importStaff({ records: batch });
        saved += result.saved;
        skipped += result.skipped;
      }
      await queryClient.invalidateQueries({ queryKey: [student ? "students" : "staff"] });
      return { saved, skipped };
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
              }
            : {
                staffNo: pick(row, "staff_no", "staffNo", "staff", "Staff No") || null,
                lastName: pick(row, "lname", "last_name", "surname") || null,
                firstName: pick(row, "fname", "first_name") || null,
                middleName: pick(row, "mname", "middle_name") || null,
                faculty: pick(row, "faculty", "fac") || null,
                department: pick(row, "department", "dept", "dept_name") || null,
                adminDepartment: pick(row, "admin_department", "admin_dept", "admindept") || null,
              },
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
                  {(student ? ["matric", "name", "level"] : ["staff no", "name", "department"]).map(
                    (label) => (
                      <th
                        key={label}
                        className="border-b border-border px-2 py-1 text-left font-medium"
                      >
                        {label}
                      </th>
                    ),
                  )}
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
                      <td className="px-2 py-1">{row.level}</td>
                    ) : (
                      <td className="px-2 py-1">{row.adminDepartment || row.department || "—"}</td>
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

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
            ? "Expected columns: id, lname, fname, mname, matric_no, level."
            : "Expected columns: id, lname, fname, mname, staff_no, faculty, department, admin_department."}
        </EmptyState>
      )}

      {upload.isError ? (
        <p className="text-sm text-rose-600">{(upload.error as Error).message}</p>
      ) : null}
      {upload.isSuccess ? (
        <p className="text-sm text-emerald-600">
          Imported {upload.data.saved.toLocaleString()} rows. The master list is now up to date.
        </p>
      ) : null}
    </div>
  );
}
