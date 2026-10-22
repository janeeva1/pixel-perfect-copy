import { createFileRoute } from "@tanstack/react-router";
import { z } from "zod";
import { requireEditor, requireSession } from "@/server/auth";
import { handleRoute, json, parse, readJson } from "@/server/http";
import { setMassWeekStatus } from "@/server/mass";
import type { MassWeekStatus } from "@/lib/types";

const bodySchema = z.object({
  status: z.enum(["draft", "active", "completed", "archived"]),
});

/** Move a week through draft → active → completed → archived. */
export const Route = createFileRoute("/api/mass/weeks/$weekId/status")({
  server: {
    handlers: {
      POST: ({ params, request }) =>
        handleRoute(async () => {
          const session = await requireSession();
          requireEditor(session);
          const body = parse(bodySchema, await readJson(request));
          return json(
            await setMassWeekStatus(params.weekId, body.status as MassWeekStatus, session.user.id),
          );
        }),
    },
  },
});
