import { createFileRoute } from "@tanstack/react-router";
import { requireSession } from "@/server/auth";
import { debtReport } from "@/server/debts";
import { handleRoute, json } from "@/server/http";

/** The Mass debts, worked out now: GET ?month=2026-10&group=staff|student. */
export const Route = createFileRoute("/api/debts/")({
  server: {
    handlers: {
      GET: ({ request }) =>
        handleRoute(async () => {
          await requireSession();
          const url = new URL(request.url);
          const group = url.searchParams.get("group");
          return json(
            await debtReport({
              month: url.searchParams.get("month"),
              group: group === "staff" ? "staff" : group === "student" ? "student" : null,
            }),
          );
        }),
    },
  },
});
