/**
 * Desktop launcher.
 *
 * The main process does two things: it starts the production server in-process,
 * then shows that server in a window. The order matters. The server reads its
 * database configuration from the environment the first time it is imported,
 * so every variable is set before the import happens. That is also why the
 * import is a `new Function` indirection rather than a static `import` — a
 * static import is hoisted above this code and would load the server with the
 * wrong database.
 *
 * The server is the same build the web app runs (`npm start`), so the desktop
 * and hosted versions cannot drift apart.
 */
import { app, BrowserWindow, dialog, ipcMain, shell } from "electron";
import { randomBytes } from "node:crypto";
import { appendFileSync, copyFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { readDesktopConfig, writeDesktopConfig } from "./config";
import { registerUpdateHandlers, startUpdater } from "./updater";

/** Import the built server. Indirected so the call is not hoisted. */
const importServer = new Function("url", "return import(url)") as (url: string) => Promise<unknown>;

let mainWindow: BrowserWindow | null = null;
let serverUrl = "";

// A crash before whenReady would otherwise leave an empty log and no clue. This
// is the difference between "it does nothing" and a report someone can act on.
process.on("uncaughtException", (error) => {
  log(
    `Uncaught exception: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`,
  );
});
process.on("unhandledRejection", (reason) => {
  log(`Unhandled rejection: ${String(reason)}`);
});

/** Append to the desktop log next to the database, for diagnosing startup. */
function log(message: string): void {
  const line = `[${new Date().toISOString()}] ${message}\n`;
  console.log(line.trimEnd());
  try {
    appendFileSync(join(app.getPath("userData"), "desktop.log"), line);
  } catch {
    // Logging must never be the reason startup fails.
  }
}

/** The one database file this app owns. */
function databasePath(): string {
  return join(app.getPath("userData"), "database", "attendance.db");
}

/**
 * The application icon. A packaged build already has it in the executable, but
 * `electron .` runs from node_modules and would otherwise show the default
 * Electron icon on the taskbar. `.output/public` is the one location present in
 * both cases, because that whole tree ships inside the asar.
 */
function appIconPath(): string {
  return join(__dirname, "..", ".output", "public", "icon.ico");
}

/** Where a fresh install gets its starting data from. */
function seedPath(): string | null {
  const candidates = [
    // Packaged: db/seed is copied to resources/seed by electron-builder.
    app.isPackaged ? join(process.resourcesPath, "seed", "attendance.db") : null,
    join(__dirname, "..", "db", "seed", "attendance.db"),
  ].filter((candidate): candidate is string => candidate !== null);

  return candidates.find((candidate) => existsSync(candidate)) ?? null;
}

/**
 * Create the database file on first run from the bundled copy, so a new install
 * starts with the real data and the real accounts instead of an empty schema.
 * An existing database is never touched.
 */
function prepareDatabase(): void {
  const target = databasePath();
  mkdirSync(dirname(target), { recursive: true });
  if (existsSync(target)) {
    log(`Using existing database at ${target}`);
    return;
  }

  const seed = seedPath();
  if (seed) {
    copyFileSync(seed, target);
    log(`Created database from bundled data: ${seed}`);
  } else {
    log("No bundled data found; the server will create an empty database.");
  }
}

/**
 * The shared-hub connection, read from a plain text file beside the database.
 *
 * The packaged app ships no `.env` and sets `SKIP_DOTENV`, so without this there
 * was no supported way to name a hub at all. Only `SYNC_DB_*` names are taken
 * from it (see loadSyncEnv in src/server/env.ts): the local `DB_DRIVER`,
 * `DB_FILE` and `SESSION_SECRET` set above cannot be overridden from it.
 *
 * A commented template is written on first run so the settings can be found. An
 * all-commented file leaves the hub unconfigured, which is the correct default:
 * a copy that has never been pointed anywhere should not sync.
 */
function syncEnvPath(): string {
  const file = join(app.getPath("userData"), "sync.env");
  if (!existsSync(file)) {
    const template = [
      "# Shared database this copy synchronizes with (optional).",
      "#",
      `# Fill these in and restart the app. The database itself must already`,
      "# exist on that server; synchronization creates its tables, not the",
      "# database. Every machine that syncs must name the same one.",
      "#",
      "# SYNC_DB_HOST=192.168.1.20",
      "# SYNC_DB_NAME=attendance_hub",
      "# SYNC_DB_PORT=3306",
      "# SYNC_DB_USER=attendance",
      "# SYNC_DB_PASSWORD=",
      "",
    ].join("\n");
    try {
      writeFileSync(file, template);
      log(`Wrote a sync configuration template at ${file}`);
    } catch {
      log("Could not write the sync configuration template.");
    }
  }
  return file;
}

/**
 * Keep one session secret per install. Generating one per launch would sign
 * every user out every time the app restarts, and a hard-coded secret would
 * be the same on every machine.
 */
function sessionSecret(): string {
  const saved = readDesktopConfig().sessionSecret;
  if (typeof saved === "string" && saved.length > 0) return saved;

  const generated = randomBytes(32).toString("hex");
  writeDesktopConfig({ sessionSecret: generated });
  return generated;
}

/** Ask the OS for a free port so two installs never collide. */
function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.unref();
    probe.on("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const address = probe.address();
      const port = typeof address === "object" && address !== null ? address.port : 0;
      probe.close(() => resolve(port));
    });
  });
}

