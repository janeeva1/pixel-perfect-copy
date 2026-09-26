import { createFileRoute } from "@tanstack/react-router";
import { requireEditor, requireSession } from "@/server/auth";
import { handleRoute, json, parse, readJson } from "@/server/http";
import { updateSchema } from "@/server/recurring-schema";
import {
  getRecurringTemplate,
  updateRecurringTemplate,
  deleteRecurringTemplate,
  generateEventsFromTemplate,
} from "@/server/recurring";
import type { UpdateRecurringTemplateInput } from "@/lib/types";

export const Route = createFileRoute("/api/recurring/$templateId")({
  server: {
    handlers: {
      GET: ({ params }) =>
        handleRoute(async () => {
          await requireSession();
          const template = await getRecurringTemplate(params.templateId);
          if (!template) throw new Error("Template not found");
          return json(template);
        }),
      PUT: ({ params, request }) =>
        handleRoute(async () => {
          const session = await requireSession();
          requireEditor(session);
          const body = parse(updateSchema, await readJson(request)) as UpdateRecurringTemplateInput;
          const template = await updateRecurringTemplate(params.templateId, body);
          return json(template);
        }),
      DELETE: ({ params }) =>
        handleRoute(async () => {
          const session = await requireSession();
          requireEditor(session);
          await deleteRecurringTemplate(params.templateId);
          return json({ ok: true });
        }),
    },
  },
});
