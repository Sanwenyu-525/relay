import { createElement } from "react";
import { afterEach, expect, it, vi } from "vitest";

import GoalCard from "../src/components/GoalCard";
import type { RelayGoalView } from "../src/api/resources/planGoal";
import { dialogText, DomWrapper, flush, mountReact, pressEscape } from "./mountApp";

/**
 * 禅道 #153：取消目标是终止性操作（服务端 CANCELLED 属于 TERMINAL，没有反向命令），
 * 按工作台 §13.2「没有反向命令」那一列走 `AppDialog` 事前确认——确认键才发命令，
 * 后果说明在点击前给出，初始焦点压在「再想想」上，回车不会直接把目标取消掉。
 */
let unmount: (() => void) | null = null;
afterEach(() => { unmount?.(); unmount = null; });

/** 弹窗经 portal 挂到 document.body，不在挂载容器里。 */
const inDialog = (testId: string) => new DomWrapper(document.querySelector(`[data-testid="${testId}"]`));
const dialogOpen = () => document.querySelector('[role="dialog"]') !== null;

function goalView(): RelayGoalView {
  return {
    goal: {
      goalId: "goal-1",
      sessionId: "session-1",
      objective: "用 three.js 做一个房子",
      status: "ACTIVE",
      currentStep: "搭建场景与相机",
      progress: "已完成地基与墙体，正在加屋顶。",
      stopReason: null,
      criteria: [{ key: "c1", statement: "页面能打开", status: "MET", evidence: null, required: true }],
      steps: [{ title: "搭建场景与相机", status: "DOING" }],
      roundCount: 2,
      noProgressRounds: 0,
      planVersionId: null,
      planVersion: null,
      lastRoundAt: null,
      actions: { pause: true, cancel: true, resume: false, confirmCompletion: false },
      revision: "1",
      createdAt: "2026-10-22T00:00:00Z",
      updatedAt: "2026-10-22T00:00:00Z",
    },
    rounds: [],
  };
}

it("取消目标先弹确认：确认键才发命令，焦点压取消，Esc 可退出", async () => {
  const onCancel = vi.fn();
  const mounted = await mountReact(createElement(GoalCard, {
    view: goalView(), busy: false, error: null,
    onPause: vi.fn(), onCancel, onResume: vi.fn(), onConfirm: vi.fn(),
  }));
  unmount = mounted.unmount;
  await flush();

  // 点击前没有任何确认框，也没有直接发命令的路径。
  expect(dialogOpen()).toBe(false);
  await mounted.wrapper.get('[data-testid="goal-card-cancel"]').trigger("click");
  await flush(); // AppDialog 在 requestAnimationFrame 里落初始焦点。
  expect(onCancel).not.toHaveBeenCalled();

  const text = dialogText();
  expect(text).toContain("取消这个目标？");
  expect(text).toContain("不会回滚");
  expect(text).toContain("无法恢复");
  // 取消键是 danger 语义，不是和「暂停」同权重的次要键。
  expect(inDialog("goal-card-cancel-confirm-button").attributes("class")).toContain("danger-button");
  // 初始焦点在「再想想」：回车不会误触确认。
  expect(document.activeElement?.getAttribute("data-testid")).toBe("goal-card-cancel-dismiss");

  await inDialog("goal-card-cancel-dismiss").trigger("click");
  expect(dialogOpen()).toBe(false);
  expect(onCancel).not.toHaveBeenCalled();

  // 再次打开后 Esc 收起，仍不发命令。
  await mounted.wrapper.get('[data-testid="goal-card-cancel"]').trigger("click");
  expect(dialogOpen()).toBe(true);
  pressEscape();
  await flush();
  expect(dialogOpen()).toBe(false);
  expect(onCancel).not.toHaveBeenCalled();

  // 明确确认后才发一次原命令。
  await mounted.wrapper.get('[data-testid="goal-card-cancel"]').trigger("click");
  await inDialog("goal-card-cancel-confirm-button").trigger("click");
  expect(onCancel).toHaveBeenCalledTimes(1);
  expect(dialogOpen()).toBe(false);
});
