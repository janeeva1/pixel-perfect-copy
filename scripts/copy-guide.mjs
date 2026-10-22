/**
 * Copy the user guide into the folder the desktop app is handed over in.
 *
 * The guide sits in the repository root, next to the README, and is not part
 * of the application itself, so the build does not pick it up on its own.
 * Without this step the folder would keep whatever copy of the guide was there
 * when it was last filled by hand, which is how the guide ended up still
 * describing version 1.0.0 after 1.1.0 had been built.
 */
import { copyFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const source = join(root, "HOW-TO-USE-THE-DESKTOP-APP.txt");
const targetDir = join(root, "dist-electron-build");

if (!existsSync(source)) {
  console.error(`No guide to copy: ${source}`);
  process.exit(1);
}

mkdirSync(targetDir, { recursive: true });
copyFileSync(source, join(targetDir, "HOW-TO-USE-THE-DESKTOP-APP.txt"));
console.log("Guide copied to dist-electron-build.");
