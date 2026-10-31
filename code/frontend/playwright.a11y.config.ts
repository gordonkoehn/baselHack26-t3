import { defineConfig } from "@playwright/test";
import defaults from "./playwright.config";

// Import the existing credential guard and retain its font mock/environment defaults.
const servers = Array.isArray(defaults.webServer) ? defaults.webServer : [defaults.webServer];
const frontend = servers.at(-1);
if (!frontend) throw new Error("Missing frontend Playwright defaults");
const artifacts = process.env.E2E_ARTIFACT_DIR ?? "../../.review/issue72";

export default defineConfig({
  ...defaults,
  testMatch: "accessibility.spec.ts",
  outputDir: `${artifacts}/test-results`,
  reporter: [["list"], ["html", { outputFolder: `${artifacts}/html`, open: "never" }]],
  use: { ...defaults.use, baseURL: "http://127.0.0.1:3272" },
  webServer: {
    ...frontend,
    command: "npm run build && npm run start -- --hostname 127.0.0.1 --port 3272",
    url: "http://127.0.0.1:3272",
    env: { ...frontend.env, BACKEND_URL: "http://127.0.0.1:8272" },
    reuseExistingServer: false,
  },
});
