// Plain Vite wiring for TanStack Start. Everything here is stock Vite plus the
// official TanStack Start, Tailwind, react-tsconfig-paths and Nitro plugins —
// no hosted-platform tooling.
//
//   nitro "node-server" — emit a runnable Node server in .output, so the app
//                         runs on this machine and can be wrapped by a desktop
//                         shell later.
//   server host/port    — bind to loopback on a fixed port, so `npm run dev`
//                         behaves like a desktop app rather than a public host.
import process from "node:process";
import tailwindcss from "@tailwindcss/vite";
import { tanstackStart } from "@tanstack/react-start/plugin/vite";
import react from "@vitejs/plugin-react";
import { nitro } from "nitro/vite";
import { defineConfig } from "vite";
import tsConfigPaths from "vite-tsconfig-paths";

export default defineConfig(({ command }) => ({
  server: {
    host: "127.0.0.1",
    port: Number.parseInt(process.env["PORT"] ?? "3000", 10),
    strictPort: true,
  },
  resolve: {
    // Two copies of React in one bundle breaks hooks at runtime.
    dedupe: [
      "react",
      "react-dom",
      "react/jsx-runtime",
      "react-dom/client",
      "@tanstack/react-query",
      "@tanstack/query-core",
    ],
  },
  plugins: [
    tsConfigPaths({ projects: ["./tsconfig.json"] }),
    tailwindcss(),
    tanstackStart({
      // Keeps `server/*` modules from leaking into the browser bundle.
      importProtection: {
        behavior: "error",
        client: {
          files: ["**/server/**"],
          specifiers: ["server-only"],
        },
      },
      // Point TanStack Start's server entry at src/server.ts (SSR error wrapper).
      server: { entry: "server" },
    }),
    ...(command === "build" ? [nitro({ preset: "node-server" })] : []),
    react(),
  ],
}));
