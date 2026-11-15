import { createFileRoute } from "@tanstack/react-router";
import { z } from "zod";
import { requireAdmin, requireSession } from "@/server/auth";
import { debtRates, setDebtRates } from "@/server/debts";
import { handleRoute, json, parse, readJson } from "@/server/http";

const bodySchema = z.object({
  staff: z.number().int().min(0),
  student: z.number().int().min(0),
});

/** What one Mass absence costs. GET for everyone; POST (admin) to change it. */
export const Route = createFileRoute("/api/debts/rates")({
  server: {
    handlers: {
      GET: () =>
        handleRoute(async () => {
          await requireSession();
          return json(await debtRates());
        }),
      POST: ({ request }) =>
        handleRoute(async () => {
          const session = await requireSession();
          requireAdmin(session);
          const body = parse(bodySchema, await readJson(request));
          return json(await setDebtRates(body, session.user.id));
        }),
    },
  },
});
