import { createFileRoute } from "@tanstack/react-router";
import { z } from "zod";
import { requireSession } from "@/server/auth";
import { handleRoute, json, parse } from "@/server/http";
import { reportCsv, reportDetailCsv, studentReport, levelOptions } from "@/server/reports";
import { studentDepartments } from "@/server/masters";

const reportSchema = z.object({
  period: z.enum(["daily", "weekly", "monthly"]).default("daily"),
  from: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .optional(),
  to: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .optional(),
  groupBy: z.enum(["none", "department", "level", "category"]).default("none"),
  category: z.enum(["undergraduate", "postgraduate"]).optional(),
  level: z.string().trim().max(64).optional(),
  departmentCode: z.string().trim().max(120).optional(),
  eventId: z.string().uuid().optional(),
  format: z.enum(["json", "csv"]).default("json"),
  detail: z.enum(["summary", "present", "absent", "all"]).default("summary"),
});

function thisMonth() {
  const now = new Date();
  const first = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const last = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 0));
  return { from: first.toISOString().slice(0, 10), to: last.toISOString().slice(0, 10) };
}

export const Route = createFileRoute("/api/reports/students")({
  server: {
    handlers: {
      GET: async ({ request }) =>
        // handleRoute wraps the whole body, validation and query included. Without
        // it a bad filter escapes as an HTML 500 from the framework instead of the
        // JSON 400 the client expects, and a SQL failure is logged nowhere useful.
        handleRoute(async () => {
          await requireSession();
          const params = parse(reportSchema, Object.fromEntries(new URL(request.url).searchParams));
          const fallback = thisMonth();
          const series = await studentReport({
            period: params.period,
            from: params.from ?? fallback.from,
            to: params.to ?? fallback.to,
            groupBy: params.groupBy,
            category: params.category ?? null,
            level: params.level ?? null,
            departmentCode: params.departmentCode ?? null,
            eventId: params.eventId ?? null,
          });

          if (params.format === "csv") {
            if (params.detail === "summary") {
              return new Response(reportCsv(series, "student"), {
                headers: {
                  "content-type": "text/csv; charset=utf-8",
                  "content-disposition": `attachment; filename="student-attendance-${series.from}-${series.to}.csv"`,
                },
              });
            }
            const [levels, departments] = await Promise.all([levelOptions(), studentDepartments()]);
            const csv = await reportDetailCsv(
              {
                period: params.period,
                from: params.from ?? fallback.from,
                to: params.to ?? fallback.to,
                groupBy: params.groupBy,
                eventId: params.eventId ?? null,
                scope: {
                  category: params.category ?? null,
                  level: params.level ?? null,
                  departmentCode: params.departmentCode ?? null,
                },
                group: "student",
                levels,
                departments,
              },
              params.detail,
            );
            return new Response(csv, {
              headers: {
                "content-type": "text/csv; charset=utf-8",
                "content-disposition": `attachment; filename="student-attendance-${params.detail}-${series.from}-${series.to}.csv"`,
              },
            });
          }
          return json(series);
        }),
    },
  },
});
