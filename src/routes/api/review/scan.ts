import { createFileRoute } from "@tanstack/react-router";
import { z } from "zod";
import { requireEditor, requireSession } from "@/server/auth";
import { handleRoute, json, parse, readJson } from "@/server/http";
import { resolveScan } from "@/server/review";

const bodySchema = z.object({
  kind: z.enum(["student", "staff"]),
  scanNumber: z.string().nullable(),
  scannedName: z.string().nullable(),
  /** null: the entry is not anyone on the list. */
  personId: z.string().nullable(),
});

/** Say who a machine entry is; applied to every waiting scan of it and remembered. */
export const Route = createFileRoute("/api/review/scan")({
  server: {
    handlers: {
      POST: ({ request }) =>
        handleRoute(async () => {
          const session = await requireSession();
          requireEditor(session);
          const body = parse(bodySchema, await readJson(request));
          return json(await resolveScan({ ...body, actorId: session.user.id }));
        }),
    },
  },
});
