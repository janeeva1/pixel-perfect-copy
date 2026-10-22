import { createFileRoute } from "@tanstack/react-router";
import { z } from "zod";
import { requireEditor, requireSession } from "@/server/auth";
import { handleRoute, json, parse, readJson } from "@/server/http";
import { updateStaff } from "@/server/masters";

/**
 * Correct one member of staff. The department is the registrar's own full name
 * and is what the Mass weekday assignments are keyed on, so this is how a
 * person is moved to another department.
 */
const nullable = z.string().trim().max(160).nullable().optional();

const bodySchema = z
  .object({
    lastName: nullable,
    firstName: nullable,
    middleName: nullable,
    faculty: nullable,
    department: nullable,
    adminDepartment: nullable,
  })
  .refine((value) => Object.keys(value).length > 0, "There is nothing to change.");

export const Route = createFileRoute("/api/staff/$staffId")({
  server: {
    handlers: {
      PATCH: ({ params, request }) =>
        handleRoute(async () => {
          const session = await requireSession();
          requireEditor(session);
          const body = parse(bodySchema, await readJson(request));
          const result = await updateStaff(params.staffId, body, session.user.id);
          return json({ ok: true, staleWeeks: result.staleWeeks });
        }),
    },
  },
});
