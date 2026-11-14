import { createFileRoute } from "@tanstack/react-router";
import { requireAdmin, requireSession } from "@/server/auth";
import { handleRoute, json } from "@/server/http";
import { deduplicateStaff, previewStaffDeduplication } from "@/server/masters";

// GET shows what would be merged and what is left for a person to review.
// POST merges only the rows that share both the machine number and the name.
export const Route = createFileRoute("/api/admin/staff/deduplicate")({
  server: {
    handlers: {
      GET: () =>
        handleRoute(async () => {
          const session = await requireSession();
          requireAdmin(session);
          return json(await previewStaffDeduplication());
        }),
      POST: () =>
        handleRoute(async () => {
          const session = await requireSession();
          requireAdmin(session);
          return json(await deduplicateStaff(session.user.id));
        }),
    },
  },
});
