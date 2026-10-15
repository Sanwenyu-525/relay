import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./tests/browser",
  // real-api.spec.ts 由 scripts/run-real-api-browser.ps1 独占；realBusinessAcceptance.spec.ts 需要
  // 协调者备好的隔离环境（真实 API 8788 + 真实 PG + 5173），由 playwright.real-business.config.ts 单独跑。
  testIgnore: ["real-api.spec.ts", "realBusinessAcceptance.spec.ts"],
  timeout: 30_000,
  use: {
    baseURL: "http://127.0.0.1:4173",
    browserName: "chromium",
    headless: true
  },
  webServer: {
    command: "npm run dev -- --port 4173",
    url: "http://127.0.0.1:4173",
    reuseExistingServer: true,
    timeout: 30_000
  }
});
