import { createFileRoute } from "@tanstack/react-router";
import { z } from "zod";
import { requireEditor, requireSession } from "@/server/auth";
import { handleRoute, json, parse, readJson } from "@/server/http";
import { resolvePair } from "@/server/review";

const bodySchema = z.object({
  kind: z.enum(["student", "staff"]),
  presentId: z.string().min(1),
  absentId: z.string().min(1),
  same: z.boolean(),
});

/** Same person (merge the two records) or different people (remember it). */
export const Route = createFileRoute("/api/review/pair")({
  server: {
    handlers: {
      POST: ({ request }) =>
        handleRoute(async () => {
          const session = await requireSession();
          requireEditor(session);
          const body = parse(bodySchema, await readJson(request));
          return json(await resolvePair({ ...body, actorId: session.user.id }));
        }),
    },
  },
});
