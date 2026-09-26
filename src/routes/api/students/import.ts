import { createFileRoute } from "@tanstack/react-router";
import { z } from "zod";
import { requireEditor, requireSession } from "@/server/auth";
import { handleRoute, json, parse, readJson } from "@/server/http";
import { importStudents } from "@/server/masters";

const nullable = z.string().trim().max(160).nullable().default(null);

const bodySchema = z.object({
  records: z
    .array(
      z.object({
        matricNo: z.string().trim().min(1).max(64),
        lastName: nullable,
        firstName: nullable,
        middleName: nullable,
        level: nullable,
      }),
    )
    .min(1, "There is nothing to import.")
    .max(2000, "Import in batches of 2000 or fewer."),
});

export const Route = createFileRoute("/api/students/import")({
  server: {
    handlers: {
      POST: ({ request }) =>
        handleRoute(async () => {
          const session = await requireSession();
          requireEditor(session);
          const body = parse(bodySchema, await readJson(request));
          return json(await importStudents(body.records, session.user.id));
        }),
    },
  },
});
