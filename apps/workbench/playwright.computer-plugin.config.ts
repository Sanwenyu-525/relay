import { defineConfig } from "@playwright/test";

/** COMPUTER-PLUGIN-E2E：一次性真实 API + Vite 的 UI 验收，不作为日常浏览器套件运行。 */
export default defineConfig({
  testDir: "./tests/browser",
  testMatch: "computerPluginE2E.spec.ts",
  timeout: 60_000,
  use: {
    baseURL: process.env.RELAY_UI_UI_BASE_URL,
    browserName: "chromium",
    headless: true,
  },
});
