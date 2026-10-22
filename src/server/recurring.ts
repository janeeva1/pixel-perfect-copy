import { randomUUID } from "node:crypto";
import { dialect, query, queryOne, transaction, utcStamp, type SqlParam } from "@/server/db";
import type { DbConnection, RowDataPacket } from "./db";
import { normalizeScopeList } from "@/server/masters";
import type {
  GenerateEventsResult,
  GroupKind,
  RecurringSchedule,
  RecurringScheduleInput,
  RecurringTemplate,
  RecurringTemplateInput,
  RecurringTemplateWithSchedules,
  UpdateRecurringTemplateInput,
} from "@/lib/types";

type TemplateRow = RowDataPacket & RecurringTemplate;
type ScheduleRow = RowDataPacket & Omit<RecurringSchedule, "departments">;

/** Clean a department list: drop blanks, collapse repeats and trim. */
function cleanDepartments(departments: unknown): string[] {
  return normalizeScopeList(departments);
}

function dayName(day: number): string {
  const names = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
  return names[day] ?? "Unknown";
}

/** Attach each schedule's department list, keyed by schedule id. */
async function departmentsBySchedule(scheduleIds: string[]): Promise<Map<string, string[]>> {
  const bySchedule = new Map<string, string[]>();
  if (scheduleIds.length === 0) return bySchedule;

  const rows = await query<RowDataPacket & { schedule_id: string; department: string }>(
    `SELECT schedule_id, department FROM recurring_schedule_departments
     WHERE schedule_id IN (${scheduleIds.map(() => "?").join(", ")})
     ORDER BY department`,
    scheduleIds as SqlParam[],
  );
  for (const row of rows) {
    const list = bySchedule.get(row.schedule_id) ?? [];
    list.push(row.department);
    bySchedule.set(row.schedule_id, list);
  }
  return bySchedule;
}

const SCHEDULE_COLUMNS = `id, template_id, day_of_week, student_category, level, title_suffix`;

function shapeSchedules(
  schedules: ScheduleRow[],
  departments: Map<string, string[]>,
): RecurringSchedule[] {
  return schedules.map((s) => ({ ...s, departments: departments.get(s.id) ?? [] }));
}

export async function listRecurringTemplates(): Promise<RecurringTemplateWithSchedules[]> {
  const templates = await query<TemplateRow>(
    `SELECT id, name, description, group_kind, event_category, start_date, end_date, event_title_template,
            start_time, end_time, notes, created_by, created_at, updated_at
     FROM recurring_templates
     ORDER BY start_date DESC`,
  );

  const schedules = await query<ScheduleRow>(
    `SELECT ${SCHEDULE_COLUMNS} FROM recurring_schedules ORDER BY template_id, day_of_week`,
  );

  const departments = await departmentsBySchedule(schedules.map((s) => s.id));

  const byTemplate = new Map<string, RecurringSchedule[]>();
  for (const s of shapeSchedules(schedules, departments)) {
    const arr = byTemplate.get(s.template_id) ?? [];
    arr.push(s);
    byTemplate.set(s.template_id, arr);
  }

  return templates.map((t) => ({ ...t, schedules: byTemplate.get(t.id) ?? [] }));
}

export async function getRecurringTemplate(
  id: string,
): Promise<RecurringTemplateWithSchedules | null> {
  const template = await queryOne<TemplateRow>(
    `SELECT id, name, description, group_kind, event_category, start_date, end_date, event_title_template,
            start_time, end_time, notes, created_by, created_at, updated_at
     FROM recurring_templates WHERE id = ?`,
    [id],
  );
  if (!template) return null;

  const schedules = await query<ScheduleRow>(
    `SELECT ${SCHEDULE_COLUMNS} FROM recurring_schedules WHERE template_id = ? ORDER BY day_of_week`,
    [id],
  );

  const departments = await departmentsBySchedule(schedules.map((s) => s.id));
  return { ...template, schedules: shapeSchedules(schedules, departments) };
}

