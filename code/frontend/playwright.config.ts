import { defineConfig, devices } from "@playwright/test";
import { existsSync } from "node:fs";
import path from "node:path";

// Never load a developer's provider credentials into this explicitly test-only stack.
for (const directory of [".", "../backend"]) {
  for (const file of [".env", ".env.local", ".env.production", ".env.production.local"]) {
    if (existsSync(path.resolve(directory, file))) throw new Error(`E2E requires a clean checkout without ${directory}/${file}`);
  }
}
const env: Record<string, string> = {
  NEXT_TELEMETRY_DISABLED: "1",
  BACKEND_URL: "http://127.0.0.1:8165",
  NEXT_FONT_GOOGLE_MOCKED_RESPONSES: path.resolve("e2e/font-mock.cjs"),
  // The whole suite shares one backend and one IP, so it would use up the hourly persona limit.
  RATE_LIMIT_MULTIPLIER: "10",
};
for (const key of Object.keys(process.env)) {
  if (/^(OPENAI_|SIMLI_|UPSTASH_|REDIS_)/.test(key)) env[key] = "";
}
const artifacts = process.env.E2E_ARTIFACT_DIR ?? "../../.review/issue65";

export default defineConfig({
  testDir: "./e2e",
  fullyParallel: false,
  workers: 1,
  retries: 0,
  forbidOnly: !!process.env.CI,
  timeout: 30_000,
  expect: { timeout: 5_000 },
  outputDir: `${artifacts}/test-results`,
  reporter: [["list"], ["html", { outputFolder: `${artifacts}/html`, open: "never" }]],
  use: {
    baseURL: "http://127.0.0.1:3165",
    ...devices["Desktop Chrome"],
    serviceWorkers: "block",
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  webServer: [
    {
      command: "uv run --locked uvicorn tests.e2e_server:app --loop asyncio --host 127.0.0.1 --port 8165",
      cwd: "../backend",
      url: "http://127.0.0.1:8165/api/health",
      env,
      reuseExistingServer: false,
      gracefulShutdown: { signal: "SIGTERM", timeout: 5_000 },
    },
    {
      command: "npm run build && npm run start -- --hostname 127.0.0.1 --port 3165",
      url: "http://127.0.0.1:3165",
      env,
      timeout: 120_000,
      reuseExistingServer: false,
      gracefulShutdown: { signal: "SIGTERM", timeout: 5_000 },
    },
  ],
});
