import { createFileRoute } from "@tanstack/react-router";
import { z } from "zod";
import { createAccount } from "@/server/auth";
import { handleRoute, json, parse, readJson } from "@/server/http";

const bodySchema = z.object({
  email: z.string().trim().email("Enter a valid email address.").max(255),
  password: z
    .string()
    .min(8, "Use a password of at least 8 characters.")
    .max(72, "Passwords are limited to 72 characters."),
  fullName: z.string().trim().max(120).optional(),
});

export const Route = createFileRoute("/api/auth/signup")({
  server: {
    handlers: {
      POST: ({ request }) =>
        handleRoute(async () => {
          const body = parse(bodySchema, await readJson(request));
          const me = await createAccount({
            email: body.email,
            password: body.password,
            fullName: body.fullName?.trim() ? body.fullName.trim() : null,
          });
          return json(me, 201);
        }),
    },
  },
});
