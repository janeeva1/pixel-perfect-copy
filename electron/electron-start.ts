import { createStart, createCsrfMiddleware, createMiddleware } from "@tanstack/react-start";
import { loadServerEnv } from "../src/server/env";
import { renderErrorPage } from "../src/lib/error-page";

const errorMiddleware = createMiddleware().server(async ({ next }) => {
  try {
    return await next();
  } catch (error) {
    if (error != null && typeof error === "object" && "statusCode" in error) {
      throw error;
    }
    console.error(error);
    return new Response(renderErrorPage(), {
      status: 500,
      headers: { "content-type": "text/html; charset=utf-8" },
    });
  }
});

const csrfMiddleware = createCsrfMiddleware({
  filter: (ctx) => ctx.handlerType === "serverFn",
});

export async function startServer(options: { dbFile: string; port: number }) {
  loadServerEnv();
  process.env["DB_FILE"] = options.dbFile;
  process.env["DB_DRIVER"] = "sqlite";

  const instance = createStart(() => ({
    requestMiddleware: [errorMiddleware, csrfMiddleware],
    server: { port: options.port },
  }));
  const address = await (instance as unknown as { start: () => Promise<string> }).start();
  return { address };
}