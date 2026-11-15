import { createFileRoute } from "@tanstack/react-router";
import { requireEditor, requireSession } from "@/server/auth";
import { handleRoute, json } from "@/server/http";
import { syncNow } from "@/server/peer";

/** "Synchronize now" on a member computer. */
export const Route = createFileRoute("/api/peer/sync")({
  server: {
    handlers: {
      POST: () =>
        handleRoute(async () => {
          const session = await requireSession();
          requireEditor(session);
          return json(await syncNow());
        }),
    },
  },
});
