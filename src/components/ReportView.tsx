import type { ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  Legend,
  Line,
  LineChart,
  Pie,
  PieChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
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
  PercentBar,
  StatTile,
} from "@/components/attendance-ui";
import { api, type StaffReportParams, type StudentReportParams } from "@/lib/api";
import type { GroupKind, ReportGroupBy, ReportPeriod } from "@/lib/types";

const PIE_COLOURS = ["#0d9488", "#6366f1", "#f59e0b", "#ec4899", "#22c55e", "#64748b", "#ef4444"];

// Every key is optional so a plain link to the report page needs no params.
export type ReportSearch = {
  period?: ReportPeriod;
  from?: string;
  to?: string;
  groupBy?: ReportGroupBy;
  category?: "undergraduate" | "postgraduate" | null;
  level?: string | null;
  departmentCode?: string | null;
  /** Staff reports filter on a department name, not a student code. */
  department?: string | null;
};

/** "day" / "week" / "month", for headings like "By day". */
function periodNoun(period: ReportPeriod): string {
  return period === "daily" ? "day" : period === "weekly" ? "week" : "month";
}

function firstOfMonth() {
  const now = new Date();
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)).toISOString().slice(0, 10);
}
function today() {
  return new Date().toISOString().slice(0, 10);
}

function shiftMonth(from: string, months: number) {
  const date = new Date(`${from}T00:00:00Z`);
  date.setUTCMonth(date.getUTCMonth() + months);
  return date.toISOString().slice(0, 10);
}

