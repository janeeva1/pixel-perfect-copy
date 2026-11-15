import { createFileRoute } from "@tanstack/react-router";
import { requireSession } from "@/server/auth";
import { handleRoute, json } from "@/server/http";
import { discoverMain } from "@/server/peer";

/** Look for a Main computer on the office network (about two seconds). */
export const Route = createFileRoute("/api/peer/discover")({
  server: {
    handlers: {
      GET: () =>
        handleRoute(async () => {
          await requireSession();
          return json(await discoverMain());
        }),
    },
  },
});