/** Wait for the server to answer before showing a window at it. */
async function waitForServer(url: string, timeoutMs = 60_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastError = "timed out";
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url, { redirect: "manual" });
      // Any answer means the server is listening. 404 still proves it is up.
      if (response.status > 0) return;
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`Server did not start: ${lastError}`);
}

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1360,
    height: 860,
    minWidth: 1024,
    minHeight: 700,
    show: false,
    title: "Attendance Register",
    backgroundColor: "#0b1120",
    icon: appIconPath(),
    webPreferences: {
      preload: join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      // The preload runs in the window's own world, where `app` does not exist,
      // so the version is handed over as an argument instead.
      additionalArguments: [`--app-version=${app.getVersion()}`],
    },
  });

  // The window is created hidden so the user never sees a white flash, but a
  // hidden window that never appears is indistinguishable from a broken app.
  // So `ready-to-show` shows it, and if that never arrives the fallback timer
  // shows it anyway. A visible window with an error on it beats no window.
  let shown = false;
  const reveal = (reason: string) => {
    if (shown || !mainWindow || mainWindow.isDestroyed()) return;
    shown = true;
    clearTimeout(revealTimer);
    log(`Showing window (${reason})`);
    mainWindow.show();
    mainWindow.focus();
  };
  const revealTimer = setTimeout(() => reveal("ready-to-show never fired"), 8000);
  mainWindow.once("ready-to-show", () => reveal("ready-to-show"));
  mainWindow.on("closed", () => {
    clearTimeout(revealTimer);
    mainWindow = null;
  });

  // A page that cannot load leaves an empty window and a log line the user can
  // report. Without this the app just sits there.
  mainWindow.webContents.on("did-fail-load", (_event, code, description, url) => {
    const message = `Could not load ${url} (${code} ${description})`;
    log(message);
    dialog.showErrorBox("Attendance Register could not load", message);
  });
  mainWindow.webContents.on("render-process-gone", (_event, details) => {
    log(`Renderer gone: ${details.reason}`);
  });
  mainWindow.webContents.on("preload-error", (_event, preloadPath, error) => {
    log(`Preload failed (${preloadPath}): ${error.message}`);
  });
  // A renderer error is invisible from outside the window, so it is written to
  // the log. Without it, a page that failed to load is just an empty window
  // with nothing to report.
  //
  // Electron has two shapes for this event: the current one, where the level
  // and the text arrive together in the details, and the older one, where they
  // are separate arguments. Both are handled, so the log reads the same either
  // way.
  mainWindow.webContents.on("console-message", (details, level, message) => {
    const params = (details as unknown as { params?: { level?: string; message?: string } }).params;
    const isError = params ? params.level === "error" : level === 3;
    if (!isError) return;
    const text = params?.message ?? (typeof message === "string" ? message : "unknown error");
    // The page reports HTTP status codes with console.error, and a signed-out
    // page or a refused request is ordinary use rather than a fault. Those are
    // left out; anything else is a real failure in the page.
    if (/^API ERROR \[(401|403)\]/.test(text)) return;
    log(`Renderer error: ${text}`);
  });

  // The app is one page served from localhost: keep it inside the window, and
  // hand real links to the system browser instead of navigating away.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/i.test(url)) void shell.openExternal(url);
    return { action: "deny" };
  });
  mainWindow.webContents.on("will-navigate", (event, url) => {
    if (url !== serverUrl) {
      event.preventDefault();
      if (/^https?:/i.test(url)) void shell.openExternal(url);
    }
  });

  void mainWindow.loadURL(serverUrl);
}