function shiftDay(from: string, days: number) {
  const date = new Date(`${from}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

function applyPeriod(from: string, to: string, period: ReportPeriod) {
  if (period === "monthly") {
    const start = from.slice(0, 8) + "01";
    const next = new Date(`${start}T00:00:00Z`);
    next.setUTCMonth(next.getUTCMonth() + 1);
    return { from: start, to: new Date(next.getTime() - 86_400_000).toISOString().slice(0, 10) };
  }
  if (period === "weekly") {
    const date = new Date(`${from}T00:00:00Z`);
    const weekday = (date.getUTCDay() + 6) % 7;
    date.setUTCDate(date.getUTCDate() - weekday);
    return {
      from: date.toISOString().slice(0, 10),
      to: shiftDay(date.toISOString().slice(0, 10), 6),
    };
  }
  return { from, to: from };
}

function periodOptions(period: ReportPeriod, from: string, to: string) {
  if (period === "monthly") {
    return [
      { label: "This month", value: `${firstOfMonth()}|${shiftMonth(firstOfMonth(), 1)}` },
      {
        label: "Last month",
        value: `${shiftMonth(firstOfMonth(), -1)}|${shiftMonth(firstOfMonth(), 0)}`,
      },
    ];
  }
  if (period === "weekly") {
    const thisWeek = applyPeriod(today(), today(), "weekly");
    const lastWeekStart = shiftDay(thisWeek.from, -7);
    return [
      { label: "This week", value: `${thisWeek.from}|${thisWeek.to}` },
      { label: "Last week", value: `${lastWeekStart}|${shiftDay(lastWeekStart, 6)}` },
    ];
  }
  return [
    { label: "Today", value: `${today()}|${today()}` },
    { label: "Last 7 days", value: `${shiftDay(today(), -6)}|${today()}` },
    { label: "Last 30 days", value: `${shiftDay(today(), -29)}|${today()}` },
  ];
}

/**
 * The report view is the same for both groups apart from which filters make
 * sense: students add category and level, staff have neither. Expected always
 * comes from the current master list, so the numbers move when the list is
 * corrected.
 */
export function ReportView({
  group,
  search: raw,
  onChange,
}: {
  group: GroupKind;
  search: ReportSearch;
  onChange: (next: Partial<ReportSearch>) => void;
}) {
  // The URL may carry nothing, so normalise once and use this everywhere below.
  const search = {
    period: raw.period ?? ("daily" as ReportPeriod),
    from: raw.from ?? firstOfMonth(),
    to: raw.to ?? today(),
    groupBy: raw.groupBy ?? ("none" as ReportGroupBy),
    category: raw.category ?? null,
    level: raw.level ?? null,
    departmentCode: raw.departmentCode ?? null,
    department: raw.department ?? null,
  };

  const student = group === "student";
  const params =
    group === "student"
      ? ({ ...search } as StudentReportParams)
      : ({
          period: search.period,
          from: search.from,
          to: search.to,
          groupBy: search.groupBy === "department" ? "department" : "none",
          department: search.department,
        } as StaffReportParams);

  const report = useQuery({
    queryKey: ["report", group, params],
    queryFn: () =>
      student
        ? api.studentReport(params as StudentReportParams)
        : api.staffReport(params as StaffReportParams),
  });

  const levels = useQuery({
    queryKey: ["students", "levels"],
    queryFn: () => api.students({ limit: 1 }),
  });
  const departments = useQuery({ queryKey: ["departments"], queryFn: api.departments });
  // Staff departments are free-text names with counts, not student codes.
  const staffDepartments = useQuery({
    queryKey: ["staff-departments"],
    queryFn: api.staffDepartments,
  });

  const series = report.data;
  const buckets = series?.buckets ?? [];
  const trend = buckets.map((bucket) => ({
    label: bucket.label,
    Expected: bucket.expected,
    Present: bucket.present,
    Absent: bucket.absent,
    percent: bucket.percent ?? 0,
  }));
  const breakdown = buckets.map((bucket) => ({
    label: bucket.label,
    Present: bucket.present,
    Absent: bucket.absent,
  }));
  const composition = series?.composition ?? [];

  function quickRange(value: string) {
    const [from = "", to = ""] = value.split("|");
    onChange({ from, to });
  }

  return (
    <div className="space-y-6">
      <Panel title="Filters" description="Pick a period and narrow to the group you care about.">
        <div className="flex flex-wrap items-center gap-2">
          <Select
            value={search.period}
            onValueChange={(value) => {
              const period = value as ReportPeriod;
              const range = applyPeriod(search.from, search.to, period);
              onChange({ period, ...range });
            }}
          >
            <SelectTrigger className="h-9 w-28">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="daily">Daily</SelectItem>
              <SelectItem value="weekly">Weekly</SelectItem>
              <SelectItem value="monthly">Monthly</SelectItem>
            </SelectContent>
          </Select>

          <Select onValueChange={quickRange}>
            <SelectTrigger className="h-9 w-36">
              <SelectValue placeholder="Quick range" />
            </SelectTrigger>
            <SelectContent>
              {periodOptions(search.period, search.from, search.to).map((option) => (
                <SelectItem key={option.value} value={option.value}>
                  {option.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>

          <Input
            type="date"
            className="h-9 w-40"
            value={search.from}
            onChange={(event) => onChange({ from: event.target.value })}
          />
          <Input
            type="date"
            className="h-9 w-40"
            value={search.to}
            onChange={(event) => onChange({ to: event.target.value })}
          />

          {student ? (
            <>
              <Select
                value={search.category ?? "all"}
                onValueChange={(value) =>
                  onChange({
                    category:
                      value === "all"
                        ? null
                        : value === "undergraduate"
                          ? "undergraduate"
                          : "postgraduate",
                  })
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
                onValueChange={(value) => onChange({ level: value === "all" ? null : value })}
              >
                <SelectTrigger className="h-9 w-32">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All levels</SelectItem>
                  {(levels.data?.levels ?? []).map((level) => (
                    <SelectItem key={level} value={level}>
                      Level {level}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </>
          ) : null}

          {student ? (
            <Select
              value={search.departmentCode ?? "all"}
              onValueChange={(value) =>
                onChange({ departmentCode: value === "all" ? null : value })
              }
            >
              <SelectTrigger className="h-9 w-40">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All departments</SelectItem>
                {(departments.data ?? []).map((code) => (
                  <SelectItem key={code} value={code}>
                    {code}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          ) : (
            <Select
              value={search.department ?? "all"}
              onValueChange={(value) => onChange({ department: value === "all" ? null : value })}
            >
              <SelectTrigger className="h-9 w-52">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All staff departments</SelectItem>
                {(staffDepartments.data?.departments ?? []).map((option) => (
                  <SelectItem key={option.department} value={option.department}>
                    {option.department} ({option.total})
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          )}

          <Select
            value={search.groupBy}
            onValueChange={(value) => onChange({ groupBy: value as ReportGroupBy })}
          >
            <SelectTrigger className="h-9 w-44">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="none">Group by date</SelectItem>
              <SelectItem value="department">By department</SelectItem>
              {/* Level and category come from the student file only. */}
              {student ? <SelectItem value="level">By level</SelectItem> : null}
              {student ? <SelectItem value="category">By category</SelectItem> : null}
            </SelectContent>
          </Select>

          <a
            href={
              student
                ? api.studentReportUrl(params as StudentReportParams)
                : api.staffReportUrl(params as StaffReportParams)
            }
            download
          >
            <Button variant="outline">Download CSV</Button>
          </a>
        </div>
      </Panel>

      {series ? (
        <>
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-5">
            <StatTile label="Events" value={series.totals.events} />
            <StatTile label="Expected" value={series.totals.expected} hint="Current master list" />
            <StatTile label="Present" value={series.totals.present} tone="good" />
            <StatTile
              label="Absent"
              value={series.totals.absent}
              tone={series.totals.absent > 0 ? "bad" : "good"}
            />
            <StatTile
              label="Unmatched scans"
              value={series.totals.unmatched}
              tone={series.totals.unmatched > 0 ? "warn" : "default"}
            />
          </div>

          {buckets.length === 0 ? (
            <EmptyState title="Nothing in that period">
              Move the dates, or check that events exist for this group.
            </EmptyState>
          ) : (
            <>
              <div className="grid gap-4 lg:grid-cols-2">
                <Panel
                  title="Attendance over time"
                  description={series.grouped ? "By group" : `By ${periodNoun(search.period)}`}
                >
                  <Chart height={260}>
                    <LineChart data={trend}>
                      <CartesianGrid strokeDasharray="3 3" className="stroke-border" />
                      <XAxis dataKey="label" tick={{ fontSize: 11 }} interval="preserveStartEnd" />
                      <YAxis tick={{ fontSize: 11 }} />
                      <Tooltip />
                      <Legend />
                      <Line type="monotone" dataKey="Expected" stroke="#94a3b8" dot={false} />
                      <Line type="monotone" dataKey="Present" stroke="#0d9488" strokeWidth={2} />
                    </LineChart>
                  </Chart>
                </Panel>

                <Panel
                  title="Present against absent"
                  description={series.grouped ? "By group" : "Per period"}
                >
                  <Chart height={260}>
                    <BarChart data={breakdown}>
                      <CartesianGrid strokeDasharray="3 3" className="stroke-border" />
                      <XAxis dataKey="label" tick={{ fontSize: 11 }} interval="preserveStartEnd" />
                      <YAxis tick={{ fontSize: 11 }} />
                      <Tooltip />
                      <Legend />
                      <Bar dataKey="Present" fill="#0d9488" />
                      <Bar dataKey="Absent" fill="#f43f5e" />
                    </BarChart>
                  </Chart>
                </Panel>
              </div>

              {composition.length > 0 ? (
                <Panel
                  title={`Who came, by ${student ? "department" : "department (if assigned)"}`}
                  description="Distinct people who turned up at least once in this period."
                >
                  <Chart height={280}>
                    <PieChart>
                      <Pie
                        data={composition.slice(0, 12)}
                        dataKey="value"
                        nameKey="label"
                        outerRadius={100}
                        label={(entry) => entry.label}
                      >
                        {composition.slice(0, 12).map((entry, index) => (
                          <Cell key={entry.key} fill={PIE_COLOURS[index % PIE_COLOURS.length]} />
                        ))}
                      </Pie>
                      <Tooltip />
                    </PieChart>
                  </Chart>
                </Panel>
              ) : null}

              <Panel
                title={series.grouped ? "Breakdown" : `By ${periodNoun(search.period)}`}
                description="Expected is the current master list for the chosen scope."
              >
                <DataTable
                  head={[
                    series.grouped ? "Group" : "Period",
                    "Events",
                    "Expected",
                    "Present",
                    "Absent",
                    "Out of scope",
                    "Unmatched",
                    "Rate",
                  ]}
                >
                  {buckets.map((bucket) => (
                    <DataRow
                      key={bucket.key}
                      cells={[
                        bucket.label,
                        <span className="tabular-nums">{bucket.events}</span>,
                        <span className="tabular-nums">{bucket.expected.toLocaleString()}</span>,
                        <span className="tabular-nums">{bucket.present.toLocaleString()}</span>,
                        <span className="tabular-nums">{bucket.absent.toLocaleString()}</span>,
                        <span className="tabular-nums">{bucket.out_of_scope}</span>,
                        <span className="tabular-nums">{bucket.unmatched}</span>,
                        <PercentBar value={bucket.percent} />,
                      ]}
                    />
                  ))}
                  <tr className="border-t-2 border-border font-medium">
                    <td className="px-3 py-2">Total</td>
                    <td className="px-3 py-2 tabular-nums">{series.totals.events}</td>
                    <td className="px-3 py-2 tabular-nums">
                      {series.totals.expected.toLocaleString()}
                    </td>
                    <td className="px-3 py-2 tabular-nums">
                      {series.totals.present.toLocaleString()}
                    </td>
                    <td className="px-3 py-2 tabular-nums">
                      {series.totals.absent.toLocaleString()}
                    </td>
                    <td className="px-3 py-2 tabular-nums">{series.totals.out_of_scope}</td>
                    <td className="px-3 py-2 tabular-nums">{series.totals.unmatched}</td>
                    <td className="px-3 py-2">
                      <PercentBar value={series.totals.percent} />
                    </td>
                  </tr>
                </DataTable>
              </Panel>

              {student && series.categories.length > 0 ? (
                <Panel
                  title="Undergraduate against postgraduate"
                  description="Distinct students who turned up."
                >
                  <Chart height={240}>
                    <BarChart data={series.categories}>
                      <CartesianGrid strokeDasharray="3 3" className="stroke-border" />
                      <XAxis dataKey="label" tick={{ fontSize: 11 }} />
                      <YAxis tick={{ fontSize: 11 }} />
                      <Tooltip />
                      <Bar dataKey="value" fill="#6366f1" />
                    </BarChart>
                  </Chart>
                </Panel>
              ) : null}
            </>
          )}
        </>
      ) : (
        <p className="text-sm text-muted-foreground">Building the report…</p>
      )}
    </div>
  );
}

function Chart({ height, children }: { height: number; children: ReactNode }) {
  return (
    <div style={{ width: "100%", height }}>
      <ResponsiveContainer width="100%" height="100%">
        {children as never}
      </ResponsiveContainer>
    </div>
  );
}
