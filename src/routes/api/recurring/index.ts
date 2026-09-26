import { createFileRoute } from "@tanstack/react-router";
import { requireEditor, requireSession } from "@/server/auth";
import { handleRoute, json, parse, readJson } from "@/server/http";
import { templateSchema } from "@/server/recurring-schema";
import {
  listRecurringTemplates,
  getRecurringTemplate,
  createRecurringTemplate,
  updateRecurringTemplate,
  deleteRecurringTemplate,
  generateEventsFromTemplate,
} from "@/server/recurring";
import type { RecurringTemplateInput, UpdateRecurringTemplateInput } from "@/lib/types";

export const Route = createFileRoute("/api/recurring/")({
  server: {
    handlers: {
      GET: ({ request }) =>
        handleRoute(async () => {
          await requireSession();
          const templates = await listRecurringTemplates();
          return json(templates);
        }),
      POST: ({ request }) =>
        handleRoute(async () => {
          const session = await requireSession();
          requireEditor(session);
          const body = parse(templateSchema, await readJson(request)) as RecurringTemplateInput;
          const template = await createRecurringTemplate(body, session.user.id);
          return json(template, 201);
        }),
    },
  },
});
