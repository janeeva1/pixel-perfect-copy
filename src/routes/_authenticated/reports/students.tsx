import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { ReportView } from "@/components/ReportView";
import type { ReportGroupBy, ReportPeriod } from "@/lib/types";

function today() {
  return new Date().toISOString().slice(0, 10);
}
function firstOfMonth() {
  const now = new Date();
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)).toISOString().slice(0, 10);
}

export type StudentReportSearch = {
  period?: ReportPeriod;
  from?: string;
  to?: string;
  groupBy?: ReportGroupBy;
  category?: "undergraduate" | "postgraduate" | null;
  level?: string | null;
  departmentCode?: string | null;
};

export const Route = createFileRoute("/_authenticated/reports/students")({
  validateSearch: (search: Record<string, unknown>): StudentReportSearch => ({
    period:
      search["period"] === "weekly" ||
      search["period"] === "monthly" ||
      search["period"] === "daily"
        ? (search["period"] as ReportPeriod)
        : "daily",
    from: typeof search["from"] === "string" && search["from"] ? search["from"] : firstOfMonth(),
    to: typeof search["to"] === "string" && search["to"] ? search["to"] : today(),
    groupBy:
      search["groupBy"] === "department" ||
      search["groupBy"] === "level" ||
      search["groupBy"] === "category"
        ? (search["groupBy"] as ReportGroupBy)
        : "none",
    category:
      search["category"] === "undergraduate" || search["category"] === "postgraduate"
        ? search["category"]
        : null,
    level: typeof search["level"] === "string" && search["level"] ? search["level"] : null,
    departmentCode:
      typeof search["departmentCode"] === "string" && search["departmentCode"]
        ? search["departmentCode"]
        : null,
  }),
  component: StudentReports,
  errorComponent: ({ error }) => <p role="alert">{error.message}</p>,
});

function StudentReports() {
  const search = Route.useSearch();
  const navigate = useNavigate();
  return (
    <div className="mx-auto max-w-6xl space-y-6">
      <header>
        <h1 className="text-2xl font-semibold">Student reports</h1>
        <p className="text-sm text-muted-foreground">
          Daily, weekly and monthly attendance for students, with percentages and downloads.
          Expected is recalculated from the master list every time, so correcting an import corrects
          history.
        </p>
      </header>
      <ReportView
        group="student"
        search={search}
        onChange={(next) =>
          void navigate({ to: "/reports/students", search: { ...search, ...next } })
        }
      />
    </div>
  );
}
