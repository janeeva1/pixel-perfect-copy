import { createFileRoute } from "@tanstack/react-router";
import { requireSession } from "@/server/auth";
import { readDownloadRequest } from "@/server/downloads-schema";
import {
  buildDownload,
  describeDownload,
  downloadCsv,
  downloadFilename,
  resolveScope,
} from "@/server/downloads";
import { assertNoBlockers } from "@/server/review";
import { handleRoute } from "@/server/http";

export const Route = createFileRoute("/api/downloads/report")({
  server: {
    handlers: {
      GET: async ({ request }) =>
        handleRoute(async () => {
          await requireSession();
          const wanted = readDownloadRequest(request);
          // Every event in the period must be fully confirmed first: a waiting
          // scan or possible duplicate would make someone present and absent.
          const scope = await resolveScope(wanted);
          for (const { event } of scope.events) {
            await assertNoBlockers({ type: "event", kind: wanted.group, eventId: event.id });
          }
          const result = await buildDownload(wanted);
          // The BOM is what makes Excel on Windows read the file as UTF-8. Without
          // it any name outside plain ASCII arrives as mojibake.
          return new Response(`\uFEFF${downloadCsv(wanted, result)}`, {
            headers: {
              "content-type": "text/csv; charset=utf-8",
              "content-disposition": `attachment; filename="${downloadFilename(wanted, result)}"`,
            },
          });
        }),
    },
  },
});
