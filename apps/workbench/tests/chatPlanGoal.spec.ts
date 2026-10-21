import { createElement } from "react";
import { describe, expect, it, vi } from "vitest";
import ChatModeSwitch, { ChatModeHint, chatModeLabel } from "../src/components/ChatModeSwitch";
import GoalCard from "../src/components/GoalCard";
import PlanCard from "../src/components/PlanCard";
import { chatModeCommandFromText } from "../src/lib/chatModeCommand";
import type { RelayGoalView, RelayPlanView } from "../src/api/relayClient";
import { mountReact } from "./mountApp";

/**
 * 聊天 /plan 与 /goal 的界面件（0127，工作台 §44）。
 *
 * 锁四件事：
 *   * `/plan 内容`、`/goal 内容` 解析成「模式 + 正文」，只认行首；正文中间的 /plan 不是命令；
 *   * 模式选择是提交入口：值来自服务端读回的模式，改选才发回调，不在本地抢跑；
 *   * 目标卡只渲染服务端给的行动入口（actions），空闲态整卡不渲染；
 *   * 计划卡显示确切版本号；SUPERSEDED 也要能被看见，不能被当成最新版。
 */

describe("/plan 与 /goal 的输入解析", () => {
  it("命令 + 正文一次解析：模式与剩余正文分开", () => {
    expect(chatModeCommandFromText("/plan 把登录流程梳理成方案"))
      .toEqual({ mode: "PLAN", rest: "把登录流程梳理成方案" });
    expect(chatModeCommandFromText("/goal 持续把文档整理完"))
      .toEqual({ mode: "GOAL", rest: "持续把文档整理完" });
  });

  it("中文名与大小写都认；只写命令时正文为空", () => {
    expect(chatModeCommandFromText("/计划 整理")).toEqual({ mode: "PLAN", rest: "整理" });
    expect(chatModeCommandFromText("/GOAL")).toEqual({ mode: "GOAL", rest: "" });
    expect(chatModeCommandFromText("/Goal ")).toEqual({ mode: "GOAL", rest: "" });
  });

  it("正文中间的 /plan 不是命令；未知命令返回 null", () => {
    expect(chatModeCommandFromText("先看看 /plan 再说")).toBeNull();
    expect(chatModeCommandFromText("/plan-mode 文档")).toBeNull();
    expect(chatModeCommandFromText("普通消息")).toBeNull();
  });
});

describe("聊天模式选择", () => {
  it("select 的值就是服务端读回的模式；改选才回调", async () => {
    const onChange = vi.fn();
    const view = await mountReact(createElement(ChatModeSwitch, {
      mode: "PLAN", disabled: false, busy: false, lockedReason: null, onChange }));
    try {
      // 受控 select 的值是属性不是 HTML attribute：改选回调即证明值来自 props。
      await view.wrapper.get('[data-testid="chat-mode-select"]').setValue("CHAT");
      expect(onChange).toHaveBeenCalledWith("CHAT");
    } finally { view.unmount(); }
    expect(onChange).toHaveBeenCalledTimes(1);
  });

  it("说明行只在非普通模式出现；安全停止时说明停止而不是装作已切换", () => {
    expect(ChatModeHint({ mode: "CHAT", goalStopping: false })).toBeNull();
    const planHint = ChatModeHint({ mode: "PLAN", goalStopping: false });
    expect(planHint?.props["data-testid"]).toBe("chat-mode-hint");
    const stopping = ChatModeHint({ mode: "GOAL", goalStopping: true });
    expect(stopping?.props.children).toContain("安全停止");
  });

  it("标签覆盖三档", () => {
    expect(chatModeLabel("CHAT")).toBe("讨论");
    expect(chatModeLabel("PLAN")).toBe("计划");
    expect(chatModeLabel("GOAL")).toBe("目标");
  });
});

function goalView(status: string, overrides: Record<string, unknown> = {}): RelayGoalView {
  return { goal: {
    goalId: "goal-1", sessionId: "session-1", objective: "把 README 改到能跑",
    status, currentStep: null, progress: null, stopReason: null,
    criteria: [{ key: "c1", statement: "README 含启动步骤", status: "MET",
      evidence: "README 第 3 节", required: true }],
    steps: [], roundCount: 2, noProgressRounds: 0, planVersionId: null, planVersion: null,
    lastRoundAt: null, actions: { pause: true, cancel: true, resume: false,
      confirmCompletion: false },
    revision: "1", createdAt: "2026-10-20T00:00:00Z", updatedAt: "2026-10-20T00:00:00Z",
    ...overrides }, rounds: [] } as unknown as RelayGoalView;
}

