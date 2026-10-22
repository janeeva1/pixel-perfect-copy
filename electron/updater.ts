/**
 * Application updates for the desktop build.
 *
 * An install has to be able to move to a newer build on its own, without the
 * person who owns it having to download and install anything by hand. So the
 * Update section of the app asks this module to look for a newer build,
 * download it and install it.
 *
 * The feed is a plain web directory holding what `npm run electron:build`
 * writes: `latest.yml`, the installer and its block map. Where that directory
 * lives is a setting rather than a constant, because the app may be installed
 * on a machine that has never heard of the server that hosts it; the address
 * can be typed into the Update section and is remembered per install.
 *
 * Everything here runs in the main process. The window asks for it over IPC,
 * because that is the only place with the rights to replace the program on
 * disk and to restart it.
 */
import { app, BrowserWindow, ipcMain } from "electron";
import { autoUpdater } from "electron-updater";
import { readDesktopConfig, writeDesktopConfig } from "./config";

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

const status: UpdateStatus = {
  supported: false,
  reason: null,
  currentVersion: "",
  feedUrl: "",
  state: "idle",
  availableVersion: null,
  releaseNotes: null,
  percent: 0,
  transferred: 0,
  total: 0,
  error: null,
};

/**
 * Why this build cannot update itself.
 *
 * A development run has no installer to replace, so there is nothing to update
 * to. The portable build is a single file that runs from wherever it was
 * opened, so it cannot replace itself either; the setup version can.
 */
function unsupportedReason(): string | null {
  if (!app.isPackaged) {
    return "This is a development run, so there is no installed program to update.";
  }
  if (process.env["PORTABLE_EXECUTABLE_FILE"]) {
    return "This is the portable build, which runs from wherever it was opened and cannot update itself. Install the setup version to be able to update.";
  }
  return null;
}

/** The address of the feed, from the setting, then the environment. */
function feedUrl(): string {
  const saved = readDesktopConfig().updateFeedUrl?.trim();
  if (saved) return saved;
  return (process.env["DESKTOP_UPDATE_URL"] ?? "").trim();
}

/** Tell the window, if there is one, that something changed. */
function publish(type: UpdateEvent["type"] = "status"): void {
  const payload: UpdateEvent = { type, status: { ...status } };
  for (const window of BrowserWindow.getAllWindows()) {
    if (!window.isDestroyed()) window.webContents.send("update:event", payload);
  }
}

function setState(next: Partial<UpdateStatus>): void {
  Object.assign(status, next);
  publish();
}

/**
 * Point the updater at the feed.
 *
 * The address is only set when there is one: with no address the updater falls
 * back to the one written into the build, which is what a fresh install should
 * use before anyone has typed anything.
 */
function applyFeed(): void {
  const url = feedUrl();
  status.feedUrl = url;
  if (!url) return;
  try {
    autoUpdater.setFeedURL({ provider: "generic", url: url.endsWith("/") ? url : `${url}/` });
  } catch (error) {
    setState({ error: `The update address is not usable: ${describe(error)}` });
  }
}

function describe(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

/** Wire the updater to its events. Called once, when the app is ready. */
export function startUpdater(): void {
  status.currentVersion = app.getVersion();
  status.supported = unsupportedReason() === null;
  status.reason = unsupportedReason();

  autoUpdater.autoDownload = false; // the Update section decides when to fetch
  autoUpdater.autoInstallOnAppQuit = true; // a download that finished installs on the way out
  autoUpdater.logger = null;

  applyFeed();

  autoUpdater.on("checking-for-update", () => {
    setState({ state: "checking", error: null, percent: 0 });
  });

  autoUpdater.on("update-available", (info) => {
    setState({
      state: "available",
      availableVersion: info.version,
      releaseNotes: typeof info.releaseNotes === "string" ? info.releaseNotes : null,
      error: null,
    });
  });

  autoUpdater.on("update-not-available", () => {
    setState({ state: "not-available", availableVersion: null, error: null });
  });

  autoUpdater.on("download-progress", (progress) => {
    status.percent = Math.round(progress.percent);
    status.transferred = progress.transferred;
    status.total = progress.total;
    status.state = "downloading";
    publish("progress");
  });

  autoUpdater.on("update-downloaded", (info) => {
    setState({ state: "downloaded", availableVersion: info.version, percent: 100, error: null });
  });

  autoUpdater.on("error", (error) => {
    setState({ state: "error", error: describe(error) });
  });
}

/** Register the handlers the window calls. */
export function registerUpdateHandlers(): void {
  ipcMain.handle("update:status", updateHandlers.status);
  ipcMain.handle("update:setFeedUrl", updateHandlers.setFeedUrl);
  ipcMain.handle("update:check", updateHandlers.check);
  ipcMain.handle("update:download", updateHandlers.download);
  ipcMain.handle("update:install", updateHandlers.install);
}

/**
 * The handlers themselves, kept apart from the wiring so they can be called
 * directly. The window goes through IPC; a test goes through these.
 */
export const updateHandlers = {
  status: (): UpdateStatus => ({ ...status }),

  setFeedUrl: (_event: unknown, url: unknown): UpdateStatus => {
    const value = typeof url === "string" ? url.trim() : "";
    writeDesktopConfig({ updateFeedUrl: value });
    applyFeed();
    return { ...status };
  },

  check: async (): Promise<UpdateStatus> => {
    if (!status.supported) {
      setState({ state: "error", error: status.reason });
      return { ...status };
    }
    if (!feedUrl()) {
      setState({
        state: "error",
        error:
          "No update address is set. Type the address of the update folder in the Update section first.",
      });
      return { ...status };
    }
    try {
      await autoUpdater.checkForUpdates();
    } catch (error) {
      setState({ state: "error", error: describe(error) });
    }
    return { ...status };
  },

  download: async (): Promise<UpdateStatus> => {
    if (!status.supported) {
      setState({ state: "error", error: status.reason });
      return { ...status };
    }
    try {
      setState({ state: "downloading", error: null, percent: 0 });
      await autoUpdater.downloadUpdate();
    } catch (error) {
      setState({ state: "error", error: describe(error) });
    }
    return { ...status };
  },

  install: (): UpdateStatus => {
    // Replace the program and start it again. `isSilent = false` and
    // `isForceRunAfter = true`: the person is told what is happening, and the
    // new version starts by itself.
    setState({ state: "downloaded" });
    autoUpdater.quitAndInstall(false, true);
    return { ...status };
  },
};
