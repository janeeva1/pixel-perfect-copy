import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  DataRow,
  DataTable,
  EmptyState,
  Panel,
  StatTile,
  categoryLabel,
} from "@/components/attendance-ui";
import { MasterImport } from "@/components/MasterImport";
import { api, type StudentListParams } from "@/lib/api";
import { useRoles } from "@/lib/useAuth";
import type { StudentCategory } from "@/lib/types";
import { Download } from "lucide-react";

// Every key is optional, so a plain <Link to="/students"> does not have to
// carry filters. The validator fills sensible defaults when the URL is empty.
export type StudentsSearch = {
  search?: string;
  category?: StudentCategory | null;
  level?: string | null;
  departmentCode?: string | null;
  page?: number | undefined;
  pageSize?: number | undefined;
  sortBy?: string | undefined;
  sortDir?: "asc" | "desc" | undefined;
};

const VALID_SORT_COLUMNS = ["Name", "Matric no", "Category", "Level", "Department"];

export const Route = createFileRoute("/_authenticated/students")({
  validateSearch: (search: Record<string, unknown>): StudentsSearch => ({
    search: typeof search["search"] === "string" ? search["search"] : "",
    category:
      search["category"] === "undergraduate" || search["category"] === "postgraduate"
        ? (search["category"] as StudentCategory)
        : null,
    level: typeof search["level"] === "string" && search["level"] ? search["level"] : null,
    departmentCode:
      typeof search["departmentCode"] === "string" && search["departmentCode"]
        ? search["departmentCode"]
        : null,
    page: typeof search["page"] === "number" && search["page"] > 0 ? search["page"] : 1,
    pageSize:
      typeof search["pageSize"] === "number" && search["pageSize"] > 0 ? search["pageSize"] : 20,
    sortBy: VALID_SORT_COLUMNS.includes(String(search["sortBy"]))
      ? String(search["sortBy"])
      : undefined,
    sortDir:
      search["sortDir"] === "asc" || search["sortDir"] === "desc" ? search["sortDir"] : undefined,
  }),
  component: StudentsPage,
  errorComponent: ({ error }) => <p role="alert">{error.message}</p>,
});

function StudentsPage() {
  const search = Route.useSearch();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { canEdit } = useRoles();

  const term = search.search ?? "";
  const params: StudentListParams = {
    search: term,
    category: search.category ?? null,
    level: search.level ?? null,
    departmentCode: search.departmentCode ?? null,
    limit: search.pageSize ?? 20,
    page: search.page,
    pageSize: search.pageSize,
    sortBy: search.sortBy,
    sortDir: search.sortDir,
  };
  const list = useQuery({ queryKey: ["students", params], queryFn: () => api.students(params) });

  function setFilter(next: Partial<StudentsSearch>) {
    void navigate({ to: "/students", search: { ...search, ...next } });
  }

  const refresh = () => void queryClient.invalidateQueries({ queryKey: ["students"] });
  const departments = list.data?.departments ?? [];
  const students = list.data?.students ?? [];

  async function downloadStudents() {
    try {
      const blob = await api.studentsDownload({
        search: search.search ?? "",
        category: search.category ?? null,
        level: search.level ?? null,
        departmentCode: search.departmentCode ?? null,
      });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `students_${new Date().toISOString().slice(0, 10)}.csv`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    } catch (error) {
      console.error("Download failed:", error);
    }
  }

  return (
    <div className="mx-auto max-w-6xl space-y-6">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold">Students</h1>
          <p className="text-sm text-muted-foreground">
            The student master list. Events, attendance and reports all work from this list.
          </p>
        </div>
        {canEdit ? (
          <Button onClick={refresh} variant="outline">
            Refresh
          </Button>
        ) : null}
      </header>

      <div className="grid gap-4 sm:grid-cols-3">
        <StatTile label="Students" value={list.data?.total} />
        <StatTile
          label="Undergraduate"
          value={list.data?.undergraduate}
          hint="Matric numbers starting VUG"
        />
        <StatTile
          label="Postgraduate"
          value={list.data?.postgraduate}
          hint="Matric numbers starting VPG"
        />
      </div>

      {canEdit ? (
        <Panel
          title="Import the student list"
          description="Upload the registrar export once. Re-uploading a corrected file updates the same students instead of duplicating them."
        >
          <MasterImport group="student" />
        </Panel>
      ) : null}

      <Panel
        title="Master list"
        actions={
          <div className="flex flex-wrap items-center gap-2">
            <Button variant="outline" size="sm" onClick={downloadStudents}>
              <Download className="mr-2 h-4 w-4" />
              Download CSV
            </Button>
            <Input
              className="h-9 w-48"
              placeholder="Search name, matric or id"
              defaultValue={term}
              onChange={(event) => setFilter({ search: event.target.value })}
            />
            <Select
              value={search.category ?? "all"}
              onValueChange={(value) =>
                setFilter({ category: value === "all" ? null : (value as StudentCategory) })
              }
            >
              <SelectTrigger className="h-9 w-40">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All categories</SelectItem>
                <SelectItem value="undergraduate">Undergraduate</SelectItem>
                <SelectItem value="postgraduate">Postgraduate</SelectItem>
              </SelectContent>
            </Select>
            <Select
              value={search.level ?? "all"}
              onValueChange={(value) => setFilter({ level: value === "all" ? null : value })}
            >
              <SelectTrigger className="h-9 w-32">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All levels</SelectItem>
                {(list.data?.levels ?? []).map((level) => (
                  <SelectItem key={level} value={level}>
                    Level {level}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Select
              value={search.departmentCode ?? "all"}
              onValueChange={(value) =>
                setFilter({ departmentCode: value === "all" ? null : value })
              }
            >
              <SelectTrigger className="h-9 w-40">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All departments</SelectItem>
                {departments.map((code) => (
                  <SelectItem key={code} value={code}>
                    {code}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        }
      >
        {students.length === 0 ? (
          <EmptyState title="No students match">
            {list.isLoading
              ? "Loading the master list…"
              : "Change the filters, or import the student list."}
          </EmptyState>
        ) : (
          <>
            <DataTable
              head={["Name", "Matric no", "Category", "Level", "Department"]}
              sortable={["Name", "Matric no", "Category", "Level", "Department"]}
              sortBy={search.sortBy}
              sortDir={search.sortDir}
              onSort={(col) => {
                const nextDir = search.sortBy === col && search.sortDir === "asc" ? "desc" : "asc";
                setFilter({ sortBy: col, sortDir: nextDir, page: 1 });
              }}
              page={search.page}
              pageSize={search.pageSize}
              total={list.data?.total}
              onPageChange={(page) => setFilter({ page })}
              onPageSizeChange={(pageSize) => setFilter({ pageSize, page: 1 })}
            >
              {students.map((student) => (
                <DataRow
                  key={student.id}
                  cells={[
                    student.full_name,
                    <span className="font-mono text-xs">{student.matric_no}</span>,
                    categoryLabel(student.student_category),
                    student.level ? `Level ${student.level}` : "—",
                    student.department_code ?? "—",
                  ]}
                />
              ))}
            </DataTable>
          </>
        )}
      </Panel>
    </div>
  );
}
