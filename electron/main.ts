import { app, BrowserWindow, ipcMain, dialog, shell } from "electron";
import { join, resolve } from "node:path";
import { existsSync, mkdirSync } from "node:fs";
import { startServer } from "./electron-start";
import Database from "better-sqlite3";
import { applyMigrations } from "../src/server/db";

let mainWindow: BrowserWindow | null = null;
let serverUrl: string | null = null;

/** Get the userData path for the database. */
function getDatabasePath(): string {
  const userData = app.getPath("userData");
  const dbDir = join(userData, "database");
  if (!existsSync(dbDir)) mkdirSync(dbDir, { recursive: true });
  return join(dbDir, "attendance.db");
}

/** Initialise the SQLite database with migrations. */
function initDatabase(): Database {
  const dbPath = getDatabasePath();
  const db = new Database(dbPath);
  db.pragma("foreign_keys = ON");
  db.pragma("journal_mode = WAL");
  db.pragma("busy_timeout = 5000");
  applyMigrations(db);
  return db;
}

/** Create the main browser window. */
function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 1024,
    minHeight: 700,
    title: "Attendance Register",
    webPreferences: {
      preload: join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
    icon: join(__dirname, "..", "public", "icon.ico"),
  });

  if (serverUrl) {
    mainWindow.loadURL(serverUrl);
  }

  mainWindow.on("closed", () => {
    mainWindow = null;
  });
}

/** Handle single-instance lock. */
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on("second-instance", () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });
}

app.whenReady().then(async () => {
  // Initialise database before starting server
  initDatabase();

  // Start the Nitro server
  const { address } = await startServer({
    dbFile: getDatabasePath(),
    port: 0, // Let OS pick a free port
  });
  serverUrl = address;

  createWindow();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

// IPC handlers for native dialogs
ipcMain.handle("dialog:save", async (_event, options: Electron.SaveDialogOptions) => {
  if (!mainWindow) return { canceled: true };
  return dialog.showSaveDialog(mainWindow, options);
});

ipcMain.handle("dialog:open", async (_event, options: Electron.OpenDialogOptions) => {
  if (!mainWindow) return { canceled: true };
  return dialog.showOpenDialog(mainWindow, options);
});

ipcMain.handle("shell:openExternal", async (_event, url: string) => {
  await shell.openExternal(url);
});
