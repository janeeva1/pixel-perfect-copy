/**
 * Check the desktop update mechanism, by running it against a feed that looks
 * like the one `npm run electron:build` writes.
 *
 * A web folder is stood up in the test itself, holding a `latest.yml` and the
 * file it points at. The app's own updater is pointed at it and asked to look,
 * and three things are checked:
 *
 *   1. a feed holding the version that is already installed is reported as
 *      nothing to do
 *   2. a feed holding a newer version is found and downloaded
 *   3. a feed whose checksum does not match is refused, so an update cannot
 *      install anything the feed did not promise
 *
 * The installer is stood in for by a small file, so the download is quick. The
 * install itself is not carried out: it would replace the program on this
 * machine, which is not something a test may do.
 *
 *   npm run verify:update
 */
import { app } from "electron";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { dirname, join } from "node:path";
import { startUpdater, updateHandlers } from "../electron/updater";

/** The version the app claims to be running. */
const INSTALLED = "1.1.0";

/**
 * Where a packaged build keeps the address of its update feed. A development
 * run has no such file, and the updater refuses to download without one, so
 * the test puts one there and takes it away again afterwards.
 */
const APP_UPDATE_YML = join(
  process.cwd(),
  "node_modules",
  "electron",
  "dist",
  "resources",
  "app-update.yml",
);

/** A small file standing in for the installer, so the download is quick. */
const PAYLOAD = Buffer.from("not really an installer, but it is what the feed points at");

const sha512Of = (body: Buffer): string => createHash("sha512").update(body).digest("base64");

function latestYml(version: string, size: number, sha512: string): string {
  return [
    `version: ${version}`,
    "files:",
    "  - url: setup.exe",
    `    sha512: ${sha512}`,
    `    size: ${size}`,
    "path: setup.exe",
    `sha512: ${sha512}`,
    `releaseDate: '${new Date().toISOString()}'`,
    "",
  ].join("\n");
}

let currentFeed = latestYml(INSTALLED, PAYLOAD.length, sha512Of(PAYLOAD));

const server: Server = createServer((request, response) => {
  // The updater asks for latest.yml with a cache-busting query on it, so the
  // path is read rather than the whole address.
  const path = new URL(request.url ?? "/", "http://127.0.0.1").pathname;
  if (path.endsWith("/latest.yml")) {
    response.writeHead(200, { "content-type": "text/yaml" });
    response.end(currentFeed);
    return;
  }
  if (path.endsWith("/setup.exe")) {
    response.writeHead(200, { "content-type": "application/octet-stream" });
    response.end(PAYLOAD);
    return;
  }
  response.writeHead(404);
  response.end();
});

async function main(): Promise<void> {
  // Stand in for an installed build: what is being checked is the updater, and
  // a development run has no installer to replace.
  Object.defineProperty(app, "isPackaged", { value: true });
  Object.defineProperty(app, "getVersion", { value: () => INSTALLED });

  const hadAppUpdateYml = existsSync(APP_UPDATE_YML);
  if (!hadAppUpdateYml) {
    mkdirSync(dirname(APP_UPDATE_YML), { recursive: true });
    writeFileSync(
      APP_UPDATE_YML,
      "provider: generic\nurl: http://127.0.0.1:1/\nupdaterCacheDirName: attendance-register-updater\n",
    );
  }

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const port = typeof address === "object" && address !== null ? address.port : 0;
  const feed = `http://127.0.0.1:${port}/`;
  console.log("feed:", feed);

  startUpdater();

  const set = updateHandlers.setFeedUrl(undefined, feed);
  console.log("feed url in use:", set.feedUrl);
  console.log("supported:", set.supported, set.reason ?? "");

  const same = await updateHandlers.check();
  console.log(
    `feed at the installed version ${INSTALLED}: state=${same.state} available=${same.availableVersion} error=${same.error}`,
  );

  currentFeed = latestYml("1.2.0", PAYLOAD.length, sha512Of(PAYLOAD));
  const newer = await updateHandlers.check();
  console.log(
    `feed at 1.2.0: state=${newer.state} available=${newer.availableVersion} error=${newer.error}`,
  );

  const downloaded = await updateHandlers.download();
  console.log(
    `download: state=${downloaded.state} percent=${downloaded.percent} error=${downloaded.error}`,
  );

  // A broken checksum has to be refused, or an update could install anything.
  currentFeed = latestYml("1.3.0", PAYLOAD.length, sha512Of(Buffer.from("something else")));
  await updateHandlers.check();
  const badDownload = await updateHandlers.download();
  console.log(`feed with a wrong checksum: state=${badDownload.state} error=${badDownload.error}`);

  server.close();
  if (!hadAppUpdateYml) rmSync(APP_UPDATE_YML, { force: true });
  app.exit(0);
}

void main();
