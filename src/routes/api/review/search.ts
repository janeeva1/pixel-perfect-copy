import { createFileRoute } from "@tanstack/react-router";
import { requireSession } from "@/server/auth";
import { handleRoute, json } from "@/server/http";
import { searchPeople } from "@/server/review";

/** Find a person by name, staff/matric number or machine number: ?kind=staff&q=... */
export const Route = createFileRoute("/api/review/search")({
  server: {
    handlers: {
      GET: ({ request }) =>
        handleRoute(async () => {
          await requireSession();
          const url = new URL(request.url);
          const kind = url.searchParams.get("kind") === "staff" ? "staff" : "student";
          return json(await searchPeople(kind, url.searchParams.get("q") ?? ""));
        }),
    },
  },
});
