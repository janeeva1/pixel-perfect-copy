import { createFileRoute } from "@tanstack/react-router";
import { requireAdmin, requireSession } from "@/server/auth";
import { handleRoute, json } from "@/server/http";
import { transaction } from "@/server/db";

/**
 * Clear the events and everything that hangs off them, and keep the people.
 *
 * This is the half of "Clear All Data" that an office actually wants most of
 * the time: the season's events, the scans uploaded against them and the
 * weekly Mass records go; the student list, the staff list and the department
 * weekday assignments stay, because they describe the institution rather than
 * one term of it.
 */
export const Route = createFileRoute("/api/admin/clear-events")({
  server: {
    handlers: {
      POST: () =>
        handleRoute(async () => {
          const session = await requireSession();
          await requireAdmin(session);

          await transaction(async (conn) => {
            // Delete in order respecting foreign keys.
            //
            // The weekly Mass records go too: a week holds its own uploads,
            // scans and frozen expected list, which are attendance data rather
            // than a description of the institution. The department weekday
            // assignments stay, because they are the standing arrangement.
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
            // Weekly Mass: scans first (they point at the uploads), then the
            // uploads, then the expected snapshot, then the week and its days.
            await conn.query("DELETE FROM mass_scans");
            await conn.query("DELETE FROM mass_uploads");
            await conn.query("DELETE FROM mass_expected");
            await conn.query("DELETE FROM mass_week_weekdays");
            await conn.query("DELETE FROM mass_weeks");
          });

          return json({
            ok: true,
            message:
              "Events, scans, uploads, recurring templates and weekly Mass records cleared. " +
              "Students, staff, department weekdays, user accounts and the audit log were kept.",
          });
        }),
    },
  },
});
