import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./tests/screenshots",
  testMatch: "capture-agent-projects.spec.ts",
  timeout: 300_000,
  workers: 1,
  use: {
    baseURL: "http://127.0.0.1:5173",
    browserName: "chromium",
    headless: true
  }
});
