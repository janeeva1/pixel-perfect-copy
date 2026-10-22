import { z } from "zod";

/**
 * Validation for the recurring template endpoints, in one place so the create
 * and update routes cannot drift apart.
 *
 * A schedule names every department expected on that day rather than one, so a
 * day covering three departments is a single event. The list is capped so a
 * pasted file cannot turn one schedule row into thousands of placeholders.
 */
const departmentsSchema = z
  .array(z.string().trim().min(1).max(120))
  .max(60, "At most 60 departments on one day")
  .nullable()
  .optional();

export const scheduleSchema = z.object({
  day_of_week: z.number().int().min(0).max(6),
  student_category: z.enum(["undergraduate", "postgraduate"]).nullable().optional(),
  level: z.string().trim().max(64).nullable().optional(),
  departments: departmentsSchema,
  title_suffix: z.string().trim().max(80).nullable().optional(),
});

const baseTemplateSchema = z.object({
  name: z.string().trim().min(1).max(160).optional(),
  description: z.string().trim().max(500).nullable().optional(),
  group_kind: z.enum(["student", "staff"]).optional(),
  /** Events generated from this template inherit it. */
  event_category: z.enum(["community_mass", "other"]).optional(),
  start_date: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .optional(),
  end_date: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .optional(),
  event_title_template: z.string().trim().min(1).max(160).optional(),
  start_time: z
    .string()
    .regex(/^\d{2}:\d{2}$/)
    .nullable()
    .optional(),
  end_time: z
    .string()
    .regex(/^\d{2}:\d{2}$/)
    .nullable()
    .optional(),
  notes: z.string().trim().max(1000).nullable().optional(),
  schedules: z.array(scheduleSchema).min(1, "At least one schedule entry required").optional(),
});

export const templateSchema = baseTemplateSchema
  .required({
    name: true,
    start_date: true,
    end_date: true,
    event_title_template: true,
    schedules: true,
  })
  .refine((data) => new Date(data.start_date) <= new Date(data.end_date), {
    message: "start_date must be before or equal to end_date",
    path: ["end_date"],
  });

export const updateSchema = baseTemplateSchema;

/** Validation for the event endpoints, which take the same department list. */
export const eventScopeSchema = z.object({
  departmentCodes: z
    .array(z.string().trim().min(1).max(120))
    .max(60, "At most 60 departments on one event")
    .nullable()
    .optional(),
  departments: z
    .array(z.string().trim().min(1).max(120))
    .max(60, "At most 60 departments on one event")
    .nullable()
    .optional(),
});
