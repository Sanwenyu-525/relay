import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./tests/browser",
  testMatch: "relayDiffDecisionReview.spec.ts",
  timeout: 180_000,
  workers: 1,
  reporter: [["list"]],
  use: {
    baseURL: "http://127.0.0.1:4199",
    headless: true,
    viewport: { width: 1440, height: 960 },
    screenshot: "only-on-failure",
    trace: "off",
  },
});
