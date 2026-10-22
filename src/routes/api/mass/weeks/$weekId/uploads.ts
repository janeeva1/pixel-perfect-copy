import { createFileRoute } from "@tanstack/react-router";
import { z } from "zod";
import { requireEditor, requireSession } from "@/server/auth";
import { handleRoute, json, parse, readJson } from "@/server/http";
import { listMassUploads, processMassUpload } from "@/server/mass";

const nullable = z.string().trim().max(200).nullable().default(null);

const uploadSchema = z.object({
  participantType: z.enum(["student", "staff"]),
  level: z.string().trim().max(20).nullable().optional(),
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

/**
 * A machine export for this week, under one participant type and level. Every
 * row is kept and classified: present, out of scope, or unmatched.
 */
export const Route = createFileRoute("/api/mass/weeks/$weekId/uploads")({
  server: {
    handlers: {
      GET: ({ params }) =>
        handleRoute(async () => {
          await requireSession();
          return json({ uploads: await listMassUploads(params.weekId) });
        }),
      POST: ({ params, request }) =>
        handleRoute(async () => {
          const session = await requireSession();
          requireEditor(session);
          const body = parse(uploadSchema, await readJson(request));
          return json(
            await processMassUpload(
              params.weekId,
              {
                participantType: body.participantType,
                level: body.level ?? null,
                fileName: body.fileName,
                label: body.label,
                rows: body.rows,
              },
              session.user.id,
            ),
            201,
          );
        }),
    },
  },
});
