import { test } from "@playwright/test";
import { mkdirSync } from "node:fs";
import { resolve } from "node:path";

/**
 * pv 皮肤精修轮（2026-10-27）的当前态采集。
 * 路由与 proto-baseline.spec.ts 一致；输出 results/pv-polish-20261027/，
 * 不覆盖 proto-replica-20261026 的 product-before 基线。
 * /agent 快照用于与 WORKBENCH-BASELINE 对照，确认工作台零视觉变化仍然成立。
 */

const outDir = resolve(import.meta.dirname, "../../results/pv-polish-20261027");

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

test.describe("pv 精修轮当前态", () => {
  for (const shot of desktopShots) {
    test(`capture ${shot.name}`, async ({ page }) => {
      mkdirSync(outDir, { recursive: true });
      await page.setViewportSize({ width: shot.width, height: shot.height });
      await page.goto(shot.path, { waitUntil: "networkidle" });
      await page.waitForTimeout(600);
      const suffix = shot.name === "agent-workbench" ? "WORKBENCH-CHECK" : "current";
      await page.screenshot({ path: resolve(outDir, `${suffix}/${shot.name}.png`), fullPage: true });
    });
  }
});