/** Write the schedule rows and their departments in one place. */
async function writeSchedules(
  conn: DbConnection,
  templateId: string,
  schedules: RecurringScheduleInput[],
  group: GroupKind,
): Promise<void> {
  for (const s of schedules) {
    const scheduleId = randomUUID();
    await conn.execute(
      `INSERT INTO recurring_schedules
       (id, template_id, day_of_week, student_category, level, title_suffix)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [
        scheduleId,
        templateId,
        s.day_of_week,
        group === "student" ? (s.student_category ?? null) : null,
        group === "student" ? (s.level ?? null) : null,
        s.title_suffix ?? null,
      ],
    );

    for (const department of cleanDepartments(s.departments)) {
      await conn.execute(
        `${dialect.insertIgnore} recurring_schedule_departments (schedule_id, department)
         VALUES (?, ?)`,
        [scheduleId, department],
      );
    }
  }
}

export async function createRecurringTemplate(
  input: RecurringTemplateInput,
  actorId: string,
): Promise<RecurringTemplate> {
  const id = randomUUID();
  const now = utcStamp();
  const group: GroupKind = input.group_kind ?? "student";

  await transaction(async (conn) => {
    await conn.execute(
      `INSERT INTO recurring_templates
       (id, name, description, group_kind, event_category, start_date, end_date,
        event_title_template, start_time, end_time, notes, created_by, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        id,
        input.name,
        input.description ?? null,
        group,
        input.event_category ?? "other",
        input.start_date,
        input.end_date,
        input.event_title_template,
        input.start_time ?? null,
        input.end_time ?? null,
        input.notes ?? null,
        actorId,
        now,
        now,
      ],
    );

    await writeSchedules(conn, id, input.schedules, group);
  });

  const result = await getRecurringTemplate(id);
  if (!result) throw new Error("Template created but not found");
  return result;
}

export async function updateRecurringTemplate(
  id: string,
  input: UpdateRecurringTemplateInput,
): Promise<RecurringTemplate> {
  await transaction(async (conn) => {
    const existing = await conn.execute(`SELECT group_kind FROM recurring_templates WHERE id = ?`, [
      id,
    ]);
    const rows = (existing[0] as RowDataPacket[]) ?? [];
    if (rows.length === 0) throw new Error("Template not found");
    const currentGroup = (rows[0] as { group_kind: GroupKind }).group_kind;
    const group = input.group_kind ?? currentGroup;

    const fields: string[] = [];
    const values: SqlParam[] = [];

    if (input.name !== undefined) {
      fields.push("name = ?");
      values.push(input.name);
    }
    if (input.description !== undefined) {
      fields.push("description = ?");
      values.push(input.description ?? null);
    }
    if (input.group_kind !== undefined) {
      fields.push("group_kind = ?");
      values.push(input.group_kind);
    }
    if (input.event_category !== undefined) {
      fields.push("event_category = ?");
      values.push(input.event_category);
    }
    if (input.start_date !== undefined) {
      fields.push("start_date = ?");
      values.push(input.start_date);
    }
    if (input.end_date !== undefined) {
      fields.push("end_date = ?");
      values.push(input.end_date);
    }
    if (input.event_title_template !== undefined) {
      fields.push("event_title_template = ?");
      values.push(input.event_title_template);
    }
    if (input.start_time !== undefined) {
      fields.push("start_time = ?");
      values.push(input.start_time ?? null);
    }
    if (input.end_time !== undefined) {
      fields.push("end_time = ?");
      values.push(input.end_time ?? null);
    }
    if (input.notes !== undefined) {
      fields.push("notes = ?");
      values.push(input.notes ?? null);
    }

    if (fields.length > 0) {
      // utcStamp(), not a hand-rolled slice: sync compares these stamps as
      // strings, so the '.mmm' suffix has to be there or an edited template
      // loses to an untouched row on the hub at the same instant.
      fields.push("updated_at = ?");
      values.push(utcStamp());
      values.push(id);
      await conn.execute(
        `UPDATE recurring_templates SET ${fields.join(", ")} WHERE id = ?`,
        values,
      );
    }

    if (input.schedules !== undefined) {
      // The department rows go with the schedule rows, by cascade.
      await conn.execute("DELETE FROM recurring_schedules WHERE template_id = ?", [id]);
      await writeSchedules(conn, id, input.schedules, group);
    }
  });

  const result = await getRecurringTemplate(id);
  if (!result) throw new Error("Template not found after update");
  return result;
}

