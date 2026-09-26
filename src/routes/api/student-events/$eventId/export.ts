import { createFileRoute } from "@tanstack/react-router";
import { requireSession } from "@/server/auth";
import { eventResult } from "@/server/events";
import { handleRoute } from "@/server/http";
import { eventCsv } from "@/server/reports";

export const Route = createFileRoute("/api/student-events/$eventId/export")({
  server: {
    handlers: {
      GET: async ({ params }) => {
        await requireSession();
        const result = await eventResult("student", params.eventId);
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
