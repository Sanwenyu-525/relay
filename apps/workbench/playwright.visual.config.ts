import { defineConfig } from "@playwright/test";

/**
 * 视觉回归（UI-UNIFY-02）。
 *
 * 与 playwright.config.ts 分开：视觉基线要求固定视口、固定时区、固定动效偏好、
 * 单 worker，且**只在基线确实需要更新时**才用 --update-snapshots。日常验收直接
 * `npm run test:visual`，不加更新参数——无条件刷新快照等于没有验收。
 */
const port = process.env.RELAY_VISUAL_PORT ?? "4175";

export default defineConfig({
  testDir: "./tests/visual",
  timeout: 60_000,
  fullyParallel: false,
  workers: 1,
  expect: {
    toHaveScreenshot: {
      // 同机同 Chromium 主版本下允许极小的抗锯齿差异；结构性变化（间距、字号、颜色）会远超它。
      maxDiffPixelRatio: 0.002,
      animations: "disabled",
      caret: "hide"
    }
  },
  use: {
    baseURL: `http://127.0.0.1:${port}`,
    browserName: "chromium",
    headless: true,
    viewport: { width: 1440, height: 960 },
    deviceScaleFactor: 1,
    colorScheme: "light",
    locale: "zh-CN",
    timezoneId: "Asia/Shanghai",
    reducedMotion: "reduce"
  },
  webServer: {
    command: `npm run dev -- --port ${port}`,
    url: `http://127.0.0.1:${port}`,
    reuseExistingServer: true,
    timeout: 30_000
  }
});
