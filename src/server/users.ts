import { randomUUID } from "node:crypto";
import { HttpError } from "@/server/http";
import { queryOne, transaction } from "@/server/db";
import type { RowDataPacket } from "./db";
import type { AppRole } from "@/lib/types";

type CountRow = RowDataPacket & { total: number };

/** Replaces a user's roles with a single role. Administrators only. */
export async function setUserRole(
  actorId: string,
  userId: string,
  role: AppRole,
): Promise<AppRole> {
  if (actorId === userId && role !== "admin") {
    throw new HttpError(400, "You cannot remove your own administrator role.");
  }

  const target = await queryOne<CountRow>("SELECT COUNT(*) AS total FROM users WHERE id = ?", [
    userId,
  ]);
  if (!target || target.total === 0) {
    throw new HttpError(404, "That user no longer exists.");
  }

  await transaction(async (connection) => {
    await connection.execute("DELETE FROM user_roles WHERE user_id = ?", [userId]);
    await connection.execute("INSERT INTO user_roles (id, user_id, role) VALUES (?, ?, ?)", [
      randomUUID(),
      userId,
      role,
    ]);
    await connection.execute(
      "INSERT INTO audit_logs (id, actor_id, action, entity, entity_id, details) VALUES (?, ?, ?, ?, ?, ?)",
      [randomUUID(), actorId, "user.role_changed", "users", userId, JSON.stringify({ role })],
    );
  });

  return role;
}
