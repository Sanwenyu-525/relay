import { defineConfig } from "@playwright/test";

/**
 * 浏览器测试端口可用 RELAY_E2E_PORT 覆盖（默认 4173）。
 *
 * 2026-10-31：本机 4173 曾被另一项目的预览服务占用，`reuseExistingServer` 会静默复用
 * 它并让所有页面 404——用环境变量把本轮验收挪到空闲端口，不依赖杀别人的进程。
 */
const port = process.env.RELAY_E2E_PORT ?? "4173";

export default defineConfig({
  testDir: "./tests/browser",
  // real-api.spec.ts 由 scripts/run-real-api-browser.ps1 独占；realBusinessAcceptance.spec.ts 需要
  // 协调者备好的隔离环境（真实 API 8788 + 真实 PG + 5173），由 playwright.real-business.config.ts 单独跑。
  testIgnore: ["real-api.spec.ts", "free-model-real-api.spec.ts", "realBusinessAcceptance.spec.ts"],
  timeout: 30_000,
  use: {
    baseURL: `http://127.0.0.1:${port}`,
    browserName: "chromium",
    headless: true
  },
  webServer: {
    command: `npm run dev -- --port ${port}`,
    url: `http://127.0.0.1:${port}`,
    reuseExistingServer: true,
    timeout: 30_000
  }
});
