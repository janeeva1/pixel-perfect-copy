import { createFileRoute } from "@tanstack/react-router";
import { requireSession } from "@/server/auth";
import { handleRoute, json } from "@/server/http";
import { massResult } from "@/server/mass";

/**
 * One week's full result for one participant type and optional level, as JSON,
 * so the reports page can draw its tables. The downloadable files live next
 * door under .../report; this route is the on-screen equivalent.
 */
export const Route = createFileRoute("/api/mass/weeks/$weekId/result")({
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
          return json(await massResult(params.weekId, participantType, level));
        }),
    },
  },
});
