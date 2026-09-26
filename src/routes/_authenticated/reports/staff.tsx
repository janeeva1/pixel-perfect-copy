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

export type StaffReportSearch = {
  period?: ReportPeriod;
  from?: string;
  to?: string;
  groupBy?: ReportGroupBy;
};

export const Route = createFileRoute("/_authenticated/reports/staff")({
  validateSearch: (search: Record<string, unknown>): StaffReportSearch => ({
    period:
      search["period"] === "weekly" ||
      search["period"] === "monthly" ||
      search["period"] === "daily"
        ? (search["period"] as ReportPeriod)
        : "daily",
    from: typeof search["from"] === "string" && search["from"] ? search["from"] : firstOfMonth(),
    to: typeof search["to"] === "string" && search["to"] ? search["to"] : today(),
    // Staff have no level, no category and no department, so a staff report is
    // always a straight run of dates.
    groupBy: "none",
  }),
  component: StaffReports,
  errorComponent: ({ error }) => <p role="alert">{error.message}</p>,
});

function StaffReports() {
  const search = Route.useSearch();
  const navigate = useNavigate();
  return (
    <div className="mx-auto max-w-6xl space-y-6">
      <header>
        <h1 className="text-2xl font-semibold">Staff reports</h1>
        <p className="text-sm text-muted-foreground">
          Staff attendance is reported separately from students, so a number that appears in both
          master lists never mixes the two.
        </p>
      </header>
      <ReportView
        group="staff"
        search={search}
        onChange={(next) => void navigate({ to: "/reports/staff", search: { ...search, ...next } })}
      />
    </div>
  );
}
