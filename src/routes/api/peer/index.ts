import { createFileRoute } from "@tanstack/react-router";
import { z } from "zod";
import { requireAdmin, requireSession } from "@/server/auth";
import { handleRoute, json, parse, readJson } from "@/server/http";
import { becomeMain, joinMain, leaveSync, peerStatus, renameDevice } from "@/server/peer";

const actionSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("main") }),
  z.object({ action: z.literal("join"), address: z.string().min(1), code: z.string().min(1) }),
  z.object({ action: z.literal("leave") }),
  z.object({ action: z.literal("rename"), name: z.string() }),
]);

/**
 * Sync between computers. GET: this computer's part and state. POST (admin):
 * {action: "main"} | {action: "join", address, code} | {action: "leave"} |
 * {action: "rename", name}.
 */
export const Route = createFileRoute("/api/peer/")({
  server: {
    handlers: {
      GET: () =>
        handleRoute(async () => {
          await requireSession();
          return json(peerStatus());
        }),
      POST: ({ request }) =>
        handleRoute(async () => {
          const session = await requireSession();
          requireAdmin(session);
          const body = parse(actionSchema, await readJson(request));
          if (body.action === "main") return json(becomeMain());
          if (body.action === "join") {
            return json(await joinMain({ address: body.address, code: body.code }));
          }
          if (body.action === "rename") return json(renameDevice(body.name));
          return json(leaveSync());
        }),
    },
  },
});
