import { createFileRoute } from "@tanstack/react-router";
import { requireSession } from "@/server/auth";
import { handleRoute, json } from "@/server/http";
import { listMassDepartments } from "@/server/mass";

/**
 * The departments that have a Community Mass weekday, with the day each one
 * sits on. A picker offers these, because a department with no weekday would
 * never be expected at Mass.
 */
export const Route = createFileRoute("/api/mass/departments")({
  server: {
    handlers: {
      GET: () =>
        handleRoute(async () => {
          await requireSession();
          return json(await listMassDepartments());
        }),
    },
  },
});
