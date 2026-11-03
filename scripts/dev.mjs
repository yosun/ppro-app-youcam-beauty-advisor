// Runs the API server (with reload) and the Vite dev server together.
// The web app is at http://localhost:5173 and proxies /ppro, /mcp and
// /.well-known to the API server on PORT (default 8787).
import { spawn } from "node:child_process";

const children = [
  spawn(
    process.execPath,
    [
      "--env-file-if-exists=.env",
      "--import",
      "tsx",
      "--watch",
      "src/server/main.ts",
    ],
    { stdio: "inherit", env: { ...process.env, PPRO_DEV: "1" } },
  ),
  spawn(process.execPath, ["node_modules/vite/bin/vite.js"], {
    stdio: "inherit",
    env: process.env,
  }),
];

function stop(code = 0) {
  for (const child of children) child.kill("SIGTERM");
  process.exit(code);
}
for (const child of children) child.on("exit", (code) => stop(code ?? 0));
process.on("SIGINT", () => stop(0));
process.on("SIGTERM", () => stop(0));
