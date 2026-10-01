import { defineConfig } from "@playwright/test";

// 工作主线对齐取样：只读夹具 + 页面内拦截，不连数据库、不调用 Provider、不提交业务命令。
// 用法：npx playwright test --config scripts/playwright.ui-align.config.ts
export default defineConfig({
  testDir: ".",
  testMatch: "ui-align-visual.spec.ts",
  timeout: 60_000,
  workers: 1,
  reporter: "list",
  use: {
    baseURL: "http://127.0.0.1:4174",
    browserName: "chromium",
    headless: true,
    deviceScaleFactor: 1
  },
  webServer: {
    command: "npm run dev -- --port 4174",
    url: "http://127.0.0.1:4174",
    reuseExistingServer: true,
    timeout: 60_000
  }
});