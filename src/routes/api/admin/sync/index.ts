import { createFileRoute } from "@tanstack/react-router";
import { requireAdmin, requireSession } from "@/server/auth";
import { handleRoute, json } from "@/server/http";
import { deduplicateEveryone } from "@/server/masters";
import { markStale } from "@/server/rematch";
import { runSync, syncStatus } from "@/server/sync";

export const Route = createFileRoute("/api/admin/sync/")({
  server: {
    handlers: {
      GET: () =>
        handleRoute(async () => {
          const session = await requireSession();
          await requireAdmin(session);
          return json(await syncStatus());
        }),
      POST: () =>
        handleRoute(async () => {
          const session = await requireSession();
          await requireAdmin(session);
          const result = await runSync();
          // Another computer may hold the same person under a differently
          // written staff or matric number, and the pull just brought that
          // record in. Fold certain duplicates together so this computer's
          // lists hold each person once. (Results are per person either way.)
          const merged = await deduplicateEveryone(session.user.id);
          // People pulled in may be who an unmatched scan was.
          markStale("staff");
          markStale("student");
          const duplicatesMerged =
            merged.staff.duplicatesRemoved + merged.students.duplicatesRemoved;
          return json({
            ...result,
            duplicatesMerged,
            message:
              duplicatesMerged > 0
                ? `${result.message} Merged ${duplicatesMerged} duplicate record(s) of the same person.`
                : result.message,
          });
        }),
    },
  },
});
