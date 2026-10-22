import { createFileRoute } from "@tanstack/react-router";
import { z } from "zod";
import { requireEditor, requireSession } from "@/server/auth";
import { handleRoute, json, parse, readJson } from "@/server/http";
import { createMassWeek, listMassWeeks } from "@/server/mass";

const createSchema = z.object({
  name: z.string().trim().min(1).max(120),
  notes: z.string().trim().max(500).nullable().optional(),
  scope: z.enum(["weekday", "sunday"]).optional(),
  participantType: z.enum(["students", "staff", "both"]).optional(),
  weekdays: z.array(z.number().int().min(1).max(5)).optional(),
});

/** Weekly Community Mass records: list them, or open a new week. */
export const Route = createFileRoute("/api/mass/weeks/")({
  server: {
    handlers: {
      GET: () =>
        handleRoute(async () => {
          await requireSession();
          return json({ weeks: await listMassWeeks() });
        }),
      POST: ({ request }) =>
        handleRoute(async () => {
          const session = await requireSession();
          requireEditor(session);
          const body = parse(createSchema, await readJson(request));
          return json(
            await createMassWeek(
              {
                name: body.name,
                notes: body.notes ?? null,
                scope: body.scope,
                participantType: body.participantType,
                weekdays: body.weekdays ?? [],
              },
              session.user.id,
            ),
            201,
          );
        }),
    },
  },
});
