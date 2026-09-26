import { createFileRoute } from "@tanstack/react-router";
import { requireSession } from "@/server/auth";
import { handleRoute, json } from "@/server/http";
import { studentLevels } from "@/server/masters";

/**
 * The levels present in the students' matric numbers, e.g. ["100", "200", ...].
 * The level is stored, but the list to offer is worked out from the students
 * rather than kept separately, so it cannot fall out of step with them.
 */
export const Route = createFileRoute("/api/levels")({
  server: {
    handlers: {
      GET: () =>
        handleRoute(async () => {
          await requireSession();
          return json(await studentLevels());
        }),
    },
  },
});
