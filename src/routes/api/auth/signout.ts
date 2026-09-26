import { createFileRoute } from "@tanstack/react-router";
import { endSession } from "@/server/auth";
import { handleRoute, json } from "@/server/http";

export const Route = createFileRoute("/api/auth/signout")({
  server: {
    handlers: {
      POST: () =>
        handleRoute(async () => {
          endSession();
          return json({ ok: true });
        }),
    },
  },
});
