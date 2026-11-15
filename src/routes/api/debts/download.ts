import { createFileRoute } from "@tanstack/react-router";
import { requireSession } from "@/server/auth";
import { debtReport, debtTable, type DebtView } from "@/server/debts";
import { handleRoute } from "@/server/http";
import { renderReport, type ReportFormat } from "@/server/mass-reports";

const VIEWS: readonly string[] = ["people", "departments", "weeks", "months"];
const FORMATS: readonly string[] = ["csv", "xlsx", "pdf"];

/** Download a section of the debt report: ?view=people&format=xlsx&month=&group=&department=&q= */
export const Route = createFileRoute("/api/debts/download")({
  server: {
    handlers: {
      GET: ({ request }) =>
        handleRoute(async () => {
          await requireSession();
          const url = new URL(request.url);
          const viewParam = url.searchParams.get("view") ?? "people";
          const formatParam = url.searchParams.get("format") ?? "csv";
          const view: DebtView = VIEWS.includes(viewParam) ? (viewParam as DebtView) : "people";
          const format: ReportFormat = FORMATS.includes(formatParam)
            ? (formatParam as ReportFormat)
            : "csv";
          const group = url.searchParams.get("group");
          const report = await debtReport({
            month: url.searchParams.get("month"),
            group: group === "staff" ? "staff" : group === "student" ? "student" : null,
          });
          const table = debtTable(report, view, {
            department: url.searchParams.get("department"),
            text: url.searchParams.get("q"),
          });
          const rendered = await renderReport(table, format);
          const body =
            typeof rendered.body === "string" ? rendered.body : new Uint8Array(rendered.body);
          const name = `mass-debts-${view}-${report.filters.month ?? "all"}.${format}`;
          return new Response(body, {
            headers: {
              "content-type": rendered.contentType,
              "content-disposition": `attachment; filename="${name}"`,
            },
          });
        }),
    },
  },
});
