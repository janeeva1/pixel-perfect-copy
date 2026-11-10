import { createFileRoute } from "@tanstack/react-router";
import { z } from "zod";
import type { RowDataPacket } from "@/server/db";
import { requireAdmin, requireSession } from "@/server/auth";
import { dialect, query } from "@/server/db";
import { handleRoute, json, parse, readJson } from "@/server/http";
import { HttpError } from "@/server/http";
import type { AppRole, AppUser } from "@/lib/types";

type UserListRow = RowDataPacket & {
  id: string;
  email: string;
  full_name: string | null;
  created_at: string;
  roles: string | null;
};

export const Route = createFileRoute("/api/users/")({
  server: {
    handlers: {
      GET: () =>
        handleRoute(async () => {
          const session = await requireSession();
          requireAdmin(session);

          const rows = await query<UserListRow>(
            `SELECT u.id, u.email, u.full_name,
                    ${dialect.dateTime("u.created_at")} AS created_at,
                    ${dialect.groupConcat("r.role")} AS roles
                 FROM users u
                 LEFT JOIN user_roles r ON r.user_id = u.id
                 GROUP BY u.id, u.email, u.full_name, u.created_at
                 ORDER BY u.created_at`,
          );

          const users: AppUser[] = rows.map((row) => ({
            id: row.id,
            email: row.email,
            fullName: row.full_name,
            roles: (row.roles ? row.roles.split(",") : []) as AppRole[],
            createdAt: row.created_at,
          }));
          return json({ users });
        }),
      DELETE: ({ request }) =>
        handleRoute(async () => {
          const session = await requireSession();
          requireAdmin(session);

          const { userId } = await parse(
            z.object({ userId: z.string().uuid() }),
            await readJson(request),
          );

          if (userId === session.user.id) {
            throw new HttpError(400, "You cannot delete your own account.");
          }

          await query("DELETE FROM users WHERE id = ?", [userId]);
          return json({ ok: true });
        }),
    },
  },
});
