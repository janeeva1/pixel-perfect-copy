import { createFileRoute } from "@tanstack/react-router";
import { z } from "zod";
import { requireEditor, requireSession } from "@/server/auth";
import { handleRoute, json, parse, readJson } from "@/server/http";
import { forgetAnswer, savedAnswers } from "@/server/review";

const forgetSchema = z.object({
  kind: z.enum(["student", "staff"]),
  scanNumber: z.string(),
  nameKey: z.string(),
});

/**
 * GET ?kind=staff: the answers given in the review window.
 * POST {kind, scanNumber, nameKey}: take one back and match its scans again.
 */
export const Route = createFileRoute("/api/review/answers")({
  server: {
    handlers: {
      GET: ({ request }) =>
        handleRoute(async () => {
          await requireSession();
          const url = new URL(request.url);
          const kind = url.searchParams.get("kind") === "staff" ? "staff" : "student";
          return json(await savedAnswers(kind));
        }),
      POST: ({ request }) =>
        handleRoute(async () => {
          const session = await requireSession();
          requireEditor(session);
          const body = parse(forgetSchema, await readJson(request));
          return json(await forgetAnswer({ ...body, actorId: session.user.id }));
        }),
    },
  },
});
