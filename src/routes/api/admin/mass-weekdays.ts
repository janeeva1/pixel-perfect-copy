import { createFileRoute } from "@tanstack/react-router";
import { z } from "zod";
import { requireEditor, requireSession } from "@/server/auth";
import { handleRoute, json, parse, readJson } from "@/server/http";
import { listWeekdayAssignments, upsertWeekdayAssignment } from "@/server/mass";

const assignSchema = z.object({
  departmentCode: z.string().trim().min(1).max(120),
  dayOfWeek: z.number().int().min(1).max(5),
});

/**
 * Which weekday each department's Community Mass falls on. Editor-only (admin
 * or operator): it decides who is expected at every weekday week.
 */
export const Route = createFileRoute("/api/admin/mass-weekdays")({
  server: {
    handlers: {
      GET: () =>
        handleRoute(async () => {
          await requireSession();
          return json({ assignments: await listWeekdayAssignments() });
        }),
      POST: ({ request }) =>
        handleRoute(async () => {
          const session = await requireSession();
          requireEditor(session);
          const body = parse(assignSchema, await readJson(request));
          return json(
            await upsertWeekdayAssignment(body.departmentCode, body.dayOfWeek, session.user.id),
            201,
          );
        }),
    },
  },
});
