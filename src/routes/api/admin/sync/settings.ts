import { createFileRoute } from "@tanstack/react-router";
import { z } from "zod";
import { requireAdmin, requireSession } from "@/server/auth";
import { handleRoute, json, parse, readJson } from "@/server/http";
import { getSyncSettingsFromDB, hasSavedSyncPassword, setSyncSettings } from "@/server/sync";

const settingsSchema = z.object({
  host: z.string().min(1, "Host is required"),
  port: z.number().int().positive().default(3306),
  user: z.string().min(1, "User is required"),
  password: z.string().optional(),
  database: z.string().min(1, "Database is required"),
});

export const Route = createFileRoute("/api/admin/sync/settings")({
  server: {
    handlers: {
      GET: () =>
        handleRoute(async () => {
          const session = await requireSession();
          await requireAdmin(session);
          const settings = await getSyncSettingsFromDB();
          return json({
            host: settings?.host ?? "",
            port: settings?.port ?? 3306,
            user: settings?.user ?? "",
            database: settings?.database ?? "",
            hasPassword: await hasSavedSyncPassword(),
            configured: !!(settings?.host && settings?.database),
          });
        }),
      POST: ({ request }) =>
        handleRoute(async () => {
          const session = await requireSession();
          await requireAdmin(session);
          const body = parse(settingsSchema, await readJson(request));
          // A blank password keeps the saved one; see setSyncSettings.
          await setSyncSettings({ ...body, password: body.password ?? null });
          return json({ ok: true });
        }),
    },
  },
});
