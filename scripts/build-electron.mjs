/**
 * Compile the Electron main and preload scripts.
 *
 * They are bundled to CommonJS with a `.cjs` extension. The extension matters:
 * this package is `"type": "module"`, so a `.js` file would be loaded as ESM and
 * `__dirname` would not exist in the main process. `electron` stays external
 * because it is provided by the runtime, not by node_modules.
 *
 * `electron-updater` stays external too: it reads its own package files at
 * runtime and is shipped inside the installer as a normal dependency. Bundling
 * it would inline code that expects to find those files on disk.
 */
import { rm } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { build } from "esbuild";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const outdir = join(root, "dist-electron");

await rm(outdir, { recursive: true, force: true });

await build({
  entryPoints: [join(root, "electron", "main.ts"), join(root, "electron", "preload.ts")],
  outdir,
  outExtension: { ".js": ".cjs" },
  bundle: true,
  platform: "node",
  target: "node22",
  format: "cjs",
  external: ["electron", "electron-updater"],
  sourcemap: false,
  minify: false,
  logLevel: "info",
});

console.log("Electron main and preload bundled into dist-electron/");
