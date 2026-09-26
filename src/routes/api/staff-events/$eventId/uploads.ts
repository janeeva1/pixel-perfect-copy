import { createFileRoute } from "@tanstack/react-router";
import { z } from "zod";
import { requireEditor, requireSession } from "@/server/auth";
import { uploadScans } from "@/server/events";
import { handleRoute, json, parse, readJson } from "@/server/http";

const nullable = z.string().trim().max(200).nullable().default(null);

/**
 * One machine export. An event accepts many of these, so clock-in and
 * clock-out uploads, or a re-export, all add to the same event.
 */
const bodySchema = z.object({
  fileName: z.string().trim().min(1).max(255),
  label: z.string().trim().max(80).nullable().default(null),
  rows: z
    .array(
      z.object({
        scanNumber: nullable,
        name: nullable,
        scannedAt: nullable,
      }),
    )
    .min(1, "There is nothing to upload.")
    .max(20000, "Upload in batches of 20000 rows or fewer."),
});

export const Route = createFileRoute("/api/staff-events/$eventId/uploads")({
  server: {
    handlers: {
      POST: ({ params, request }) =>
        handleRoute(async () => {
          const session = await requireSession();
          requireEditor(session);
          const body = parse(bodySchema, await readJson(request));
          return json(
            await uploadScans(
              "staff",
              params.eventId,
              { ...body, rows: body.rows },
              session.user.id,
            ),
            201,
          );
        }),
    },
  },
});
