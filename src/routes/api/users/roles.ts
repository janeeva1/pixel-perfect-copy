import { createFileRoute } from "@tanstack/react-router";
import { z } from "zod";
import { requireAdmin, requireSession } from "@/server/auth";
import { handleRoute, json, parse, readJson } from "@/server/http";
import { setUserRole } from "@/server/users";

const bodySchema = z.object({
  userId: z.string().trim().min(1).max(36),
  role: z.enum(["admin", "operator", "viewer"]),
});

export const Route = createFileRoute("/api/users/roles")({
  server: {
    handlers: {
      POST: ({ request }) =>
        handleRoute(async () => {
          const session = await requireSession();
          requireAdmin(session);
          const body = parse(bodySchema, await readJson(request));
          const role = await setUserRole(session.user.id, body.userId, body.role);
          return json({ role });
        }),
    },
  },
});
