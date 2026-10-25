import { test } from "@playwright/test";
import { mkdirSync } from "node:fs";
import { resolve } from "node:path";

/**
 * 原型复刻（除工作台）的视觉基线采集。
 * 用 fixture 模式驱动真实路由，不需要本机 API；输出到 results/proto-replica-20261026/。
 * before/：改造前的产品页面；after/：复刻后重跑同名用例即可对比。
 */

const outDir = resolve(import.meta.dirname, "../../results/proto-replica-20261026");

interface Shot {
  name: string;
  path: string;
  width: number;
  height: number;
}

const desktopShots: readonly Shot[] = [
  { name: "projects", path: "/projects", width: 1440, height: 900 },
  { name: "project-detail", path: "/projects/project-alpha", width: 1440, height: 900 },
  { name: "goals", path: "/goals", width: 1440, height: 900 },
  { name: "goal-detail", path: "/goals/goal-alpha", width: 1440, height: 900 },
  { name: "tasks", path: "/tasks", width: 1440, height: 900 },
  { name: "task-detail", path: "/tasks/task-alpha", width: 1440, height: 900 },
  { name: "inbox-tab", path: "/tasks?tab=inbox", width: 1440, height: 900 },
  { name: "reviews", path: "/reviews", width: 1440, height: 900 },
  { name: "today", path: "/today", width: 1440, height: 900 },
  { name: "knowledge", path: "/knowledge", width: 1440, height: 900 },
  { name: "activity", path: "/activity", width: 1440, height: 900 },
  { name: "scheduled-tasks", path: "/scheduled-tasks", width: 1440, height: 900 },
  { name: "scheduled-create", path: "/scheduled-tasks?view=create", width: 1440, height: 900 },
  { name: "scheduled-detail", path: "/scheduled-tasks/sched-alpha", width: 1440, height: 900 },
  { name: "settings", path: "/settings", width: 1440, height: 900 },
  { name: "connections", path: "/connections", width: 1440, height: 900 },
  { name: "completion-record", path: "/completion-records/cr-alpha", width: 1440, height: 900 },
  { name: "run-detail", path: "/runs/run-alpha", width: 1440, height: 900 },
  { name: "agent-workbench", path: "/agent", width: 1440, height: 900 }
];

test.describe("原型复刻基线", () => {
  for (const shot of desktopShots) {
    test(`capture ${shot.name}`, async ({ page }) => {
      mkdirSync(outDir, { recursive: true });
      await page.setViewportSize({ width: shot.width, height: shot.height });
      await page.goto(shot.path, { waitUntil: "networkidle" });
      await page.waitForTimeout(600);
      const suffix = shot.name === "agent-workbench" ? "WORKBENCH-BASELINE" : "product-before";
      await page.screenshot({ path: resolve(outDir, `${suffix}/${shot.name}.png`), fullPage: true });
    });
  }
});
