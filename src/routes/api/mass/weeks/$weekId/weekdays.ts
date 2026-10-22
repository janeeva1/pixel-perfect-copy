import { createFileRoute } from "@tanstack/react-router";
import { z } from "zod";
import { requireEditor, requireSession } from "@/server/auth";
import { handleRoute, json, parse, readJson } from "@/server/http";
import { setMassWeekWeekdays } from "@/server/mass";

const bodySchema = z.object({
  weekdays: z.array(z.number().int().min(1).max(5)),
});

/**
 * Which weekdays this week's Mass was held on. The public-holiday switch:
 * leave Monday out and nobody is expected, or absent, because of Monday.
 * Refused once uploads exist, because the snapshot was built from the old set.
 */
export const Route = createFileRoute("/api/mass/weeks/$weekId/weekdays")({
  server: {
    handlers: {
      PUT: ({ params, request }) =>
        handleRoute(async () => {
          const session = await requireSession();
          requireEditor(session);
          const body = parse(bodySchema, await readJson(request));
          return json(await setMassWeekWeekdays(params.weekId, body.weekdays, session.user.id));
        }),
    },
  },
});
