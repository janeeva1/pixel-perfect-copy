import { createFileRoute } from "@tanstack/react-router";
import { requireAdmin, requireSession } from "@/server/auth";
import { handleRoute, json } from "@/server/http";
import { transaction } from "@/server/db";

export const Route = createFileRoute("/api/admin/clear-all")({
  server: {
    handlers: {
      POST: () =>
        handleRoute(async () => {
          const session = await requireSession();
          await requireAdmin(session);

          await transaction(async (conn) => {
            // Delete in order respecting foreign keys.
            await conn.query("DELETE FROM student_scans");
            await conn.query("DELETE FROM student_event_uploads");
            await conn.query("DELETE FROM student_events");
            await conn.query("DELETE FROM staff_scans");
            await conn.query("DELETE FROM staff_event_uploads");
            await conn.query("DELETE FROM staff_events");
            // The recurring templates and their schedules go too. Left behind, a
            // template outlives the master lists its scope was worked out from, so
            // generating from it afterwards would match an empty list of people and
            // quietly produce events expecting nobody. The schedules and their
            // departments cascade from the template.
            await conn.query("DELETE FROM recurring_templates");
            await conn.query("DELETE FROM students");
            await conn.query("DELETE FROM staff");
          });

          // Says what it left alone, because accounts and the audit trail are
          // deliberately not touched: an admin who runs this to start again
          // should not find their own login gone.
          return json({
            ok: true,
            message: "Attendance data cleared. User accounts and the audit log were kept.",
          });
        }),
    },
  },
});
