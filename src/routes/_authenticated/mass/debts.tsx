import { createFileRoute, Link } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { AlertTriangle, Download, Search } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { DataRow, DataTable, EmptyState, Panel, StatTile } from "@/components/attendance-ui";
import { ReportFilterBar } from "@/components/ReportFilters";
import { api } from "@/lib/api";
import { EMPTY_FILTER, passesFilter, shownOf, type ReportFilterState } from "@/lib/report-filter";
import { useRoles } from "@/lib/useAuth";
import type { DebtView } from "@/lib/types";

export const Route = createFileRoute("/_authenticated/mass/debts")({
  component: MassDebtsPage,
});

const naira = (amount: number) => `₦${amount.toLocaleString("en-NG")}`;
const groupLabel = (group: "staff" | "student") => (group === "staff" ? "Staff" : "Student");
const PAGE = 200;

function monthLabel(month: string): string {
  const [year, number] = month.split("-");
  const date = new Date(Number(year), Number(number) - 1, 1);
  return Number.isNaN(date.getTime())
    ? month
    : date.toLocaleDateString("en-GB", { month: "long", year: "numeric" });
}

/**
 * What every absence from Weekly Mass costs: staff 10,000 naira, students
 * 5,000. Worked out from the weeks' results each time the page opens, so a
 * correction to any week -- a confirmed match, a merged duplicate, someone put
 * on the always-present list -- shows here straight away.
 */
