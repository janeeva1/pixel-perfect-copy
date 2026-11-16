import { createFileRoute } from "@tanstack/react-router";
import { z } from "zod";
import { requireAdmin, requireSession } from "@/server/auth";
import { handleRoute, json, parse, readJson } from "@/server/http";
import { clearData } from "@/server/clear";

const schema = z.object({ part: z.enum(["staff", "students", "events", "mass", "all"]) });

/** Clear one part of the data: staff, students, events, Weekly Mass, or all (src/server/clear.ts). */
export const Route = createFileRoute("/api/admin/clear")({
  server: {
    handlers: {
      POST: ({ request }) =>
        handleRoute(async () => {
          const session = await requireSession();
          await requireAdmin(session);
          const { part } = parse(schema, await readJson(request));
          const result = await clearData(part, session.user.id);
          return json({ ok: true, ...result });
        }),
    },
  },
});
