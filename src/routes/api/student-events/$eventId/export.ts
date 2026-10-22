import { createFileRoute } from "@tanstack/react-router";
import { requireSession } from "@/server/auth";
import { eventResult } from "@/server/events";
import { handleRoute } from "@/server/http";
import { eventCsv } from "@/server/reports";
import { buildEventReport } from "@/server/mass-reports";

export const Route = createFileRoute("/api/student-events/$eventId/export")({
  server: {
    handlers: {
      GET: async ({ params, request }) => {
        await requireSession();
        const url = new URL(request.url);
        const format = url.searchParams.get("format");
        const result = await eventResult("student", params.eventId);

        if (format === "xlsx" || format === "pdf") {
          const report = await buildEventReport(result, format);
          const body = new Uint8Array(report.body);
          return new Response(body, {
            headers: {
              "content-type": report.contentType,
              "content-disposition": `attachment; filename="${report.filename}"`,
            },
          });
        }

        const name = result.event.title.toLowerCase().replace(/[^a-z0-9]+/g, "-");
        return new Response(eventCsv(result), {
          headers: {
            "content-type": "text/csv; charset=utf-8",
            "content-disposition": `attachment; filename="student-${result.event.event_date}-${name}.csv"`,
          },
        });
      },
    },
  },
});
