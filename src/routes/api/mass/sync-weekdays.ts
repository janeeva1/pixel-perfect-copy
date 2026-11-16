import { createFileRoute } from "@tanstack/react-router";
import { requireEditor, requireSession } from "@/server/auth";
import { handleRoute, json } from "@/server/http";
import { syncMassWeekdays } from "@/server/mass";

export const Route = createFileRoute("/api/mass/sync-weekdays")({
  server: {
    handlers: {
      POST: ({ request }) =>
        handleRoute(async () => {
          const session = await requireSession();
          requireEditor(session);
          const result = await syncMassWeekdays(session.user.id);
          return json(result);
        }),
    },
  },
});
