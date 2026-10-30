import { defineConfig } from "@playwright/test";

// 临时配置：仅用于本轮状态图标验收。本机 4173 被另一个项目的 `vite preview` 占用
// （绑定在 [::1]，Chromium 走 127.0.0.1 会连不上），因此换一个端口起本仓的 dev server。
// 跑完即删，不进入交付。
export default defineConfig({
  testDir: "./tests/browser",
  timeout: 30_000,
  use: {
    baseURL: "http://127.0.0.1:4288",
    browserName: "chromium",
    headless: true
  },
  webServer: {
    command: "npm run dev -- --port 4288 --strictPort",
    url: "http://127.0.0.1:4288",
    reuseExistingServer: true,
    timeout: 60_000
  }
});
