import { createFileRoute } from "@tanstack/react-router";
import { requireSession } from "@/server/auth";
import { handleRoute, HttpError, json } from "@/server/http";
import { reviewItems, type ReviewContext } from "@/server/review";

/**
 * What is waiting for an administrator in one Mass week or event:
 *   ?type=mass&weekId=...&participantType=staff|student
 *   ?type=event&kind=staff|student&eventId=...
 */
function readContext(url: URL): ReviewContext {
  const type = url.searchParams.get("type");
  if (type === "mass") {
    const weekId = url.searchParams.get("weekId");
    if (!weekId) throw new HttpError(400, "Which Mass week?");
    const participantType =
      url.searchParams.get("participantType") === "staff" ? "staff" : "student";
    return { type: "mass", weekId, participantType };
  }
  if (type === "event") {
    const eventId = url.searchParams.get("eventId");
    if (!eventId) throw new HttpError(400, "Which event?");
    const kind = url.searchParams.get("kind") === "staff" ? "staff" : "student";
    return { type: "event", kind, eventId };
  }
  throw new HttpError(400, "type must be mass or event.");
}

export const Route = createFileRoute("/api/review/")({
  server: {
    handlers: {
      GET: ({ request }) =>
        handleRoute(async () => {
          await requireSession();
          return json(await reviewItems(readContext(new URL(request.url))));
        }),
    },
  },
});
