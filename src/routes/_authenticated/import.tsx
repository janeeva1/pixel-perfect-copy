import { createFileRoute, redirect } from "@tanstack/react-router";
import { useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Separator } from "@/components/ui/separator";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  FileText,
  Users,
  Upload,
  Download,
  GraduationCap,
  Loader2,
  CheckCircle2,
} from "lucide-react";
import { api } from "@/lib/api";
import { useRoles } from "@/lib/useAuth";
import { useMutationWithToast } from "@/lib/mutations";
import {
  buildImportTemplate,
  pick,
  readSpreadsheet,
  staffRecordFromRow,
  type ImportTemplate,
} from "@/lib/spreadsheet";

export const Route = createFileRoute("/_authenticated/import")({
  beforeLoad: ({ context }) => {
    const roles = context.me.roles;
    if (!roles.includes("admin") && !roles.includes("operator")) {
      throw redirect({ to: "/dashboard" });
    }
  },
  component: ImportPage,
});

function ImportPage() {
  const queryClient = useQueryClient();
  const { canEdit } = useRoles();
  const [activeTab, setActiveTab] = useState<"students" | "staff">("students");
  const [file, setFile] = useState<File | null>(null);
  const [label, setLabel] = useState("");
  const [preview, setPreview] = useState<Array<Record<string, string>> | null>(null);

  const studentImport = useMutationWithToast(
    async (file: File) => {
      const { rows } = await readSpreadsheet(file);
      const rowsData = rows
        .map((row) => ({
          matricNo: pick(row, "matric_no", "matricno", "matric"),
          lastName: pick(row, "lname", "lastname", "last_name", "surname"),
          firstName: pick(row, "fname", "firstname", "first_name", "givenname"),
          middleName: pick(row, "mname", "middlename", "middle_name", "midname"),
          level: pick(row, "level", "lvl", "year"),
          department: pick(row, "department", "dept", "dept_name"),
          maritalStatus: pick(row, "marital_status", "maritalstatus", "marital"),
        }))
        .filter((r) => r.matricNo);
      return api.importStudents({ records: rowsData });
    },
    {
      successMessage: "Students imported successfully",
      errorMessage: "Import failed",
      mutationOptions: {
        onSuccess: () => {
          queryClient.invalidateQueries({ queryKey: ["students"] });
          queryClient.invalidateQueries({ queryKey: ["dashboard"] });
          setFile(null);
          setLabel("");
          setPreview(null);
        },
      },
    },
  );

  const staffImport = useMutationWithToast(
    async (file: File) => {
      const { rows } = await readSpreadsheet(file);
      const rowsData = rows
        .map(staffRecordFromRow)
        .filter((r) => r.staffNo || (r.lastName && r.firstName));
      return api.importStaff({ records: rowsData });
    },
    {
      successMessage: "Staff imported successfully",
      errorMessage: "Import failed",
      mutationOptions: {
        onSuccess: () => {
          queryClient.invalidateQueries({ queryKey: ["staff"] });
          queryClient.invalidateQueries({ queryKey: ["dashboard"] });
          setFile(null);
          setLabel("");
          setPreview(null);
        },
      },
    },
  );

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0];
    if (f) {
      setFile(f);
      readSpreadsheet(f).then(({ rows }) => {
        setPreview(
          rows.slice(0, 5).map((row) => {
            const obj: Record<string, string> = {};
            for (const [k, v] of Object.entries(row)) {
              obj[k] = v || "";
            }
            return obj;
          }),
        );
      });
    }
  };

  const downloadTemplate = (type: ImportTemplate) => {
    const blob = new Blob([buildImportTemplate(type)], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${type}_import_template.csv`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const studentFileRef = useRef<HTMLInputElement>(null);
  const staffFileRef = useRef<HTMLInputElement>(null);

  return (
    <div className="mx-auto max-w-4xl space-y-6">
      <header>
        <h1 className="text-2xl font-semibold">Import Master Data</h1>
        <p className="text-sm text-muted-foreground">
          Upload CSV or Excel files to import students or staff. Download templates for the correct
          format.
        </p>
      </header>

      <Tabs
        value={activeTab}
        onValueChange={(v) => setActiveTab(v as "students" | "staff")}
        className="w-full"
      >
        <TabsList className="grid w-full grid-cols-2">
          <TabsTrigger value="students">
            <GraduationCap className="mr-2 h-4 w-4" />
            Students
          </TabsTrigger>
          <TabsTrigger value="staff">
            <Users className="mr-2 h-4 w-4" />
            Staff
          </TabsTrigger>
        </TabsList>

        <TabsContent value="students" className="mt-4">
          <div className="grid gap-6">
            <Card>
              <CardHeader>
                <CardTitle>Download Template</CardTitle>
                <CardDescription>
                  Download the CSV template with correct column headers
                </CardDescription>
              </CardHeader>
              <CardContent className="flex items-center gap-4">
                <Button variant="outline" onClick={() => downloadTemplate("students")}>
                  <Download className="mr-2 h-4 w-4" />
                  Download Student Template
                </Button>
                <span className="text-sm text-muted-foreground">
                  Columns: student_id, fname, lname, mname, marital_status, matric_no, department,
                  level
                </span>
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle>Upload File</CardTitle>
                <CardDescription>Upload CSV or Excel file with student data</CardDescription>
              </CardHeader>
              <CardContent className="space-y-4">
                <div className="space-y-2">
                  <Label htmlFor="student-file">Select File</Label>
                  <input
                    id="student-file"
                    type="file"
                    accept=".csv,.xlsx,.xls"
                    className="hidden"
                    ref={studentFileRef}
                    onChange={(e) => {
                      const f = e.target.files?.[0];
                      if (f) {
                        setFile(f);
                        readSpreadsheet(f).then(({ rows }) => {
                          const preview = rows.slice(0, 5).map((r) => {
                            const obj: Record<string, string> = {};
                            for (const [k, v] of Object.entries(r)) {
                              obj[k] = v || "";
                            }
                            return obj;
                          });
                          setPreview(preview);
                        });
                      }
                    }}
                  />
                  <Button
                    variant="outline"
                    onClick={() => studentFileRef.current?.click()}
                    disabled={studentImport.isPending}
                  >
                    <Upload className="mr-2 h-4 w-4" />
                    {studentImport.isPending ? "Uploading..." : "Choose File"}
                  </Button>
                </div>
                <Input
                  placeholder="Label (e.g., 2026 Semester 1)"
                  value={label}
                  onChange={(e) => setLabel(e.target.value)}
                  disabled={studentImport.isPending}
                />
                <Button
                  onClick={() => file && studentImport.mutate(file)}
                  disabled={!file || studentImport.isPending}
                  className="w-full"
                >
                  {studentImport.isPending ? (
                    <>
                      <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                      Importing...
                    </>
                  ) : (
                    <>
                      <CheckCircle2 className="mr-2 h-4 w-4" />
                      Import Students
                    </>
                  )}
                </Button>
              </CardContent>
            </Card>

            {preview && (
              <Card>
                <CardHeader>
                  <CardTitle>Preview (first 5 rows)</CardTitle>
                </CardHeader>
                <CardContent>
                  <div className="overflow-x-auto">
                    <table className="w-full text-sm">
                      <thead>
                        <tr className="border-b border-border">
                          {preview[0] &&
                            Object.keys(preview[0]).map((key) => (
                              <th key={key} className="text-left p-2 font-medium">
                                {key}
                              </th>
                            ))}
                        </tr>
                      </thead>
                      <tbody>
                        {preview.map((row, i) => (
                          <tr key={i} className="border-b border-border/50">
                            {Object.values(row).map((val, j) => (
                              <td key={j} className="p-2 text-slate-600">
                                {val || "—"}
                              </td>
                            ))}
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </CardContent>
              </Card>
            )}
          </div>
        </TabsContent>

        <TabsContent value="staff" className="mt-4">
          <div className="grid gap-6">
            <Card>
              <CardHeader>
                <CardTitle>Download Template</CardTitle>
                <CardDescription>
                  Download the CSV template with correct column headers
                </CardDescription>
              </CardHeader>
              <CardContent className="flex items-center gap-4">
                <Button variant="outline" onClick={() => downloadTemplate("staff")}>
                  <Download className="mr-2 h-4 w-4" />
                  Download Staff Template
                </Button>
                <span className="text-sm text-muted-foreground">
                  Columns: fname, mname, lname, marital_status, staff_no, admin_department,
                  department, department_category, faculty. Only staff_no is required.
                </span>
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle>Upload File</CardTitle>
                <CardDescription>Upload CSV or Excel file with staff data</CardDescription>
              </CardHeader>
              <CardContent className="space-y-4">
                <div className="space-y-2">
                  <Label htmlFor="staff-file">Select File</Label>
                  <input
                    id="staff-file"
                    type="file"
                    accept=".csv,.xlsx,.xls"
                    className="hidden"
                    ref={staffFileRef}
                    onChange={(e) => {
                      const f = e.target.files?.[0];
                      if (f) {
                        setFile(f);
                        readSpreadsheet(f).then(({ rows }) => {
                          const preview = rows.slice(0, 5).map((r) => {
                            const obj: Record<string, string> = {};
                            for (const [k, v] of Object.entries(r)) {
                              obj[k] = v || "";
                            }
                            return obj;
                          });
                          setPreview(preview);
                        });
                      }
                    }}
                  />
                  <Button
                    variant="outline"
                    onClick={() => staffFileRef.current?.click()}
                    disabled={staffImport.isPending}
                  >
                    <Upload className="mr-2 h-4 w-4" />
                    {staffImport.isPending ? "Uploading..." : "Choose File"}
                  </Button>
                </div>
                <Input
                  placeholder="Label (e.g., 2026 Semester 1)"
                  value={label}
                  onChange={(e) => setLabel(e.target.value)}
                  disabled={staffImport.isPending}
                />
                <Button
                  onClick={() => file && staffImport.mutate(file)}
                  disabled={!file || staffImport.isPending}
                  className="w-full"
                >
                  {staffImport.isPending ? (
                    <>
                      <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                      Importing...
                    </>
                  ) : (
                    <>
                      <CheckCircle2 className="mr-2 h-4 w-4" />
                      Import Staff
                    </>
                  )}
                </Button>
              </CardContent>
            </Card>

            {preview && (
              <Card>
                <CardHeader>
                  <CardTitle>Preview (first 5 rows)</CardTitle>
                </CardHeader>
                <CardContent>
                  <div className="overflow-x-auto">
                    <table className="w-full text-sm">
                      <thead>
                        <tr className="border-b border-border">
                          {preview[0] &&
                            Object.keys(preview[0]).map((key) => (
                              <th key={key} className="text-left p-2 font-medium">
                                {key}
                              </th>
                            ))}
                        </tr>
                      </thead>
                      <tbody>
                        {preview.map((row, i) => (
                          <tr key={i} className="border-b border-border/50">
                            {Object.values(row).map((val, j) => (
                              <td key={j} className="p-2 text-slate-600">
                                {val || "—"}
                              </td>
                            ))}
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </CardContent>
              </Card>
            )}
          </div>
        </TabsContent>
      </Tabs>
    </div>
  );
}
