import { createFileRoute } from "@tanstack/react-router";
import { z } from "zod";
import { requireSession } from "@/server/auth";
import { handleRoute, parse } from "@/server/http";
import { listStaff } from "@/server/masters";
import { toCsv } from "@/lib/attendance";

const downloadSchema = z.object({
  search: z.string().trim().max(120).default(""),
});

export const Route = createFileRoute("/api/staff/download")({
  server: {
    handlers: {
      GET: ({ request }) =>
        handleRoute(async () => {
          await requireSession();
          const params = parse(
            downloadSchema,
            Object.fromEntries(new URL(request.url).searchParams),
          );
          const { staff } = await listStaff({
            search: params.search,
            limit: 10000,
          });

          const rows = staff.map((person) => [
            person.full_name,
            person.staff_no ?? "—",
            person.faculty ?? "—",
            person.department ?? "—",
            person.admin_department ?? "—",
          ]);

          const csv = toCsv(
            ["Name", "Staff No", "Faculty", "Department", "Admin Department"],
            rows,
          );

          return new Response(csv, {
            headers: {
              "Content-Type": "text/csv; charset=utf-8",
              "Content-Disposition": `attachment; filename="staff_${new Date().toISOString().slice(0, 10)}.csv"`,
            },
          });
        }),
    },
  },
});
