import { defineConfig } from "@playwright/test";

/**
 * 真实 API / 真实 PostgreSQL 的浏览器业务验收专用配置（2026-10-08）。
 *
 * 与既有 `playwright.real-api.config.ts` 分开：那份配置由
 * `scripts/run-real-api-browser.ps1` 独占，它自己起 PG、API 与 vite，并只跑
 * `real-api.spec.ts`。本轮验收使用协调者已经备好的隔离环境（API 8788 + PG
 * 12525/relay_acc_20261008_c + 已在 5173 运行的 dev server），因此不启动、
 * 不停止任何进程，只按 testMatch 选中自己的 spec。
 *
 * 端点与工作空间可用环境变量覆盖，默认指向隔离环境；凭据只从
 * RELAY_ACC_BEARER_TOKEN 或 apps/api/.env 读入进程内存，不写入任何文件或日志。
 */
export default defineConfig({
  testDir: "./tests/browser",
  testMatch: "realBusinessAcceptance.spec.ts",
  timeout: 120_000,
  expect: { timeout: 20_000 },
  fullyParallel: false,
  workers: 1,
  use: {
    baseURL: process.env.RELAY_ACC_UI_BASE_URL ?? "http://127.0.0.1:5173",
    browserName: "chromium",
    headless: true
  }
});