import { createFileRoute } from "@tanstack/react-router";
import { requireSession } from "@/server/auth";
import { handleRoute } from "@/server/http";
import { buildMassReport, type MassReportCategory, type ReportFormat } from "@/server/mass-reports";
import type { MassReportGroupBy } from "@/lib/types";

const CATEGORIES: readonly string[] = ["present", "absent", "out_of_scope", "unmatched", "summary"];
const FORMATS: readonly string[] = ["csv", "xlsx", "pdf"];
const GROUP_BY: readonly string[] = ["none", "department", "level", "category", "weekday"];

/**
 * Download one Mass report as csv, xlsx or pdf. The format is a query string
 * so a browser link can trigger it directly.
 */
export const Route = createFileRoute("/api/mass/weeks/$weekId/report")({
  server: {
    handlers: {
      GET: ({ params, request }) =>
        handleRoute(async () => {
          await requireSession();
          const url = new URL(request.url);
          const participantType =
            url.searchParams.get("participantType") === "staff" ? "staff" : "student";
          const levelParam = url.searchParams.get("level");
          const level = levelParam && levelParam.trim() !== "" ? levelParam.trim() : null;
          const categoryParam = url.searchParams.get("category") ?? "summary";
          const formatParam = url.searchParams.get("format") ?? "csv";
          const groupByParam = url.searchParams.get("groupBy") ?? "none";
          const category: MassReportCategory = CATEGORIES.includes(categoryParam)
            ? (categoryParam as MassReportCategory)
            : "summary";
          const format: ReportFormat = FORMATS.includes(formatParam)
            ? (formatParam as ReportFormat)
            : "csv";
          const groupBy: MassReportGroupBy = GROUP_BY.includes(groupByParam)
            ? (groupByParam as MassReportGroupBy)
            : "none";

          const report = await buildMassReport(
            params.weekId,
            participantType,
            level,
            category,
            format,
            groupBy,
          );
          const body = typeof report.body === "string" ? report.body : new Uint8Array(report.body);
          return new Response(body, {
            headers: {
              "content-type": report.contentType,
              "content-disposition": `attachment; filename="${report.filename}"`,
            },
          });
        }),
    },
  },
});
