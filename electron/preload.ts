import { contextBridge, ipcRenderer } from "electron";

contextBridge.exposeInMainWorld("electronAPI", {
  saveDialog: (options: Electron.SaveDialogOptions) => ipcRenderer.invoke("dialog:save", options),
  openDialog: (options: Electron.OpenDialogOptions) => ipcRenderer.invoke("dialog:open", options),
  openExternal: (url: string) => ipcRenderer.invoke("shell:openExternal", url),
  platform: process.platform,
});

declare global {
  interface Window {
    electronAPI: {
      saveDialog: (options: Electron.SaveDialogOptions) => Promise<Electron.SaveDialogReturnValue>;
      openDialog: (options: Electron.OpenDialogOptions) => Promise<Electron.OpenDialogReturnValue>;
      openExternal: (url: string) => Promise<void>;
      platform: string;
    };
  }
}
