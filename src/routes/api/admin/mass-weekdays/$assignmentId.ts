import { createFileRoute } from "@tanstack/react-router";
import { z } from "zod";
import { requireEditor, requireSession } from "@/server/auth";
import { handleRoute, json, parse, readJson } from "@/server/http";
import { deleteWeekdayAssignment, setWeekdayAssignmentActive } from "@/server/mass";

const patchSchema = z.object({
  isActive: z.boolean(),
});

/**
 * One department's assignment. Deactivating stops the department being
 * expected at new weeks; deleting forgets it entirely.
 */
export const Route = createFileRoute("/api/admin/mass-weekdays/$assignmentId")({
  server: {
    handlers: {
      PATCH: ({ params, request }) =>
        handleRoute(async () => {
          const session = await requireSession();
          requireEditor(session);
          const body = parse(patchSchema, await readJson(request));
          await setWeekdayAssignmentActive(params.assignmentId, body.isActive, session.user.id);
          return json({ ok: true });
        }),
      DELETE: ({ params }) =>
        handleRoute(async () => {
          const session = await requireSession();
          requireEditor(session);
          await deleteWeekdayAssignment(params.assignmentId, session.user.id);
          return json({ ok: true });
        }),
    },
  },
});