async function start(): Promise<void> {
  prepareDatabase();

  const port = await freePort();
  serverUrl = `http://127.0.0.1:${port}`;

  // Set before the import: this is the whole point of this file.
  process.env["DB_DRIVER"] = "sqlite";
  process.env["DB_FILE"] = databasePath();
  process.env["DB_MIGRATIONS_DIR"] = join(
    app.isPackaged ? process.resourcesPath : join(__dirname, ".."),
    app.isPackaged ? "migrations" : "db/migrations",
  );
  process.env["SESSION_SECRET"] = sessionSecret();
  process.env["NODE_ENV"] = "production";
  process.env["NITRO_HOST"] = "127.0.0.1";
  process.env["NITRO_PORT"] = String(port);
  process.env["NITRO_PRESET"] = "node-server";
  process.env["SYNC_ENV_FILE"] = syncEnvPath();
  // Belt and braces: if a stray .env ever ships, the server must not use it.
  process.env["SKIP_DOTENV"] = "1";

  const entry = join(__dirname, "..", ".output", "server", "index.mjs");
  if (!existsSync(entry)) {
    throw new Error(`The built server is missing at ${entry}. Run "npm run build" first.`);
  }

  log(`Starting server on ${serverUrl}`);
  await importServer(pathToFileURL(entry).href);
  await waitForServer(serverUrl);
  log("Server is ready");
}

if (!app.requestSingleInstanceLock()) {
  // Another copy owns the lock, so this one must go. The running copy is told to
  // come forward; if it cannot, it logs why. Quitting quietly here is correct:
  // this process has no window and nothing to say.
  app.quit();
} else {
  app.on("second-instance", () => {
    log("Second instance launched; bringing the existing window forward");
    if (mainWindow && !mainWindow.isDestroyed()) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      // A window that is still hidden (the first launch is a few seconds while
      // the server starts) would focus to nothing, which looks like a broken
      // shortcut, so show it explicitly.
      if (!mainWindow.isVisible()) mainWindow.show();
      mainWindow.focus();
    } else {
      createWindow();
    }
  });

  app.whenReady().then(
    async () => {
      app.setAppUserModelId("com.attendance.register");
      try {
        await start();
        createWindow();
        // The updater is started after the window exists, so the window can be
        // told what the check finds.
        startUpdater();
        app.on("activate", () => {
          if (BrowserWindow.getAllWindows().length === 0) createWindow();
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        log(`Startup failed: ${message}`);
        dialog.showErrorBox(
          "Attendance Register could not start",
          `${message}\n\nA log was written to ${join(app.getPath("userData"), "desktop.log")}`,
        );
        app.quit();
      }
    },
    (error: unknown) => {
      log(`Startup failed: ${String(error)}`);
      app.quit();
    },
  );

  app.on("window-all-closed", () => {
    if (process.platform !== "darwin") app.quit();
  });
}

ipcMain.handle("dialog:save", async (_event, options: Electron.SaveDialogOptions) => {
  if (!mainWindow) return { canceled: true };
  return dialog.showSaveDialog(mainWindow, options);
});

ipcMain.handle("dialog:open", async (_event, options: Electron.OpenDialogOptions) => {
  if (!mainWindow) return { canceled: true };
  return dialog.showOpenDialog(mainWindow, options);
});

ipcMain.handle("shell:openExternal", async (_event, url: string) => {
  if (!/^https?:/i.test(url)) throw new Error("Only http and https links can be opened.");
  await shell.openExternal(url);
});

registerUpdateHandlers();
