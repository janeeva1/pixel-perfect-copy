import { createFileRoute } from "@tanstack/react-router";
import { requireAdmin, requireSession } from "@/server/auth";
import { handleRoute, json } from "@/server/http";
import { runSync, syncStatus } from "@/server/sync";

export const Route = createFileRoute("/api/admin/sync")({
  server: {
    handlers: {
      GET: () =>
        handleRoute(async () => {
          const session = await requireSession();
          await requireAdmin(session);
          return json(syncStatus());
        }),
      POST: () =>
        handleRoute(async () => {
          const session = await requireSession();
          await requireAdmin(session);
          return json(await runSync());
        }),
    },
  },
});
