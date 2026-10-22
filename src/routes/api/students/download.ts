import { createFileRoute } from "@tanstack/react-router";
import { z } from "zod";
import { requireSession } from "@/server/auth";
import { handleRoute, parse } from "@/server/http";
import { listStudents } from "@/server/masters";
import { toCsv } from "@/lib/attendance";

const downloadSchema = z.object({
  category: z.enum(["undergraduate", "postgraduate"]).optional(),
  level: z.string().trim().max(64).optional(),
  departmentCode: z.string().trim().max(120).optional(),
  search: z.string().trim().max(120).default(""),
});

export const Route = createFileRoute("/api/students/download")({
  server: {
    handlers: {
      GET: ({ request }) =>
        handleRoute(async () => {
          await requireSession();
          const params = parse(
            downloadSchema,
            Object.fromEntries(new URL(request.url).searchParams),
          );
          const { students } = await listStudents({
            category: params.category ?? null,
            level: params.level ?? null,
            departmentCode: params.departmentCode ?? null,
            search: params.search,
            limit: 10000,
          });

          const rows = students.map((student) => [
            student.full_name,
            student.matric_no,
            student.student_category ?? "—",
            student.level ?? "—",
            student.department ?? student.department_code ?? "—",
            student.marital_status ?? "—",
          ]);

          const csv = toCsv(
            ["Name", "Matric No", "Category", "Level", "Department", "Marital Status"],
            rows,
          );

          return new Response(csv, {
            headers: {
              "Content-Type": "text/csv; charset=utf-8",
              "Content-Disposition": `attachment; filename="students_${new Date().toISOString().slice(0, 10)}.csv"`,
            },
          });
        }),
    },
  },
});
