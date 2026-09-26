import { createFileRoute } from "@tanstack/react-router";
import { requireSession } from "@/server/auth";
import { readDownloadRequest } from "@/server/downloads-schema";
import { buildDownload, describeDownload, downloadFilename } from "@/server/downloads";
import { handleRoute, json, parse } from "@/server/http";
import { downloadSchema } from "@/server/downloads-schema";

/**
 * What the operator is about to get, in words, before they ask for it. This is
 * the answer to "am I about to download the right thing": a sentence saying who,
 * which dates, which event type and present or absent, plus the row count.
 */
export const Route = createFileRoute("/api/downloads/preview")({
  server: {
    handlers: {
      GET: async ({ request }) =>
        handleRoute(async () => {
          await requireSession();
          // A half-finished set of choices is answered with a message saying what
          // is missing, not with a 400 stack trace.
          parse(downloadSchema, Object.fromEntries(new URL(request.url).searchParams));
          const wanted = readDownloadRequest(request);
          const result = await buildDownload(wanted);
          return json({
            description: describeDownload(wanted, result),
            filename: downloadFilename(wanted, result),
            rows: result.rows.length,
            events: result.eventsCount,
            people: result.peopleCount,
            attendedAtLeastOnce: result.presentCount,
            missedEvery: result.absentCount,
            from: result.from,
            to: result.to,
          });
        }),
    },
  },
});
