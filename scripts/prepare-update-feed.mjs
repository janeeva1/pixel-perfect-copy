/**
 * Gather the files the updater needs into one folder, ready to be uploaded.
 *
 * The updater looks for a folder on the web holding:
 *
 *   latest.yml      what the newest version is, and its checksum
 *   the installer   the file that latest.yml points at
 *   the .blockmap   the same file, cut into pieces, so a partial download can
 *                   be resumed rather than started again
 *
 * electron-builder writes all three into "dist-electron-build" when it builds
 * the installer. This script collects them into "dist-update-feed", and writes
 * a short note saying which address the folder has to be served from.
 *
 *   npm run update:prepare
 *
 * The folder still has to be put on the web yourself - see the note it writes,
 * and section 8 of HOW-TO-USE-THE-DESKTOP-APP.txt.
 */
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const buildDir = join(root, "dist-electron-build");
const feedDir = join(root, "dist-update-feed");
const packageJson = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
const version = packageJson.version;

const latestYml = join(buildDir, "latest.yml");
if (!existsSync(latestYml)) {
  console.error(
    `No latest.yml in ${buildDir}. Run "npm run electron:build" before preparing the feed.`,
  );
  process.exit(1);
}

mkdirSync(feedDir, { recursive: true });

const manifest = readFileSync(latestYml, "utf8");
// The file is listed as "  - url: <name>" under "files:".
const installerName = manifest.match(/^\s*-\s*url:\s*(.+)$/m)?.[1]?.trim();

const wanted = ["latest.yml", installerName, `${installerName}.blockmap`].filter(Boolean);
const missing = wanted.filter((name) => !existsSync(join(buildDir, name)));

if (missing.length > 0) {
  console.error(`Missing from ${buildDir}: ${missing.join(", ")}`);
  process.exit(1);
}

for (const name of wanted) {
  copyFileSync(join(buildDir, name), join(feedDir, name));
  console.log(`  ${name}`);
}

const feedUrl =
  packageJson.build?.publish?.find((entry) => entry.provider === "generic")?.url ??
  "https://updates.example.com/attendance-register/";

writeFileSync(
  join(feedDir, "READ-ME-FIRST.txt"),
  [
    "================================================================================",
    "ATTENDANCE REGISTER - UPDATE FILES",
    `Version ${version}`,
    "================================================================================",
    "",
    "Put every file in this folder on the web, at one address, and give that",
    "address to the app in Admin Settings > Application Update.",
    "",
    "The address must end with a slash, for example:",
    "",
    `  ${feedUrl}`,
    "",
    "If the app is already installed on a machine, that address can also be set",
    "by hand in the file desktop.json in the app's data folder, or by setting the",
    "environment variable DESKTOP_UPDATE_URL.",
    "",
    "Do not rename the files. latest.yml points at the installer by name, and the",
    "installer must stay next to it, along with its .blockmap.",
    "",
    "To publish a new version: run npm run electron:build, then npm run",
    "update:prepare, then upload this folder again.",
    "",
    "================================================================================",
    "",
  ].join("\n"),
);

console.log(`\nFeed files are in ${feedDir}.`);
console.log(`Serve them at: ${feedUrl}`);
