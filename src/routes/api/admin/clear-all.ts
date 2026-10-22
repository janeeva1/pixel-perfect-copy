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
            // Weekly Mass goes as well. A week holds its own uploads, scans and
            // frozen expected list, which are attendance data; leaving them
            // behind would mean "Clear All Data" left a whole term of Mass
            // records in place, which is not what the button says.
            await conn.query("DELETE FROM mass_scans");
            await conn.query("DELETE FROM mass_uploads");
            await conn.query("DELETE FROM mass_expected");
            await conn.query("DELETE FROM mass_week_weekdays");
            await conn.query("DELETE FROM mass_weeks");
            await conn.query("DELETE FROM students");
            await conn.query("DELETE FROM staff");
          });

          // Says what it left alone, because accounts, the audit trail and the
          // standing department weekday assignments are deliberately not
          // touched: an admin who runs this to start again should not find
          // their own login gone.
          return json({
            ok: true,
            message:
              "Attendance data cleared, including the weekly Mass records. " +
              "User accounts, the audit log and the department weekdays were kept.",
          });
        }),
    },
  },
});
