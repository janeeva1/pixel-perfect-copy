import { createFileRoute } from "@tanstack/react-router";
import { z } from "zod";
import { requireEditor, requireSession } from "@/server/auth";
import { createEvent, listEvents } from "@/server/events";
import { handleRoute, json, parse, readJson } from "@/server/http";

const listSchema = z.object({
  from: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .optional(),
  to: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .optional(),
  status: z.enum(["draft", "finalized"]).optional(),
  // "all" is the default so a list is never silently narrowed to one category.
  eventCategory: z.enum(["community_mass", "other", "all"]).default("all"),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});

/**
 * Staff have no undergraduate/postgraduate split and no level, but they do have
 * a department, so an event can name several. Omit the list to expect everyone.
 */
const bodySchema = z.object({
  title: z.string().trim().min(1, "Give the event a title.").max(160),
  eventDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Pick the event date."),
  // Defaults to "other" so an event created without the choice is still counted
  // in every report rather than falling out of all of them.
  eventCategory: z.enum(["community_mass", "other"]).default("other"),
  startTime: z.string().trim().max(5).nullable().default(null),
  endTime: z.string().trim().max(5).nullable().default(null),
  departments: z
    .array(z.string().trim().min(1).max(120))
    .max(60, "At most 60 departments on one event")
    .nullable()
    .default(null),
  notes: z.string().trim().max(2000).nullable().default(null),
});

export const Route = createFileRoute("/api/staff-events/")({
  server: {
    handlers: {
      GET: ({ request }) =>
        handleRoute(async () => {
          await requireSession();
          const params = parse(listSchema, Object.fromEntries(new URL(request.url).searchParams));
          return json(await listEvents("staff", params));
        }),
      POST: ({ request }) =>
        handleRoute(async () => {
          const session = await requireSession();
          requireEditor(session);
          const body = parse(bodySchema, await readJson(request));
          return json(await createEvent("staff", body, session.user.id), 201);
        }),
    },
  },
});
