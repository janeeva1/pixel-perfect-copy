import { createFileRoute } from "@tanstack/react-router";
import { requireSession } from "@/server/auth";
import { handleRoute, json } from "@/server/http";
import { staffDepartments } from "@/server/masters";

/**
 * The staff departments a picker can offer, each with the number of staff in it
 * so a chosen department can be seen to include somebody. `unassigned` counts the
 * staff who have neither column in their file row and so have no department to be
 * selected by. They fall outside a department-scoped event, and are expected at
 * an event that names no departments, because that one expects everyone.
 */
export const Route = createFileRoute("/api/staff-departments")({
  server: {
    handlers: {
      GET: () =>
        handleRoute(async () => {
          await requireSession();
          return json(await staffDepartments());
        }),
    },
  },
});
