import { createFileRoute } from "@tanstack/react-router";
import { requireSession } from "@/server/auth";
import { handleRoute, json } from "@/server/http";
import { studentDepartments } from "@/server/masters";

/**
 * The department codes found in the students' matric numbers, e.g. ["ACC",
 * "BUS", "CSC"]. There is no departments table: the code is part of the
 * matric number and is read out of it.
 */
export const Route = createFileRoute("/api/departments")({
  server: {
    handlers: {
      GET: () =>
        handleRoute(async () => {
          await requireSession();
          return json(await studentDepartments());
        }),
    },
  },
});
