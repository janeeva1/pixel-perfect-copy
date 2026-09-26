import { createFileRoute } from "@tanstack/react-router";
import type { RowDataPacket } from "@/server/db";
import { requireSession } from "@/server/auth";
import { dialect, query } from "@/server/db";
import { handleRoute, json } from "@/server/http";
import {
  categoryBreakdown,
  countStaff,
  countStudentsInScope,
  eventCategoryBreakdown,
} from "@/server/masters";
import type { Dashboard } from "@/lib/types";

type CountRow = RowDataPacket & { total: number };
type EventRow = RowDataPacket & { id: string; title: string; event_date: string; status: string };

async function count(table: string): Promise<number> {
  const row = await query<CountRow>(`SELECT COUNT(*) AS total FROM ${table}`).then(
    (rows) => rows[0],
  );
  return Number(row?.total ?? 0);
}

export const Route = createFileRoute("/api/dashboard")({
  server: {
    handlers: {
      GET: () =>
        handleRoute(async () => {
          await requireSession();
          const [
            students,
            staff,
            categories,
            studentEvents,
            staffEvents,
            eventCategories,
            recentStudentEvents,
            recentStaffEvents,
          ] = await Promise.all([
            countStudentsInScope({}),
            countStaff(),
            categoryBreakdown(),
            count("student_events"),
            count("staff_events"),
            eventCategoryBreakdown(),
            query<EventRow>(
              `SELECT id, title, ${dialect.date("event_date")} AS event_date, status
                 FROM student_events ORDER BY event_date DESC, created_at DESC LIMIT 5`,
            ),
            query<EventRow>(
              `SELECT id, title, ${dialect.date("event_date")} AS event_date, status
                 FROM staff_events ORDER BY event_date DESC, created_at DESC LIMIT 5`,
            ),
          ]);

          const payload: Dashboard = {
            students,
            undergraduates: categories.find((row) => row.category === "undergraduate")?.total ?? 0,
            postgraduates: categories.find((row) => row.category === "postgraduate")?.total ?? 0,
            staff,
            studentEvents,
            staffEvents,
            studentCommunityMassEvents: eventCategories.student.community_mass,
            studentOtherEvents: eventCategories.student.other,
            staffCommunityMassEvents: eventCategories.staff.community_mass,
            staffOtherEvents: eventCategories.staff.other,
            recentStudentEvents,
            recentStaffEvents,
          };
          return json(payload);
        }),
    },
  },
});
