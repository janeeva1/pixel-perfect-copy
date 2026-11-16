import { createFileRoute } from "@tanstack/react-router";
import { requireAdmin, requireSession } from "@/server/auth";
import { handleRoute, json } from "@/server/http";
import { clearData } from "@/server/clear";

/** Kept for older screens: the same as POST /api/admin/clear { part: "all" }. */
export const Route = createFileRoute("/api/admin/clear-all")({
  server: {
    handlers: {
      POST: () =>
        handleRoute(async () => {
          const session = await requireSession();
          await requireAdmin(session);
          return json({ ok: true, ...(await clearData("all", session.user.id)) });
        }),
    },
  },
});
