import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
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
import { api, type StaffListParams } from "@/lib/api";
import { useRoles } from "@/lib/useAuth";
import { Download } from "lucide-react";

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
              head={["Name", "Staff no", "Faculty", "Department", "Admin dept."]}
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
