/**
 * Find the Windows installer that `npm run electron:build` produced, so the
 * landing page can offer it as a download.
 *
 * The installer is deliberately NOT shipped inside the app: it is 114 MB, and
 * bundling it would mean every install carried a second copy of itself. So this
 * looks for it next to the running app instead, and reports honestly when it is
 * not there. The packaged desktop build therefore shows no download button, and
 * neither does a hosted deployment that was not given one.
 *
 * Set DESKTOP_INSTALLER_PATH to point at a specific file, which is what a
 * deployment should do, since its build output may not sit in the project root.
 */
import { existsSync, readdirSync, statSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";

/** Where electron:build writes, relative to the project root. */
const BUILD_OUTPUT_DIR = "dist-electron-build";

/** The installer is preferred over the portable build: one file, no install. */
function isInstaller(name: string): boolean {
  return /\.exe$/i.test(name) && /setup/i.test(name);
}

function isPortable(name: string): boolean {
  return /\.exe$/i.test(name) && /portable/i.test(name);
}

function searchOutputDir(dir: string): string | null {
  if (!existsSync(dir)) return null;

  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return null;
  }

  // The block map and the yaml are build byproducts, not downloads. Sorting by
  // modification time means a rebuild is picked up without a code change.
  const pick = (matches: (name: string) => boolean) =>
    names
      .filter(matches)
      .map((name) => join(dir, name))
      .filter((file) => statSync(file).isFile())
      .sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs)[0] ?? null;

  return pick(isInstaller) ?? pick(isPortable);
}

/** Absolute path of the installer to offer, or null when there is not one. */
export function findDesktopInstaller(): string | null {
  const override = process.env["DESKTOP_INSTALLER_PATH"];
  if (override) {
    const explicit = isAbsolute(override) ? override : resolve(process.cwd(), override);
    return existsSync(explicit) ? explicit : null;
  }

  return searchOutputDir(resolve(process.cwd(), BUILD_OUTPUT_DIR));
}

export type DesktopRelease = {
  available: boolean;
  fileName: string | null;
  sizeBytes: number | null;
};

const MISSING: DesktopRelease = { available: false, fileName: null, sizeBytes: null };

/** The same information, safe to send to the browser. */
export function describeDesktopRelease(): DesktopRelease {
  const path = findDesktopInstaller();
  if (!path) return MISSING;
  return {
    available: true,
    fileName: path.split(/[\\/]/).pop() ?? null,
    sizeBytes: statSync(path).size,
  };
}
