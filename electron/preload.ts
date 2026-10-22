import { readFileSync } from "node:fs";
import { join } from "node:path";
import { contextBridge, ipcRenderer } from "electron";

/**
 * The version of the app that is running.
 *
 * A preload script lives in the window's own world, where `app` does not
 * exist, so it cannot ask for the version itself. The main process passes it
 * in as an argument when the window is created. Asking for `app` here used to
 * throw, and a preload that throws leaves the page with no bridge at all.
 *
 * The app's own package.json is the fallback, so a missing argument shows the
 * real version rather than "unknown".
 */
function appVersion(): string {
  const prefix = "--app-version=";
  const argument = process.argv.find((value) => value.startsWith(prefix));
  if (argument) return argument.slice(prefix.length);
  try {
    const manifest = JSON.parse(readFileSync(join(__dirname, "..", "package.json"), "utf8")) as {
      version?: string;
    };
    return manifest.version ?? "unknown";
  } catch {
    return "unknown";
  }
}

/**
 * The shape of the update status the main process reports. It is written out
 * here rather than imported so the preload stays a plain script: it runs in the
 * window's own world and must not pull the main process's code in with it.
 */
export type UpdateStatus = {
  supported: boolean;
  reason: string | null;
  currentVersion: string;
  feedUrl: string;
  state:
    "idle" | "checking" | "available" | "not-available" | "downloading" | "downloaded" | "error";
  availableVersion: string | null;
  releaseNotes: string | null;
  percent: number;
  transferred: number;
  total: number;
  error: string | null;
};

export type UpdateEvent = {
  type: "status" | "progress";
  status: UpdateStatus;
};

const update = {
  status: (): Promise<UpdateStatus> => ipcRenderer.invoke("update:status"),
  check: (): Promise<UpdateStatus> => ipcRenderer.invoke("update:check"),
  download: (): Promise<UpdateStatus> => ipcRenderer.invoke("update:download"),
  install: (): Promise<UpdateStatus> => ipcRenderer.invoke("update:install"),
  setFeedUrl: (url: string): Promise<UpdateStatus> => ipcRenderer.invoke("update:setFeedUrl", url),
  /**
   * Listen for the updater. The listener is returned so the page can stop
   * listening when it goes away; without that, a page that is opened and
   * closed many times would pile up listeners.
   */
  onEvent: (listener: (event: UpdateEvent) => void): (() => void) => {
    const handler = (_event: Electron.IpcRendererEvent, payload: UpdateEvent) => listener(payload);
    ipcRenderer.on("update:event", handler);
    return () => ipcRenderer.removeListener("update:event", handler);
  },
};

contextBridge.exposeInMainWorld("electronAPI", {
  saveDialog: (options: Electron.SaveDialogOptions) => ipcRenderer.invoke("dialog:save", options),
  openDialog: (options: Electron.OpenDialogOptions) => ipcRenderer.invoke("dialog:open", options),
  openExternal: (url: string) => ipcRenderer.invoke("shell:openExternal", url),
  platform: process.platform,
  /** The version of the app that is running. */
  version: appVersion(),
  update,
});

declare global {
  interface Window {
    electronAPI: {
      saveDialog: (options: Electron.SaveDialogOptions) => Promise<Electron.SaveDialogReturnValue>;
      openDialog: (options: Electron.OpenDialogOptions) => Promise<Electron.OpenDialogReturnValue>;
      openExternal: (url: string) => Promise<void>;
      platform: string;
      version: string;
      update: typeof update;
    };
  }
}
