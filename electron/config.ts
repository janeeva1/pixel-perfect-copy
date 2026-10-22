/**
 * The small file each install keeps beside its database.
 *
 * It holds the two things that must be the same on one machine and are not
 * worth asking about twice: the session secret that signs users in, and the
 * address of the update feed this install updates from.
 *
 * It lives in the user's data directory, not beside the program, so it survives
 * an update: a new build is installed over the old one and keeps talking to the
 * same database and the same users.
 */
import { app } from "electron";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

export type DesktopConfig = {
  /** Signs session cookies. Generated once per install. */
  sessionSecret?: string;
  /** Where this install looks for a newer build. */
  updateFeedUrl?: string;
};

export function desktopConfigPath(): string {
  return join(app.getPath("userData"), "desktop.json");
}

/** The saved settings, or an empty set when there are none yet. */
export function readDesktopConfig(): DesktopConfig {
  try {
    const saved = JSON.parse(readFileSync(desktopConfigPath(), "utf8")) as unknown;
    if (saved && typeof saved === "object") return saved as DesktopConfig;
  } catch {
    // No saved settings yet, or the file is unreadable: start from nothing.
  }
  return {};
}

/** Save the settings, merging with what is already there. */
export function writeDesktopConfig(changes: DesktopConfig): DesktopConfig {
  const merged = { ...readDesktopConfig(), ...changes };
  const file = desktopConfigPath();
  try {
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, JSON.stringify(merged, null, 2));
  } catch {
    // A setting that cannot be saved is not a reason to fail the app.
  }
  return merged;
}
