import { createFileRoute } from "@tanstack/react-router";
import { requireEditor, requireSession } from "@/server/auth";
import { handleRoute, json } from "@/server/http";
import { generateEventsFromTemplate } from "@/server/recurring";

export const Route = createFileRoute("/api/recurring/$templateId/generate")({
  server: {
    handlers: {
      POST: ({ params }) =>
        handleRoute(async () => {
          const session = await requireSession();
          requireEditor(session);
          const result = await generateEventsFromTemplate(params.templateId);
          return json(result, 201);
        }),
    },
  },
});
