import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./tests/screenshots",
  testMatch: "capture-non-agent.spec.ts",
  timeout: 180_000,
  workers: 1,
  use: {
    baseURL: "http://127.0.0.1:5173",
    browserName: "chromium",
    headless: true
  }
});
