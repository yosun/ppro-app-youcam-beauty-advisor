import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const root = fileURLToPath(new URL("./src/web", import.meta.url));
const apiPort = process.env.PORT || "8787";
const api = `http://localhost:${apiPort}`;

// The web app is a static bundle served by the Node server in production
// (dist/web). In development Vite serves it and proxies the API.
export default defineConfig({
  root,
  plugins: [react()],
  build: {
    outDir: fileURLToPath(new URL("./dist/web", import.meta.url)),
    emptyOutDir: true,
    sourcemap: true,
  },
  server: {
    port: 5173,
    proxy: {
      "/ppro": { target: api, changeOrigin: false },
      "/.well-known": { target: api, changeOrigin: false },
      "/mcp": { target: api, changeOrigin: false },
    },
  },
});