function MassDebtsPage() {
  const [month, setMonth] = useState("");
  const [group, setGroup] = useState<"" | "staff" | "student">("");
  const [format, setFormat] = useState<"csv" | "xlsx" | "pdf">("xlsx");
  const [filter, setFilter] = useState<ReportFilterState>(EMPTY_FILTER);
  const [departmentText, setDepartmentText] = useState("");
  const [shown, setShown] = useState(PAGE);

  const report = useQuery({
    queryKey: ["debts", month, group],
    queryFn: () => api.debts.report({ month: month || null, group: group || null }),
  });

  const download = (view: DebtView, extra: { department?: string; q?: string } = {}) =>
    api.debts.downloadUrl({
      view,
      format,
      month: month || null,
      group: group || null,
      department: extra.department ?? null,
      q: extra.q ?? null,
    });

  const data = report.data;
  const people = (data?.people ?? []).filter((person) =>
    passesFilter(filter, {
      name: person.name,
      number: person.number,
      department: person.department,
    }),
  );
  const departments = (data?.byDepartment ?? []).filter((entry) => {
    const typed = departmentText.trim().toUpperCase();
    return !typed || entry.department.toUpperCase().includes(typed);
  });
  const provisional = (data?.byWeek ?? []).filter((week) => week.provisional);

  return (
    <div className="space-y-6">
      <Panel
        title="Mass debts"
        description="Every absence from a Weekly Mass that has an upload is charged: staff and students each at their rate. The figures are worked out from the weeks' results every time, so they follow every correction. Always-present staff are never charged."
      >
        <div className="flex flex-wrap items-end gap-3">
          <div className="space-y-1">
            <Label htmlFor="debt-month">Month</Label>
            <Select
              value={month || "all"}
              onValueChange={(value) => {
                setMonth(value === "all" ? "" : value);
                setShown(PAGE);
              }}
            >
              <SelectTrigger id="debt-month" className="w-48">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All months</SelectItem>
                {(data?.months ?? []).map((value) => (
                  <SelectItem key={value} value={value}>
                    {monthLabel(value)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1">
            <Label htmlFor="debt-group">Who</Label>
            <Select
              value={group || "all"}
              onValueChange={(value) => {
                setGroup(value === "staff" || value === "student" ? value : "");
                setFilter(EMPTY_FILTER);
                setShown(PAGE);
              }}
            >
              <SelectTrigger id="debt-group" className="w-44">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">Staff and students</SelectItem>
                <SelectItem value="staff">Staff</SelectItem>
                <SelectItem value="student">Students</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1">
            <Label htmlFor="debt-format">Download as</Label>
            <Select
              value={format}
              onValueChange={(value) =>
                setFormat(value === "csv" || value === "pdf" ? value : "xlsx")
              }
            >
              <SelectTrigger id="debt-format" className="w-28">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="xlsx">Excel</SelectItem>
                <SelectItem value="csv">CSV</SelectItem>
                <SelectItem value="pdf">PDF</SelectItem>
              </SelectContent>
            </Select>
          </div>
          {data ? <RatesEditor staff={data.rates.staff} student={data.rates.student} /> : null}
        </div>
      </Panel>

      {report.isError ? (
        <p role="alert" className="text-sm text-rose-600">
          {(report.error as Error).message}
        </p>
      ) : null}
      {!data ? (
        <p className="text-sm text-muted-foreground">Working out the debts…</p>
      ) : data.totals.weeks === 0 ? (
        <EmptyState title="No week counts yet">
          A Weekly Mass week counts once a machine file has been uploaded to it.
        </EmptyState>
      ) : (
        <>
          {provisional.length > 0 ? (
            <div className="flex items-start gap-2 rounded-lg border border-amber-300 bg-amber-50 p-4 text-sm text-amber-900">
              <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
              <p>
                {provisional.length} week(s) still have matches to confirm (
                {provisional.map((week, index) => (
                  <span key={`${week.weekId}-${week.group}`}>
                    {index > 0 ? ", " : ""}
                    <Link to="/mass/$weekId" params={{ weekId: week.weekId }} className="underline">
                      {week.weekName}
                    </Link>
                  </span>
                ))}
                ). Their debts can still go down once they are answered.
              </p>
            </div>
          ) : null}

          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            <StatTile label="Total owed" value={naira(data.totals.amount)} tone="bad" />
            <StatTile
              label="Staff owe"
              value={naira(data.totals.staffAmount)}
              hint={`${data.totals.staffPeople} staff · ${naira(data.rates.staff)} per absence`}
            />
            <StatTile
              label="Students owe"
              value={naira(data.totals.studentAmount)}
              hint={`${data.totals.studentPeople} students · ${naira(data.rates.student)} per absence`}
            />
            <StatTile
              label="Absences charged"
              value={data.totals.absences.toLocaleString()}
              hint={`${data.totals.weeks} week(s) counted`}
            />
          </div>

          <Tabs defaultValue="people">
            <TabsList>
              <TabsTrigger value="people">
                Each person ({shownOf(people.length, data.people.length)})
              </TabsTrigger>
              <TabsTrigger value="departments">By department / unit</TabsTrigger>
              <TabsTrigger value="weeks">By week ({data.byWeek.length})</TabsTrigger>
              <TabsTrigger value="months">By month ({data.byMonth.length})</TabsTrigger>
            </TabsList>

            <TabsContent value="people" className="mt-4 space-y-3">
              <ReportFilterBar
                state={filter}
                onChange={(next) => {
                  setFilter(next);
                  setShown(PAGE);
                }}
                rows={data.people.map((person) => ({ department: person.department }))}
                placeholder="Search by name, staff/matric number or department"
              />
              <div className="flex flex-wrap items-center justify-between gap-2">
                <p className="text-sm text-muted-foreground">
                  {people.length.toLocaleString()} owing ·{" "}
                  {naira(people.reduce((sum, person) => sum + person.amount, 0))}
                </p>
                <a
                  href={download("people", { department: filter.department, q: filter.text })}
                  download
                >
                  <Button variant="outline" size="sm">
                    <Download className="mr-1 h-4 w-4" /> Download this list
                  </Button>
                </a>
              </div>
              {people.length === 0 ? (
                <EmptyState title="Nobody here matches the search" />
              ) : (
                <>
                  <DataTable
                    head={[
                      "Name",
                      "Number",
                      "Group",
                      "Department / unit",
                      "Weeks missed",
                      "Absences",
                      "Owes",
                    ]}
                  >
                    {people.slice(0, shown).map((person) => (
                      <DataRow
                        key={`${person.group}|${person.personId}`}
                        cells={[
                          person.name ?? "—",
                          <span className="font-mono text-xs">{person.number ?? "—"}</span>,
                          groupLabel(person.group),
                          person.department ?? "—",
                          <span className="text-xs">{person.weeks.join(", ")}</span>,
                          <span className="tabular-nums">{person.absences}</span>,
                          <span className="font-medium tabular-nums">{naira(person.amount)}</span>,
                        ]}
                      />
                    ))}
                  </DataTable>
                  {people.length > shown ? (
                    <div className="flex justify-center">
                      <Button variant="outline" onClick={() => setShown((value) => value + PAGE)}>
                        Show more ({(people.length - shown).toLocaleString()} left)
                      </Button>
                    </div>
                  ) : null}
                </>
              )}
            </TabsContent>

            <TabsContent value="departments" className="mt-4 space-y-3">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="relative w-80">
                  <Search className="pointer-events-none absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
                  <Input
                    className="pl-8"
                    placeholder="Search departments / units"
                    value={departmentText}
                    onChange={(event) => setDepartmentText(event.target.value)}
                  />
                </div>
                <a href={download("departments")} download>
                  <Button variant="outline" size="sm">
                    <Download className="mr-1 h-4 w-4" /> Download
                  </Button>
                </a>
              </div>
              <DataTable head={["Group", "Department / unit", "People owing", "Absences", "Owes"]}>
                {departments.map((entry) => (
                  <DataRow
                    key={`${entry.group}|${entry.department}`}
                    cells={[
                      groupLabel(entry.group),
                      entry.department,
                      <span className="tabular-nums">{entry.people}</span>,
                      <span className="tabular-nums">{entry.absences}</span>,
                      <span className="font-medium tabular-nums">{naira(entry.amount)}</span>,
                    ]}
                  />
                ))}
              </DataTable>
            </TabsContent>

            <TabsContent value="weeks" className="mt-4 space-y-3">
              <div className="flex justify-end">
                <a href={download("weeks")} download>
                  <Button variant="outline" size="sm">
                    <Download className="mr-1 h-4 w-4" /> Download
                  </Button>
                </a>
              </div>
              <DataTable
                head={[
                  "Week",
                  "Date",
                  "Group",
                  "Expected",
                  "Present",
                  "Absent",
                  "Rate",
                  "Owed",
                  "Status",
                ]}
              >
                {data.byWeek.map((week) => (
                  <DataRow
                    key={`${week.weekId}|${week.group}`}
                    cells={[
                      <Link
                        to="/mass/$weekId"
                        params={{ weekId: week.weekId }}
                        className="underline underline-offset-4"
                      >
                        {week.weekName}
                      </Link>,
                      week.date,
                      week.levels
                        ? `${groupLabel(week.group)} · level ${week.levels.join(", ")}`
                        : groupLabel(week.group),
                      <span className="tabular-nums">{week.expected}</span>,
                      <span className="tabular-nums">{week.present}</span>,
                      <span className="tabular-nums">{week.absent}</span>,
                      naira(week.rate),
                      <span className="font-medium tabular-nums">{naira(week.amount)}</span>,
                      week.provisional ? (
                        <span className="text-amber-700">Matches to confirm</span>
                      ) : (
                        "Final"
                      ),
                    ]}
                  />
                ))}
              </DataTable>
            </TabsContent>

            <TabsContent value="months" className="mt-4 space-y-3">
              <div className="flex justify-end">
                <a href={download("months")} download>
                  <Button variant="outline" size="sm">
                    <Download className="mr-1 h-4 w-4" /> Download
                  </Button>
                </a>
              </div>
              <DataTable head={["Month", "Weeks", "Absences", "Staff", "Students", "Total"]}>
                {data.byMonth.map((entry) => (
                  <DataRow
                    key={entry.month}
                    cells={[
                      <button
                        type="button"
                        className="underline underline-offset-4"
                        onClick={() => setMonth(entry.month)}
                      >
                        {monthLabel(entry.month)}
                      </button>,
                      <span className="tabular-nums">{entry.weeks}</span>,
                      <span className="tabular-nums">{entry.absences.toLocaleString()}</span>,
                      naira(entry.staffAmount),
                      naira(entry.studentAmount),
                      <span className="font-medium tabular-nums">{naira(entry.amount)}</span>,
                    ]}
                  />
                ))}
              </DataTable>
            </TabsContent>
          </Tabs>
        </>
      )}
    </div>
  );
}

/** The two prices; an administrator can change them. */
function RatesEditor({ staff, student }: { staff: number; student: number }) {
  const { isAdmin } = useRoles();
  const queryClient = useQueryClient();
  const [editing, setEditing] = useState(false);
  const [staffRate, setStaffRate] = useState(String(staff));
  const [studentRate, setStudentRate] = useState(String(student));
  const save = useMutation({
    mutationFn: () =>
      api.debts.setRates({ staff: Number(staffRate), student: Number(studentRate) }),
    onSuccess: () => {
      toast.success("Rates saved. Every week is charged at the new rates.");
      setEditing(false);
      void queryClient.invalidateQueries({ queryKey: ["debts"] });
    },
    onError: (error) => toast.error((error as Error).message),
  });

  if (!editing) {
    return (
      <div className="ml-auto text-sm text-muted-foreground">
        Staff {naira(staff)} · Students {naira(student)} per absence{" "}
        {isAdmin ? (
          <Button variant="ghost" size="sm" onClick={() => setEditing(true)}>
            Change
          </Button>
        ) : null}
      </div>
    );
  }
  return (
    <div className="ml-auto flex items-end gap-2">
      <div className="space-y-1">
        <Label htmlFor="rate-staff">Staff (₦)</Label>
        <Input
          id="rate-staff"
          className="w-28"
          inputMode="numeric"
          value={staffRate}
          onChange={(event) => setStaffRate(event.target.value.replace(/\D/g, ""))}
        />
      </div>
      <div className="space-y-1">
        <Label htmlFor="rate-student">Students (₦)</Label>
        <Input
          id="rate-student"
          className="w-28"
          inputMode="numeric"
          value={studentRate}
          onChange={(event) => setStudentRate(event.target.value.replace(/\D/g, ""))}
        />
      </div>
      <Button disabled={save.isPending} onClick={() => save.mutate()}>
        Save
      </Button>
      <Button variant="ghost" onClick={() => setEditing(false)}>
        Cancel
      </Button>
    </div>
  );
}
