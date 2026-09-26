"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const electron_1 = require("electron");
electron_1.contextBridge.exposeInMainWorld("electronAPI", {
  saveDialog: (options) => electron_1.ipcRenderer.invoke("dialog:save", options),
  openDialog: (options) => electron_1.ipcRenderer.invoke("dialog:open", options),
  openExternal: (url) => electron_1.ipcRenderer.invoke("shell:openExternal", url),
  platform: process.platform,
});
