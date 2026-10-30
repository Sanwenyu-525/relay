import { createElement } from "react";
import { afterEach, describe, expect, it } from "vitest";
import { act } from "react";
import type { Scenario } from "../src/dev/scenarioWorld";
import { ScenarioRunner } from "../src/dev/scenarioWorld";
import { ScenarioShell, ScenarioStage, withScenarioRouter } from "../src/dev/scenarioHost";
import { runChecks, type CheckResult } from "../src/dev/scenarioChecks";
import { saveActivityDensity } from "../src/lib/activityDensity";
import { ALL_SCENARIOS, duplicateIds, missingMatrixIds, SCENARIO_GROUPS } from "../src/dev/scenarios";
import { flush, mountReact } from "./mountApp";

/**
 * 场景矩阵的机检：把 145 条场景（矩阵 108 + 组合流程 6 + 补充分支 31）在 jsdom 里**用真实产品组件跑一遍**，逐条执行它自己声明的断言。
 *
 * 这一层与浏览器测试的分工是明确的，不互相冒充：
 *   * 这里能验的：节点在场/退场、行数、文案、属性、重复行——也就是「界面上写了什么」。
 *   * 这里验不了的：横向溢出、动画节点数、左缘对齐、滚动位置稳定，一律标 `browser-only`，
 *     由 `tests/browser/assistScenarioLab.spec.ts` 在真实布局下判定（见 `scenarioChecks.ts`）。
 *   * 因此这里的「通过」只说明呈现事实对得上，不等于整条验收通过。
 *
 * 执行顺序与实验室一致：静态断言跑在最后一帧，交互脚本从第 0 帧重放后逐步推进，
 * `advance` 走 `ScenarioRunner.next()`，与控制器上那颗「单步」按钮是同一条路径。
 */

let unmount: (() => void) | null = null;
afterEach(() => { unmount?.(); unmount = null; saveActivityDensity("standard"); });

const root = (): HTMLElement => {
  const element = document.querySelector<HTMLElement>("[data-scenario-preview]");
  if (element === null) throw new Error("场景舞台没有挂上 data-scenario-preview");
  return element;
};

/**
 * 外壳按场景声明的呈现条件挂载。
 *
 * 阅读密度存在本设备存储里（产品自己的入口），因此密度要在挂载前写好、测完还原；
 * 主题与动效先落在外壳上，窗口宽度在 jsdom 里没有答案——那三样由浏览器测试判定。
 */
const shell = (runner: ScenarioRunner, scenario: Scenario) => {
  saveActivityDensity(scenario.conditions?.density ?? "standard");
  return withScenarioRouter(createElement(ScenarioShell, {
    conditions: scenario.conditions,
    children: createElement(ScenarioStage, { runner })
  }));
};

/** 先把界面推到最后一帧，跑静态断言；再从第 0 帧重放交互脚本。 */
async function play(scenario: Scenario): Promise<CheckResult[]> {
  const runner = new ScenarioRunner(scenario);
  const view = await mountReact(shell(runner, scenario));
  unmount = view.unmount;
  await act(async () => { runner.seek(scenario.steps.length - 1); });
  await flush();
  const results = [...runChecks(root(), scenario.checks)];
  const script = scenario.interactions ?? [];
  if (script.length === 0) return results;
  view.unmount();
  const replay = new ScenarioRunner(scenario);
  const second = await mountReact(shell(replay, scenario));
  unmount = second.unmount;
  await flush();
  for (const action of script) {
    if (action.kind === "scrollUp") {
      results.push({ label: action.label, status: "browser-only",
        detail: "滚动位置稳定需要真实滚动容器，由浏览器测试判定" });
      continue;
    }
    if (action.kind === "advance") {
      await act(async () => { replay.next(); });
      await flush();
    } else if (action.kind === "inspect") {
      await flush();
    } else {
      const target = root().querySelector(action.selector);
      if (target === null) {
        results.push({ label: action.label, status: "fail",
          detail: `动作目标不存在：${action.selector}` });
        continue;
      }
      await act(async () => {
        target.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
      });
      await flush();
    }
    results.push(...runChecks(root(), action.then));
  }
  return results;
}

describe("场景矩阵的完整性", () => {
  it("每条场景都有唯一 ID", () => {
    expect(duplicateIds()).toEqual([]);
  });

  it("矩阵逐条要求的 ID 都在目录里，一条不缺", () => {
    expect(missingMatrixIds()).toEqual([]);
    expect(SCENARIO_GROUPS.map((group) => group.category).join("")).toBe("ABCDEFGX");
  });

  it("每条场景至少有『初始状态』这一帧，且宿主与组件成对", () => {
    for (const scenario of ALL_SCENARIOS) {
      expect(scenario.steps.length, `${scenario.id} 没有可播放的帧`).toBeGreaterThan(0);
      expect(scenario.component, `${scenario.id} 没声明验哪个组件出口`).not.toBe("");
    }
  });
});

describe("逐条场景的呈现断言", () => {
  for (const scenario of ALL_SCENARIOS) {
    it(`${scenario.id} ${scenario.title}`, async () => {
      const results = await play(scenario);
      const failures = results
        .filter((result) => result.status === "fail")
        .map((result) => `${result.label} → ${result.detail}`);
      expect(failures.join("\n")).toBe("");
    });
  }
});
