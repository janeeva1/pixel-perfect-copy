import { createFileRoute } from "@tanstack/react-router";
import { z } from "zod";
import { requireAdmin, requireSession } from "@/server/auth";
import { handleRoute, json, parse, readJson } from "@/server/http";
import { testSyncConnection } from "@/server/sync";

const settingsSchema = z.object({
  host: z.string().min(1, "Host is required"),
  port: z.number().int().positive().default(3306),
  user: z.string().min(1, "User is required"),
  password: z.string().optional(),
  database: z.string().min(1, "Database is required"),
});

export const Route = createFileRoute("/api/admin/sync/test")({
  server: {
    handlers: {
      POST: ({ request }) =>
        handleRoute(async () => {
          const session = await requireSession();
          await requireAdmin(session);
          const body = parse(settingsSchema, await readJson(request));
          return json(await testSyncConnection({ ...body, password: body.password ?? "" }));
        }),
    },
  },
});