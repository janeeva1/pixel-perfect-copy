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
import { DataRow, DataTable, EmptyState, Panel, StatTile } from "@/components/attendance-ui";
import { MasterImport } from "@/components/MasterImport";
import { MasterEditDialog, type EditField } from "@/components/MasterEditDialog";
import { api, type StaffListParams } from "@/lib/api";
import { useRoles } from "@/lib/useAuth";
import type { Staff } from "@/lib/types";
import { Download, Pencil } from "lucide-react";
import { toast } from "sonner";

export type StaffSearch = {
  search?: string;
  page?: number | undefined;
  pageSize?: number | undefined;
  sortBy?: string | undefined;
  sortDir?: "asc" | "desc" | undefined;
};

const VALID_STAFF_SORT = ["Name", "Staff no", "Faculty", "Department", "Admin dept."];

export const Route = createFileRoute("/_authenticated/staff")({
  validateSearch: (search: Record<string, unknown>): StaffSearch => ({
    search: typeof search["search"] === "string" ? search["search"] : "",
    page: typeof search["page"] === "number" && search["page"] > 0 ? search["page"] : 1,
    pageSize:
      typeof search["pageSize"] === "number" && search["pageSize"] > 0 ? search["pageSize"] : 20,
    sortBy: VALID_STAFF_SORT.includes(String(search["sortBy"]))
      ? String(search["sortBy"])
      : undefined,
    sortDir:
      search["sortDir"] === "asc" || search["sortDir"] === "desc" ? search["sortDir"] : undefined,
  }),
  component: StaffPage,
  errorComponent: ({ error }) => <p role="alert">{error.message}</p>,
});

