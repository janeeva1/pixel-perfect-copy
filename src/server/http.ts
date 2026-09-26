import { ZodError, type ZodTypeAny, type output } from "zod";

/** An error with an HTTP status, thrown by route handlers and mapped by handleRoute. */
export class HttpError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = "HttpError";
    this.status = status;
  }
}

export function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

export function jsonError(message: string, status: number): Response {
  return json({ error: message }, status);
}

export async function readJson(request: Request): Promise<unknown> {
  try {
    return await request.json();
  } catch {
    throw new HttpError(400, "Request body must be valid JSON.");
  }
}

/** Validate an untrusted value, turning a failure into a 400 with the first message. */
export function parse<TSchema extends ZodTypeAny>(
  schema: TSchema,
  value: unknown,
): output<TSchema> {
  const result = schema.safeParse(value);
  if (!result.success) {
    throw new HttpError(400, result.error.issues[0]?.message ?? "Invalid request.");
  }
  return result.data;
}

/** Wraps a handler so thrown errors become tidy JSON responses. */
export async function handleRoute(run: () => Promise<Response>): Promise<Response> {
  try {
    return await run();
  } catch (error) {
    if (error instanceof HttpError) return jsonError(error.message, error.status);
    if (error instanceof ZodError) {
      return jsonError(error.issues[0]?.message ?? "Invalid request.", 400);
    }
    console.error(error);
    return jsonError("Something went wrong on the server.", 500);
  }
}
