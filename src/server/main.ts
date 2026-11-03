import { serve } from "@hono/node-server";
import { beautyAdvisor } from "../advisor/app.ts";
import { createApp } from "./app.ts";
import { loadConfig } from "./config.ts";
import { Runtime } from "./runtime.ts";

// Starts the server: the PPRO App API, the MCP endpoint and the web app.

const config = loadConfig();
const runtime = new Runtime(beautyAdvisor, config);
runtime.start();
const app = createApp(runtime, config);

const hostname =
  process.env.HOST?.trim() || (config.production ? "0.0.0.0" : "127.0.0.1");

const server = serve(
  { fetch: app.fetch, port: config.port, hostname },
  (info) => {
    const mode = beautyAdvisor.engineMode();
    console.log(
      `${beautyAdvisor.name} listening on http://${hostname}:${info.port}`,
    );
    console.log(
      mode === "live"
        ? "YouCam: live (YOUCAM_API_KEY is set)"
        : mode === "simulated"
          ? "YouCam: SIMULATED. No YOUCAM_API_KEY, so results are labeled demo previews."
          : "YouCam: unavailable (YOUCAM_ENABLED=false)",
    );
    console.log(`Manifest:  ${config.publicUrl}/.well-known/ppro-app.json`);
    if (config.standalone)
      console.log(
        `Standalone demo sessions are on. Open ${config.publicUrl} (or the Vite dev server on :5173).`,
      );
    if (config.hostKeyGenerated)
      console.log(
        `Host key for this run (development only): ${config.hostKey}`,
      );
  },
);

function shutdown() {
  runtime.stop();
  server.close(() => process.exit(0));
  // Open event streams would hold the process; leave after a moment.
  setTimeout(() => process.exit(0), 2000).unref();
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
