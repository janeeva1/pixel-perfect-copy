import { createFileRoute } from "@tanstack/react-router";
import { getSession } from "@/server/auth";
import { handleRoute, json } from "@/server/http";

export const Route = createFileRoute("/api/auth/me")({
  server: {
    handlers: {
      GET: () =>
        handleRoute(async () => {
          const session = await getSession();
          if (!session) return json({ error: "You need to sign in first." }, 401);
          return json(session);
        }),
    },
  },
});
