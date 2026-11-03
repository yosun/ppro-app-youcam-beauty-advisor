import { defineConfig } from "@playwright/test";

// Browser tests run against the production build in simulated mode (no YouCam
// key, so nothing is billed). Set PW_CHANNEL=chrome to use the system Chrome
// instead of Playwright's bundled Chromium.
const port = 8798;

export default defineConfig({
  testDir: "e2e",
  timeout: 60_000,
  fullyParallel: false,
  workers: 1,
  reporter: [["list"]],
  outputDir: "test-results",
  use: {
    baseURL: `http://127.0.0.1:${port}`,
    channel: process.env.PW_CHANNEL || undefined,
    viewport: { width: 1280, height: 920 },
    trace: "retain-on-failure",
  },
  webServer: {
    command: "npm run build && node dist/server/main.js",
    url: `http://127.0.0.1:${port}/ppro/v1/health`,
    timeout: 120_000,
    reuseExistingServer: !process.env.CI,
    env: {
      PORT: String(port),
      PPRO_STANDALONE: "true",
      PPRO_PUBLIC_URL: `http://127.0.0.1:${port}`,
      YOUCAM_API_KEY: "",
    },
  },
});
