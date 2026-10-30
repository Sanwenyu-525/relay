import { defineConfig } from "@playwright/test";

/**
 * 生产产物的浏览器级隔离复验。
 *
 * 与默认配置的区别只有一个：webServer 端的是 `NODE_ENV=production` 构建出的真产物，
 * 不是开发服务器。开发入口的正向回归仍在 `playwright.config.ts` 的 `scenarioLabEntry.spec.ts`。
 */
export default defineConfig({
  testDir: "./tests/browser-prod",
  timeout: 60_000,
  use: {
    baseURL: "http://127.0.0.1:4180",
    browserName: "chromium",
    headless: true
  },
  webServer: {
    command: "node scripts/preview-scenario-lab-prod.mjs",
    url: "http://127.0.0.1:4180",
    // 不复用：4180 上若已有别的服务，验的就不是这份刚构建的产物了。
    reuseExistingServer: false,
    // 生产构建本身要几十秒，再加上预览服务起监听。
    timeout: 300_000
  }
});
