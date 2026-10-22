import { createFileRoute } from "@tanstack/react-router";
import { z } from "zod";
import { requireEditor, requireSession } from "@/server/auth";
import { handleRoute, json, parse, readJson } from "@/server/http";
import { resetMassScope } from "@/server/mass";

const bodySchema = z.object({
  participantType: z.enum(["student", "staff"]),
});

/**
 * Forget every upload, scan and expected snapshot for one participant type
 * under this week. The next upload rebuilds the snapshot from the assignments
 * and masters as they stand then.
 */
export const Route = createFileRoute("/api/mass/weeks/$weekId/reset")({
  server: {
    handlers: {
      POST: ({ params, request }) =>
        handleRoute(async () => {
          const session = await requireSession();
          requireEditor(session);
          const body = parse(bodySchema, await readJson(request));
          await resetMassScope(params.weekId, body.participantType, session.user.id);
          return json({ ok: true });
        }),
    },
  },
});
