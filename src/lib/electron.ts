/**
 * The desktop app's own bridge to the program it runs in.
 *
 * The same page is served to a browser and to the desktop window, so everything
 * here has to cope with the bridge not being there at all. A hosted
 * deployment has no program to update; a development run has no installer.
 * The Update section asks this module what it can do rather than reaching for
 * `window.electronAPI` and hoping.
 */

export type UpdateState =
  "idle" | "checking" | "available" | "not-available" | "downloading" | "downloaded" | "error";

export type UpdateStatus = {
  /** Whether this build can update itself at all. */
  supported: boolean;
  /** Why it cannot, when it cannot. */
  reason: string | null;
  /** The version running now. */
  currentVersion: string;
  /** Where a newer build is looked for. */
  feedUrl: string;
  state: UpdateState;
  /** The version found in the feed, when there is one. */
  availableVersion: string | null;
  releaseNotes: string | null;
  /** How much of the download has arrived, 0 to 100. */
  percent: number;
  transferred: number;
  total: number;
  error: string | null;
};

export type UpdateEvent = {
  type: "status" | "progress";
  status: UpdateStatus;
};

export type DesktopBridge = {
  saveDialog: (options: unknown) => Promise<unknown>;
  openDialog: (options: unknown) => Promise<unknown>;
  openExternal: (url: string) => Promise<void>;
  platform: string;
  /** The version of the app that is running. */
  version: string;
  update: {
    status: () => Promise<UpdateStatus>;
    check: () => Promise<UpdateStatus>;
    download: () => Promise<UpdateStatus>;
    install: () => Promise<UpdateStatus>;
    setFeedUrl: (url: string) => Promise<UpdateStatus>;
    onEvent: (listener: (event: UpdateEvent) => void) => () => void;
  };
};

declare global {
  interface Window {
    electronAPI?: DesktopBridge;
  }
}

/** The desktop bridge, or null when this page is not in the desktop window. */
export function desktopBridge(): DesktopBridge | null {
  if (typeof window === "undefined") return null;
  return window.electronAPI ?? null;
}

/** Whether this page is running inside the desktop app. */
export function isDesktopApp(): boolean {
  return desktopBridge() !== null;
}
