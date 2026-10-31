import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: { alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) } },
  test: {
    environment: "jsdom",
    // Node 25+ has its own localStorage, which Vitest would keep in place of jsdom's. Older Node rejects this flag.
    execArgv: process.allowedNodeEnvironmentFlags.has("--webstorage") ? ["--no-webstorage"] : [],
    // Testing Library hooks its automatic cleanup and act() setup onto the global test functions.
    globals: true,
    // e2e/*.spec.ts belongs to Playwright.
    include: ["src/**/*.test.{ts,tsx}"],
    restoreMocks: true,
    unstubGlobals: true,
  },
});