export async function deleteRecurringTemplate(id: string): Promise<void> {
  await transaction(async (conn) => {
    await conn.execute("DELETE FROM recurring_schedules WHERE template_id = ?", [id]);
    await conn.execute("DELETE FROM recurring_templates WHERE id = ?", [id]);
  });
}

/**
 * Generate the concrete events for a template across its date range.
 *
 * Which table the events land in follows the template's `group_kind`, so a staff
 * template produces staff events and a student template produces student events.
 * Each generated event carries every department chosen for that day, so a day
 * covering three departments is one event with one upload rather than three
 * events that have to agree with each other.
 */
export async function generateEventsFromTemplate(
  templateId: string,
): Promise<GenerateEventsResult> {
  const template = await getRecurringTemplate(templateId);
  if (!template) throw new Error("Template not found");

  const start = new Date(`${template.start_date}T00:00:00Z`);
  const end = new Date(`${template.end_date}T00:00:00Z`);
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime()) || start > end) {
    throw new Error("Invalid date range");
  }

  const group: GroupKind = template.group_kind;
  const isStudent = group === "student";
  const eventsTable = isStudent ? "student_events" : "staff_events";
  const departmentTable = isStudent ? "student_event_departments" : "staff_event_departments";
  const departmentColumn = isStudent ? "department_code" : "department";
  const now = new Date().toISOString().slice(0, 19).replace("T", " ");

  let created = 0;
  let skipped = 0;
  const events: Array<{ id: string; title: string; event_date: string }> = [];

  await transaction(async (conn) => {
    for (const schedule of template.schedules) {
      const departments = cleanDepartments(schedule.departments);
      const primary = departments[0] ?? null;

      // Every date in [start, end] that falls on this day of the week.
      const current = new Date(start);
      while (current.getUTCDay() !== schedule.day_of_week) {
        current.setUTCDate(current.getUTCDate() + 1);
      }

      while (current <= end) {
        const eventDate = current.toISOString().slice(0, 10);

        // Re-running the generator must not double-book a date.
        const [existing] = await conn.execute(
          `SELECT id FROM ${eventsTable} WHERE schedule_id = ? AND event_date = ?`,
          [schedule.id, eventDate],
        );
        if ((existing as RowDataPacket[]).length > 0) {
          skipped += 1;
          current.setUTCDate(current.getUTCDate() + 7);
          continue;
        }

        const day = dayName(schedule.day_of_week);
        const suffix = schedule.title_suffix ? ` — ${schedule.title_suffix}` : "";
        const title = `${template.event_title_template}${suffix} (${day})`;
        const eventId = randomUUID();

        if (isStudent) {
          await conn.execute(
            `INSERT INTO student_events
             (id, title, event_date, event_category, start_time, end_time,
              student_category, level, department_code,
              notes, status, created_by, template_id, schedule_id, created_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'draft', ?, ?, ?, ?)`,
            [
              eventId,
              title,
              eventDate,
              // Inherited from the template, so a Community Mass template produces
              // Community Mass events without anyone re-marking them.
              template.event_category ?? "other",
              template.start_time ?? null,
              template.end_time ?? null,
              schedule.student_category ?? null,
              schedule.level ?? null,
              primary,
              template.notes ?? null,
              template.created_by ?? null,
              template.id,
              schedule.id,
              now,
            ],
          );
        } else {
          await conn.execute(
            `INSERT INTO staff_events
             (id, title, event_date, event_category, start_time, end_time,
              notes, status, created_by, template_id, schedule_id, created_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, 'draft', ?, ?, ?, ?)`,
            [
              eventId,
              title,
              eventDate,
              template.event_category ?? "other",
              template.start_time ?? null,
              template.end_time ?? null,
              template.notes ?? null,
              template.created_by ?? null,
              template.id,
              schedule.id,
              now,
            ],
          );
        }

        for (const department of departments) {
          await conn.execute(
            `${dialect.insertIgnore} ${departmentTable} (event_id, ${departmentColumn}) VALUES (?, ?)`,
            [eventId, department],
          );
        }

        events.push({ id: eventId, title, event_date: eventDate });
        created += 1;
        current.setUTCDate(current.getUTCDate() + 7);
      }
    }
  });

  return { created, skipped, events };
}
