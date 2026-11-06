import { defineConfig } from "vite";
import vue from "@vitejs/plugin-vue";
// @ts-expect-error type error without @types/node package
import process from "node:process";
// @ts-expect-error type error without @types/node package
import fs from "node:fs";
const host = process.env.TAURI_DEV_HOST;

// https://vite.dev/config/
// dev only: the app POSTs its state/errors to /__debug, which appends to .debug/app.log so an agent can see the native webview
const debugBridge = () => ({
  name: "lanthorn-debug-bridge",
  configureServer(server: any) {
    let pending = "";
    server.middlewares.use("/__debug/cmd", (req: any, res: any) => {
      if (req.method === "POST") {
        let body = "";
        req.on("data", (c: any) => (body += c));
        req.on("end", () => { pending = body.trim(); res.end("queued"); });
      } else {
        res.end(pending);
        pending = "";
      }
    });
    server.middlewares.use("/__debug", (req: any, res: any) => {
      let body = "";
      req.on("data", (c: any) => (body += c));
      req.on("end", () => {
        fs.mkdirSync(".debug", { recursive: true });
        fs.appendFileSync(".debug/app.log", new Date().toISOString() + " " + body + "\n");
        res.end("ok");
      });
    });
  },
});

export default defineConfig(() => ({
  plugins: [vue(), debugBridge()],

  // Vite options tailored for Tauri development and only applied in `tauri dev` or `tauri build`
  //
  // 1. prevent Vite from obscuring rust errors
  clearScreen: false,
  // 2. tauri expects a fixed port, fail if that port is not available
  server: {
    port: 1420,
    strictPort: true,
    host: host || false,
    hmr: host
      ? {
          protocol: "ws",
          host,
          port: 1421,
        }
      : undefined,
    watch: {
      // 3. tell Vite to ignore watching `src-tauri`
      ignored: ["**/src-tauri/**", "**/.work/**", "**/.debug/**", "**/runtime/**", "**/scripts/**", "**/books/**", "**/examples/**", "**/docs/**"],
    },
  },
}));
