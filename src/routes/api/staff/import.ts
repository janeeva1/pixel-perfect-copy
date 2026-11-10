import { createFileRoute } from "@tanstack/react-router";
import { z } from "zod";
import { requireEditor, requireSession } from "@/server/auth";
import { handleRoute, json, parse, readJson } from "@/server/http";
import { importStaff } from "@/server/masters";

const nullable = z.string().trim().max(160).nullable().default(null);

const bodySchema = z.object({
  records: z
    .array(
      z.object({
        staffNo: nullable,
        lastName: nullable,
        firstName: nullable,
        middleName: nullable,
        faculty: nullable,
        department: nullable,
        adminDepartment: nullable,
        machineId: nullable,
      }),
    )
    .min(1, "There is nothing to import.")
    .max(2000, "Import in batches of 2000 or fewer."),
});

export const Route = createFileRoute("/api/staff/import")({
  server: {
    handlers: {
      POST: ({ request }) =>
        handleRoute(async () => {
          const session = await requireSession();
          requireEditor(session);
          const body = parse(bodySchema, await readJson(request));
          return json(await importStaff(body.records, session.user.id));
        }),
    },
  },
});
