import { createFileRoute } from "@tanstack/react-router";
import { z } from "zod";
import { requireEditor, requireSession } from "@/server/auth";
import { setEventStatus } from "@/server/events";
import { handleRoute, json, parse, readJson } from "@/server/http";

const bodySchema = z.object({
  status: z.enum(["draft", "finalized"]),
});

export const Route = createFileRoute("/api/staff-events/$eventId/status")({
  server: {
    handlers: {
      POST: ({ params, request }) =>
        handleRoute(async () => {
          const session = await requireSession();
          requireEditor(session);
          const body = parse(bodySchema, await readJson(request));
          return json(await setEventStatus("staff", params.eventId, body.status));
        }),
    },
  },
});
