import { createFileRoute } from "@tanstack/react-router";
import { z } from "zod";
import { requireEditor, requireSession } from "@/server/auth";
import { deleteEvent, eventResult, updateEvent } from "@/server/events";
import { handleRoute, HttpError, json, parse, readJson } from "@/server/http";

/** Optional and without defaults, so a field that is absent is left as it is. */
const patchSchema = z.object({
  title: z.string().trim().min(1, "Give the event a title.").max(160).optional(),
  eventDate: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, "Pick the event date.")
    .optional(),
  eventCategory: z.enum(["community_mass", "other"]).optional(),
  startTime: z.string().trim().max(5).nullable().optional(),
  endTime: z.string().trim().max(5).nullable().optional(),
  departments: z
    .array(z.string().trim().min(1).max(160))
    .max(60, "At most 60 departments on one event")
    .nullable()
    .optional(),
  notes: z.string().trim().max(2000).nullable().optional(),
});

export const Route = createFileRoute("/api/staff-events/$eventId")({
  server: {
    handlers: {
      GET: ({ params }) =>
        handleRoute(async () => {
          await requireSession();
          return json(await eventResult("staff", params.eventId));
        }),
      PATCH: ({ params, request }) =>
        handleRoute(async () => {
          const session = await requireSession();
          requireEditor(session);
          const body = parse(patchSchema, await readJson(request));
          if (Object.keys(body).length === 0) {
            throw new HttpError(400, "There is nothing to change.");
          }
          return json(await updateEvent("staff", params.eventId, body, session.user.id));
        }),
      DELETE: ({ params }) =>
        handleRoute(async () => {
          const session = await requireSession();
          requireEditor(session);
          await deleteEvent("staff", params.eventId);
          return json({ ok: true });
        }),
    },
  },
});
