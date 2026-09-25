import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./tests/browser",
  testMatch: "real-api.spec.ts",
  timeout: 60_000,
  use: {
    baseURL: process.env.RELAY_M02_UI_BASE_URL,
    browserName: "chromium",
    headless: true
  }
});
