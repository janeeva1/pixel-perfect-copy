import { createFileRoute } from "@tanstack/react-router";
import { handleRoute, json } from "@/server/http";
import { ensurePeerServices } from "@/server/peer";

/**
 * Called by the desktop app once its server is up, so a Main computer starts
 * listening, and a member starts its automatic sync, without anyone signing in.
 * It only starts what this computer's own settings already say; it changes
 * nothing.
 */
export const Route = createFileRoute("/api/peer/boot")({
  server: {
    handlers: {
      GET: () =>
        handleRoute(async () => {
          ensurePeerServices();
          return json({ ok: true });
        }),
    },
  },
});
