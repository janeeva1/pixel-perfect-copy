import { createFileRoute } from "@tanstack/react-router";
import { z } from "zod";
import { handleRoute, HttpError, json, parse, readJson } from "@/server/http";
import { createAccount, ensureDefaultAdmins, isSetupComplete } from "@/server/auth";
import { query } from "@/server/db";

const setupSchema = z.object({
  email: z.string().email(),
  password: z.string().min(8, "Password must be at least 8 characters"),
  fullName: z.string().max(120).optional(),
});

export const Route = createFileRoute("/api/setup")({
  server: {
    handlers: {
      GET: () =>
        handleRoute(async () => {
          await ensureDefaultAdmins();
          const complete = await isSetupComplete();
          return json({ complete });
        }),
      POST: ({ request }) =>
        handleRoute(async () => {
          const complete = await isSetupComplete();
          if (complete) throw new HttpError(409, "Setup is already complete.");
          const body = parse(setupSchema, await readJson(request));
          const me = await createAccount({
            email: body.email,
            password: body.password,
            fullName: body.fullName ?? null,
          });
          // Promote the newly created user to admin
          await query("UPDATE user_roles SET role = 'admin' WHERE user_id = ?", [me.user.id]);
          return json({ ok: true, me: { ...me, roles: ["admin"] } });
        }),
    },
  },
});
