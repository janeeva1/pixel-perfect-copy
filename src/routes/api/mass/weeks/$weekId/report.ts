import { createFileRoute } from "@tanstack/react-router";
import { requireSession } from "@/server/auth";
import { handleRoute } from "@/server/http";
import { buildMassReport, type MassReportCategory, type ReportFormat } from "@/server/mass-reports";

const CATEGORIES: readonly string[] = ["present", "absent", "out_of_scope", "unmatched", "summary"];
const FORMATS: readonly string[] = ["csv", "xlsx", "pdf"];

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
          const category: MassReportCategory = CATEGORIES.includes(categoryParam)
            ? (categoryParam as MassReportCategory)
            : "summary";
          const format: ReportFormat = FORMATS.includes(formatParam)
            ? (formatParam as ReportFormat)
            : "csv";

          const report = await buildMassReport(
            params.weekId,
            participantType,
            level,
            category,
            format,
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
