import { createFileRoute } from "@tanstack/react-router";
import { createReadStream, statSync } from "node:fs";
import { basename } from "node:path";
import { Readable } from "node:stream";
import { findDesktopInstaller } from "@/server/desktop-release";
import { handleRoute, HttpError } from "@/server/http";

/**
 * Streams the installer to the browser.
 *
 * Streamed rather than read into memory: the file is 114 MB, and
 * `new Response(buffer)` would hold all of it in the server process at once.
 * The response is deliberately not cached, because the file is rebuilt and its
 * name carries the version, so a stale copy would be an old installer.
 */
export const Route = createFileRoute("/api/desktop/download")({
  server: {
    handlers: {
      GET: () =>
        handleRoute(async () => {
          const path = findDesktopInstaller();
          if (!path) {
            throw new HttpError(
              404,
              "No desktop installer has been built for this server. Run npm run electron:build.",
            );
          }

          const { size } = statSync(path);
          const body = Readable.toWeb(createReadStream(path)) as ReadableStream<Uint8Array>;

          return new Response(body, {
            headers: {
              "content-type": "application/vnd.microsoft.portable-executable",
              "content-length": String(size),
              "content-disposition": `attachment; filename="${basename(path)}"`,
              "cache-control": "no-store",
            },
          });
        }),
    },
  },
});
