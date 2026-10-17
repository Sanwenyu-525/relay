import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./tests/browser",
  testMatch: process.env.RELAY_BROWSER_SCENARIO === "free-models" ? "free-model-real-api.spec.ts" : "real-api.spec.ts",
  timeout: 60_000,
  use: {
    baseURL: process.env.RELAY_M02_UI_BASE_URL,
    browserName: "chromium",
    headless: true
  }
});