describe("目标卡", () => {
  it("没有目标时整卡不渲染，不给空壳", async () => {
    const view = await mountReact(createElement(GoalCard, { view: null, busy: false,
      error: null, onPause: vi.fn(), onCancel: vi.fn(), onResume: vi.fn(), onConfirm: vi.fn() }));
    try {
      expect(view.wrapper.find('[data-testid="goal-card"]').exists()).toBe(false);
    } finally { view.unmount(); }
  });

  it("只渲染服务端允许的行动：AWAITING_ACCEPTANCE 出确认完成，不出暂停", async () => {
    const onPause = vi.fn(); const onConfirm = vi.fn();
    const view = await mountReact(createElement(GoalCard, {
      view: goalView("AWAITING_ACCEPTANCE", { actions: { pause: false, cancel: true,
        resume: false, confirmCompletion: true } }),
      busy: false, error: null, onPause, onCancel: vi.fn(), onResume: vi.fn(), onConfirm }));
    try {
      expect(view.wrapper.find('[data-testid="goal-card-pause"]').exists()).toBe(false);
      expect(view.wrapper.get('[data-testid="goal-card-confirm"]').exists()).toBe(true);
      await view.wrapper.get('[data-testid="goal-card-confirm"]').trigger("click");
      expect(onConfirm).toHaveBeenCalledTimes(1);
      expect(onPause).not.toHaveBeenCalled();
    } finally { view.unmount(); }
  });

  it("成功条件按 key 展示逐条状态与依据", async () => {
    const view = await mountReact(createElement(GoalCard, { view: goalView("ACTIVE"),
      busy: false, error: null, onPause: vi.fn(), onCancel: vi.fn(), onResume: vi.fn(),
      onConfirm: vi.fn() }));
    try {
      const criterion = view.wrapper.get('[data-testid="goal-criterion-c1"]');
      expect(criterion.attributes("data-status")).toBe("MET");
      expect(criterion.text()).toContain("README 含启动步骤");
      expect(criterion.text()).toContain("README 第 3 节");
    } finally { view.unmount(); }
  });
});

function planView(): RelayPlanView {
  return { latest: {
    planId: "plan-2", sessionId: "session-1", version: 2, status: "CURRENT",
    goal: "登录流程重构", scope: ["web"], steps: [{ title: "梳理现状", detail: null }],
    verification: [{ statement: "人工走查", method: "HUMAN" }], openQuestions: [],
    sourceMessageId: "m1", createdAt: "2026-10-20T00:00:00Z" },
    versions: [
      { planId: "plan-1", sessionId: "session-1", version: 1, status: "SUPERSEDED" as const,
        goal: "旧", scope: [], steps: [], verification: [], openQuestions: [],
        sourceMessageId: "m0", createdAt: "2026-10-19T00:00:00Z" },
      { planId: "plan-2", sessionId: "session-1", version: 2, status: "CURRENT" as const,
        goal: "登录流程重构", scope: ["web"], steps: [{ title: "梳理现状", detail: null }],
        verification: [{ statement: "人工走查", method: "HUMAN" }], openQuestions: [],
        sourceMessageId: "m1", createdAt: "2026-10-20T00:00:00Z" }] };
}

describe("计划卡", () => {
  it("显示确切版本号与目标；执行回调带的是这一版的确切 id", async () => {
    const onExecute = vi.fn();
    const view = await mountReact(createElement(PlanCard, { view: planView(), busy: false,
      error: null, onExecute, onExport: vi.fn(), onDismiss: vi.fn() }));
    try {
      expect(view.wrapper.get('[data-testid="plan-card"]').attributes("data-version")).toBe("2");
      expect(view.wrapper.get('[data-testid="plan-card-goal"]').text()).toBe("登录流程重构");
      await view.wrapper.get('[data-testid="plan-card-execute"]').trigger("click");
      expect(onExecute).toHaveBeenCalledWith("plan-2", 2);
    } finally { view.unmount(); }
  });

  it("没有计划时不渲染", async () => {
    const view = await mountReact(createElement(PlanCard, { view: null, busy: false,
      error: null, onExecute: vi.fn(), onExport: vi.fn(), onDismiss: vi.fn() }));
    try {
      expect(view.wrapper.find('[data-testid="plan-card"]').exists()).toBe(false);
    } finally { view.unmount(); }
  });
});
