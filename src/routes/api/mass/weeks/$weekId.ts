import { createFileRoute } from "@tanstack/react-router";
import { z } from "zod";
import { requireAdmin, requireEditor, requireSession } from "@/server/auth";
import { handleRoute, json, parse, readJson } from "@/server/http";
import { deleteMassWeek, getMassWeek, updateMassWeek } from "@/server/mass";

const patchSchema = z.object({
  name: z.string().trim().min(1).max(120).optional(),
  notes: z.string().trim().max(500).nullable().optional(),
  scope: z.enum(["weekday", "sunday"]).optional(),
  participantType: z.enum(["students", "staff", "both"]).optional(),
  studentCategory: z.enum(["undergraduate", "postgraduate", "both"]).optional(),
});

/**
 * One weekly Community Mass record. Deleting a week removes its uploads,
 * scans and expected snapshot with it, because they describe that week alone.
 */
export const Route = createFileRoute("/api/mass/weeks/$weekId")({
  server: {
    handlers: {
      GET: ({ params }) =>
        handleRoute(async () => {
          await requireSession();
          return json(await getMassWeek(params.weekId));
        }),
      PATCH: ({ params, request }) =>
        handleRoute(async () => {
          const session = await requireSession();
          requireEditor(session);
          const body = parse(patchSchema, await readJson(request));
          return json(await updateMassWeek(params.weekId, body, session.user.id));
        }),
      DELETE: ({ params }) =>
        handleRoute(async () => {
          const session = await requireSession();
          requireAdmin(session);
          await deleteMassWeek(params.weekId, session.user.id);
          return json({ ok: true });
        }),
    },
  },
});
