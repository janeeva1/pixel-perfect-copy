import { createFileRoute } from "@tanstack/react-router";
import { z } from "zod";
import { requireEditor, requireSession } from "@/server/auth";
import { handleRoute, json, parse, readJson } from "@/server/http";
import { setStudentCurrentList } from "@/server/masters";

const bodySchema = z.object({
  matricNumbers: z.array(z.string().trim().min(1).max(64)).min(1).max(50000),
});

/**
 * After a student import marked "complete list": the matric numbers of every
 * student in the file. Everyone else stops being expected (src/server/masters.ts).
 */
export const Route = createFileRoute("/api/students/current-list")({
  server: {
    handlers: {
      POST: ({ request }) =>
        handleRoute(async () => {
          const session = await requireSession();
          requireEditor(session);
          const body = parse(bodySchema, await readJson(request));
          return json(await setStudentCurrentList(body.matricNumbers, session.user.id));
        }),
    },
  },
});