function StaffPage() {
  const search = Route.useSearch();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { canEdit } = useRoles();

  const term = search.search ?? "";
  const params: StaffListParams = {
    search: term,
    limit: search.pageSize ?? 20,
    page: search.page,
    pageSize: search.pageSize,
    sortBy: search.sortBy,
    sortDir: search.sortDir,
  };
  const list = useQuery({ queryKey: ["staff", params], queryFn: () => api.staff(params) });
  const staffDepartments = useQuery({
    queryKey: ["staff-departments"],
    queryFn: () => api.staffDepartments(),
  });
  const massDepartments = useQuery({
    queryKey: ["mass-departments"],
    queryFn: () => api.massDepartments(),
  });

  const [editing, setEditing] = useState<Staff | null>(null);

  function setFilter(next: Partial<StaffSearch>) {
    void navigate({ to: "/staff", search: { ...search, ...next } });
  }

  async function downloadStaff() {
    try {
      const blob = await api.staffDownload({ search: search.search ?? "" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `staff_${new Date().toISOString().slice(0, 10)}.csv`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    } catch (error) {
      console.error("Download failed:", error);
    }
  }

  const staff = list.data?.staff ?? [];

  // The dropdown offers the departments that have a Community Mass weekday, so
  // a member of staff moved to one of them is still expected. The departments
  // already in use are added on top, in case a name is not in the weekday table.
  const departmentOptions = [
    ...new Set([
      ...(massDepartments.data ?? []).map((row) => row.department),
      ...(staffDepartments.data?.departments ?? []).map((row) => row.department),
    ]),
  ].sort((a, b) => a.localeCompare(b));

  const editFields: EditField[] = editing
    ? [
        { key: "lastName", label: "Last name", kind: "text", value: editing.last_name },
        { key: "firstName", label: "First name", kind: "text", value: editing.first_name },
        { key: "middleName", label: "Middle name", kind: "text", value: editing.middle_name },
        { key: "faculty", label: "Faculty", kind: "text", value: editing.faculty },
        {
          key: "department",
          label: "Department",
          kind: "select",
          value: editing.department,
          options: departmentOptions,
          emptyLabel: "No department",
        },
        {
          key: "adminDepartment",
          label: "Admin department",
          kind: "select",
          value: editing.admin_department,
          options: departmentOptions,
          emptyLabel: "No admin department",
        },
      ]
    : [];

  async function saveStaff(values: Record<string, string | null>) {
    if (!editing) return;
    const result = await api.updateStaff(editing.id, {
      lastName: values["lastName"] ?? null,
      firstName: values["firstName"] ?? null,
      middleName: values["middleName"] ?? null,
      faculty: values["faculty"] ?? null,
      department: values["department"] ?? null,
      adminDepartment: values["adminDepartment"] ?? null,
    });
    await queryClient.invalidateQueries({ queryKey: ["staff"] });
    await queryClient.invalidateQueries({ queryKey: ["staff-departments"] });
    if (result.staleWeeks.length > 0) {
      toast.warning(
        `${editing.full_name || "The member of staff"} was updated. ${result.staleWeeks.join(", ")} already hold attendance, so their expected list was left as it was. Reset the week to apply the new department to it.`,
      );
    } else {
      toast.success(`${editing.full_name || "The member of staff"} was updated.`);
    }
  }

  return (
    <div className="mx-auto max-w-6xl space-y-6">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold">Staff</h1>
          <p className="text-sm text-muted-foreground">
            The staff master list, kept separate from students. The source file has no department,
            so a staff event covers everyone.
          </p>
        </div>
        {canEdit ? (
          <Button
            variant="outline"
            onClick={() => void queryClient.invalidateQueries({ queryKey: ["staff"] })}
          >
            Refresh
          </Button>
        ) : null}
      </header>

      <div className="grid gap-4 sm:grid-cols-2">
        <StatTile label="Staff" value={list.data?.total} />
        <StatTile
          label="With staff number"
          value={list.data?.withStaffNo}
          hint="Used to match machine scans"
        />
      </div>

      {canEdit ? (
        <Panel
          title="Import the staff list"
          description="Machine scans are matched on the digits inside the staff number, whatever letters or spacing the file uses."
        >
          <MasterImport group="staff" />
        </Panel>
      ) : null}

      <Panel
        title="Master list"
        actions={
          <div className="flex flex-wrap items-center gap-2">
            <Button variant="outline" size="sm" onClick={downloadStaff}>
              <Download className="mr-2 h-4 w-4" />
              Download CSV
            </Button>
            <Input
              className="h-9 w-48"
              placeholder="Search name or staff no"
              defaultValue={term}
              onChange={(event) => setFilter({ search: event.target.value })}
            />
          </div>
        }
      >
        {staff.length === 0 ? (
          <EmptyState title="No staff match">
            {list.isLoading
              ? "Loading the master list…"
              : "Change the search, or import the staff list."}
          </EmptyState>
        ) : (
          <>
            <DataTable
              head={["Name", "Staff no", "Faculty", "Department", "Admin dept.", ""]}
              sortable={["Name", "Staff no", "Faculty", "Department", "Admin dept."]}
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
              {staff.map((person) => (
                <DataRow
                  key={person.id}
                  cells={[
                    person.full_name,
                    <span className="font-mono text-xs">{person.staff_no ?? "—"}</span>,
                    person.faculty ?? "—",
                    person.department ?? "—",
                    person.admin_department ?? "—",
                    canEdit ? (
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => setEditing(person)}
                        aria-label={`Edit ${person.full_name}`}
                      >
                        <Pencil className="h-4 w-4" />
                      </Button>
                    ) : null,
                  ]}
                />
              ))}
            </DataTable>
          </>
        )}
      </Panel>

      <MasterEditDialog
        key={editing?.id ?? "none"}
        open={editing !== null}
        onOpenChange={(open) => {
          if (!open) setEditing(null);
        }}
        title="Edit member of staff"
        description="Change what the file should have said. The staff number is the person's key and cannot be edited here."
        identity={
          editing
            ? `${editing.full_name}${editing.staff_no ? ` — ${editing.staff_no}` : " — no staff number"}`
            : undefined
        }
        fields={editFields}
        onSave={saveStaff}
      />
    </div>
  );
}
