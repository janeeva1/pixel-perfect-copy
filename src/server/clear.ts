// Clearing data, one part at a time --------------------------------------------
//
// The admin page offers separate buttons, so an office can start a part again
// without losing the rest:
//
//   staff     the staff list and everything recorded against it: staff events
//             with their files and scans, staff Weekly Mass data, the
//             always-present list, saved match answers for staff. (Scans point
//             at people, so a staff list cannot go while their attendance stays.)
//   students  the same for students.
//   events    student and staff events with their files and scans. People,
//             Weekly Mass and recurring templates stay.
//   mass      every Weekly Mass week with its files, scans and expected lists.
//             People, events and the department weekdays stay.
//   all       all of the above, and the recurring templates.
//
// User accounts, the audit log, department weekdays and debt rates are always
// kept. On computers that sync, what is cleared here is cleared there too.

import { randomUUID } from "node:crypto";
import { transaction, type DbConnection } from "@/server/db";
import { HttpError } from "@/server/http";
import { markStale } from "@/server/rematch";

export type ClearPart = "staff" | "students" | "events" | "mass" | "all";

const MESSAGES: Record<ClearPart, string> = {
  staff:
    "Staff list cleared, with staff events, staff Weekly Mass data and the always-present list. Students were kept.",
  students:
    "Student list cleared, with student events and student Weekly Mass data. Staff were kept.",
  events:
    "Student and staff events cleared, with their files and scans. People and Weekly Mass were kept.",
  mass: "Weekly Mass weeks cleared, with their files, scans and expected lists. People and events were kept.",
  all: "All attendance data cleared. User accounts, the audit log and the department weekdays were kept.",
};

async function clearEvents(conn: DbConnection, kind: "staff" | "student"): Promise<void> {
  const prefix = kind === "staff" ? "staff" : "student";
  await conn.query(`DELETE FROM ${prefix}_scans`);
  await conn.query(`DELETE FROM ${prefix}_event_uploads`);
  await conn.query(`DELETE FROM ${prefix}_event_departments`);
  await conn.query(`DELETE FROM ${prefix}_events`);
  await conn.query("DELETE FROM event_expected WHERE kind = ?", [kind]);
}

async function clearMass(conn: DbConnection, kind: "staff" | "student" | null): Promise<void> {
  if (kind === null) {
    await conn.query("DELETE FROM mass_scans");
    await conn.query("DELETE FROM mass_uploads");
    await conn.query("DELETE FROM mass_expected");
    await conn.query("DELETE FROM mass_week_weekdays");
    await conn.query("DELETE FROM mass_weeks");
    return;
  }
  await conn.query("DELETE FROM mass_scans WHERE participant_type = ?", [kind]);
  await conn.query("DELETE FROM mass_uploads WHERE participant_type = ?", [kind]);
  await conn.query("DELETE FROM mass_expected WHERE participant_type = ?", [kind]);
  // Weeks for this group only go too; weeks for both groups keep the other half.
  const weekType = kind === "staff" ? "staff" : "students";
  await conn.query(
    "DELETE FROM mass_week_weekdays WHERE mass_week_id IN (SELECT id FROM mass_weeks WHERE participant_type = ?)",
    [weekType],
  );
  await conn.query("DELETE FROM mass_weeks WHERE participant_type = ?", [weekType]);
}

async function clearPeople(conn: DbConnection, kind: "staff" | "student"): Promise<void> {
  await clearEvents(conn, kind);
  await clearMass(conn, kind);
  await conn.query("DELETE FROM scan_aliases WHERE kind = ?", [kind]);
  await conn.query("DELETE FROM distinct_people WHERE kind = ?", [kind]);
  if (kind === "staff") await conn.query("DELETE FROM staff_presence_overrides");
  await conn.query(kind === "staff" ? "DELETE FROM staff" : "DELETE FROM students");
}

export async function clearData(part: ClearPart, actorId: string): Promise<{ message: string }> {
  if (!(part in MESSAGES)) throw new HttpError(400, "Choose what to clear.");
  await transaction(async (conn) => {
    switch (part) {
      case "staff":
        await clearPeople(conn, "staff");
        break;
      case "students":
        await clearPeople(conn, "student");
        break;
      case "events":
        await clearEvents(conn, "staff");
        await clearEvents(conn, "student");
        break;
      case "mass":
        await clearMass(conn, null);
        break;
      case "all":
        await clearPeople(conn, "staff");
        await clearPeople(conn, "student");
        await clearMass(conn, null);
        await conn.query("DELETE FROM recurring_templates");
        break;
    }
    await conn.query(
      "INSERT INTO audit_logs (id, actor_id, action, entity, entity_id, details) VALUES (?, ?, ?, ?, ?, ?)",
      [randomUUID(), actorId, "data.cleared", "database", null, JSON.stringify({ part })],
    );
  });
  markStale("staff");
  markStale("student");
  return { message: MESSAGES[part] };
}
