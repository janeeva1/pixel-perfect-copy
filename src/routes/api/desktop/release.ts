import { createFileRoute } from "@tanstack/react-router";
import { describeDesktopRelease } from "@/server/desktop-release";
import { handleRoute, json } from "@/server/http";

/**
 * Public, because the landing page is public. It only says whether an installer
 * exists and what it is called, never where on the server it lives.
 */
export const Route = createFileRoute("/api/desktop/release")({
  server: {
    handlers: {
      GET: () =>
        handleRoute(async () => {
          return json(describeDesktopRelease());
        }),
    },
  },
});
