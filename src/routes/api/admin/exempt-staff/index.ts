import { createFileRoute } from "@tanstack/react-router";
import { z } from "zod";
import { requireAdmin, requireSession } from "@/server/auth";
import { handleRoute, json, parse, readJson } from "@/server/http";
import { addOverride, listOverrides, removeOverride } from "@/server/presence-overrides";

const addSchema = z.object({
  staffNo: z.string().trim().min(1, "Choose a staff member."),
  reason: z.string().trim().max(200).optional(),
});

/**
 * Staff who are always present (Vice-Chancellor, DVCs, Provost, ...): never
 * absent at a staff event or Weekly Mass, never charged on the debt page.
 * GET the list; POST {staffNo, reason} to add; DELETE ?scanNumber= to remove.
 */
export const Route = createFileRoute("/api/admin/exempt-staff/")({
  server: {
    handlers: {
      GET: () =>
        handleRoute(async () => {
          await requireSession();
          return json(await listOverrides());
        }),
      POST: ({ request }) =>
        handleRoute(async () => {
          const session = await requireSession();
          requireAdmin(session);
          const body = parse(addSchema, await readJson(request));
          return json(
            await addOverride({
              staffNo: body.staffNo,
              reason: body.reason ?? "",
              actorId: session.user.id,
            }),
            201,
          );
        }),
      DELETE: ({ request }) =>
        handleRoute(async () => {
          const session = await requireSession();
          requireAdmin(session);
          const scanNumber = new URL(request.url).searchParams.get("scanNumber") ?? "";
          await removeOverride(scanNumber, session.user.id);
          return json({ ok: true });
        }),
    },
  },
});
