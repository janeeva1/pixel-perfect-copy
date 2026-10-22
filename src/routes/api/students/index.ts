import { createFileRoute } from "@tanstack/react-router";
import { z } from "zod";
import { requireSession } from "@/server/auth";
import { handleRoute, json, parse } from "@/server/http";
import { listStudents } from "@/server/masters";
import type { StudentList } from "@/lib/types";

const listSchema = z.object({
  category: z.enum(["undergraduate", "postgraduate"]).optional(),
  level: z.string().trim().max(64).optional(),
  departmentCode: z.string().trim().max(120).optional(),
  search: z.string().trim().max(120).default(""),
  limit: z.coerce.number().int().min(1).max(500).default(200),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(200).default(200),
  sortBy: z.string().trim().max(32).optional(),
  sortDir: z.enum(["asc", "desc"]).optional(),
});

export const Route = createFileRoute("/api/students/")({
  server: {
    handlers: {
      GET: ({ request }) =>
        handleRoute(async () => {
          await requireSession();
          const params = parse(listSchema, Object.fromEntries(new URL(request.url).searchParams));
          const payload: StudentList = await listStudents({
            category: params.category ?? null,
            level: params.level ?? null,
            departmentCode: params.departmentCode ?? null,
            search: params.search,
            limit: params.limit,
            page: params.page,
            pageSize: params.pageSize,
            sortBy: params.sortBy,
            sortDir: params.sortDir,
          });
          return json(payload);
        }),
    },
  },
});
