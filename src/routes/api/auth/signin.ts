import { createFileRoute } from "@tanstack/react-router";
import { z } from "zod";
import { signIn } from "@/server/auth";
import { handleRoute, json, parse, readJson } from "@/server/http";

const bodySchema = z.object({
  email: z.string().trim().email("Enter a valid email address.").max(255),
  password: z.string().min(1, "Enter your password.").max(72),
});

export const Route = createFileRoute("/api/auth/signin")({
  server: {
    handlers: {
      POST: ({ request }) =>
        handleRoute(async () => {
          const body = parse(bodySchema, await readJson(request));
          return json(await signIn(body.email, body.password));
        }),
    },
  },
});
