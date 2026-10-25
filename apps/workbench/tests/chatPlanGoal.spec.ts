import { createElement } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import ChatModeSwitch, { ChatModeHint, chatModeLabel } from "../src/components/ChatModeSwitch";
import GoalCard from "../src/components/GoalCard";
import PlanCard from "../src/components/PlanCard";
import { chatModeCommandFromText } from "../src/lib/chatModeCommand";
import { activateRelayConnection, resetRelayConnectionForTest } from "../src/lib/relayConnection";
import type { RelayGoalView, RelayPlanView } from "../src/api/relayClient";
import { feedbackText, flush, mountReact, mountWorkbench } from "./mountApp";

/**
 * 聊天 /plan 与 /goal 的界面件（0127，工作台 §44）。
 *
 * 锁四件事：
 *   * `/plan 内容`、`/goal 内容` 解析成「模式 + 正文」，只认行首；正文中间的 /plan 不是命令；
 *   * 模式以只读徽标表达当前事实（普通模式不占位），「退出」才是提交入口；
 *     回执后重读会话投影，徽标不在本地抢跑；
 *   * 目标状态条只渲染服务端给的行动入口（actions），空闲态整条不渲染；细节默认折叠；
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

describe("聊天模式状态徽标", () => {
  it("普通模式不渲染任何模式控件，也没有下拉框", async () => {
    const view = await mountReact(createElement(ChatModeSwitch, {
      mode: "CHAT", disabled: false, busy: false, lockedReason: null, onChange: vi.fn() }));
    try {
      expect(view.wrapper.find('[data-testid="chat-mode-badge"]').exists()).toBe(false);
      expect(view.wrapper.find("select").exists()).toBe(false);
    } finally { view.unmount(); }
  });

  it("计划/目标模式显示静态徽标；「退出」才是提交入口", async () => {
    const onChange = vi.fn();
    const view = await mountReact(createElement(ChatModeSwitch, {
      mode: "GOAL", disabled: false, busy: false, lockedReason: null, onChange }));
    try {
      const badge = view.wrapper.get('[data-testid="chat-mode-badge"]');
      // 2026-10-25 用户指令：档名不带「模式」二字，识别交给图标与字色。
      expect(badge.text()).toContain("目标");
      expect(badge.text()).not.toContain("模式");
      expect(view.wrapper.find("select").exists()).toBe(false);
      // 徽标本身不是选择器：点它不发命令。
      await badge.trigger("click");
      expect(onChange).not.toHaveBeenCalled();
      await view.wrapper.get('[data-testid="chat-mode-exit"]').trigger("click");
      expect(onChange).toHaveBeenCalledWith("CHAT");
    } finally { view.unmount(); }
    expect(onChange).toHaveBeenCalledTimes(1);
  });

  it("在途或禁用时退出键不可点，锁定原因写在 title 上", async () => {
    const view = await mountReact(createElement(ChatModeSwitch, {
      mode: "PLAN", disabled: false, busy: true,
      lockedReason: "正在生成，停止后才能切换模式。", onChange: vi.fn() }));
    try {
      const exit = view.wrapper.get('[data-testid="chat-mode-exit"]');
      expect(exit.attributes("disabled")).toBeDefined();
      expect(exit.attributes("title")).toContain("正在生成");
    } finally { view.unmount(); }
  });

  it("说明行只在非普通模式出现；停止中的目标按目标状态投影，不宣称停下后进入哪一档（DEV-0105 退回项）", () => {
    expect(ChatModeHint({ mode: "CHAT", goalStatus: null })).toBeNull();
    const planHint = ChatModeHint({ mode: "PLAN", goalStatus: null });
    expect(planHint?.props["data-testid"]).toBe("chat-mode-hint");
    // 目标模式内暂停：说明正在安全停止，不装作已经暂停。
    const pausingInGoal = ChatModeHint({ mode: "GOAL", goalStatus: "PAUSING" });
    expect(pausingInGoal?.props.children).toContain("安全停止");
    expect(pausingInGoal?.props.children).toContain("暂停");
    // 退出 GOAL→CHAT：会话已回普通模式、目标还在停下。文案只说目标事实，
    // 不再按会话模式写「停下后才会进入计划模式」（该句只在真切到 PLAN 时才成立）。
    const pausingAfterExit = ChatModeHint({ mode: "CHAT", goalStatus: "PAUSING" });
    expect(pausingAfterExit?.props.children).toContain("安全停止");
    expect(pausingAfterExit?.props.children).not.toContain("计划模式");
    const pausingToPlan = ChatModeHint({ mode: "PLAN", goalStatus: "PAUSING" });
    expect(pausingToPlan?.props.children).not.toContain("进入计划模式");
    // 取消中的目标：说明终止且不再推进，不承诺可恢复。
    const cancelling = ChatModeHint({ mode: "CHAT", goalStatus: "CANCELLING" });
    expect(cancelling?.props.children).toContain("取消");
    expect(cancelling?.props.children).toContain("不再推进");
    expect(cancelling?.props.children).not.toContain("恢复");
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

describe("目标单行状态条", () => {
  it("没有目标时整条不渲染，不给空壳", async () => {
    const view = await mountReact(createElement(GoalCard, { view: null, busy: false,
      error: null, onPause: vi.fn(), onCancel: vi.fn(), onResume: vi.fn(), onConfirm: vi.fn() }));
    try {
      expect(view.wrapper.find('[data-testid="goal-card"]').exists()).toBe(false);
    } finally { view.unmount(); }
  });

  it("默认单行：状态与轮次可见，成功条件在展开区，再点收起", async () => {
    const view = await mountReact(createElement(GoalCard, { view: goalView("ACTIVE"),
      busy: false, error: null, onPause: vi.fn(), onCancel: vi.fn(), onResume: vi.fn(),
      onConfirm: vi.fn() }));
    try {
      // 单行常驻事实：状态徽标、目标正文、轮次计数都在行上。
      expect(view.wrapper.get('[data-testid="goal-card-status"]').text()).toBe("正在推进");
      expect(view.wrapper.get('[data-testid="goal-card-objective"]').text()).toBe("把 README 改到能跑");
      expect(view.wrapper.get('[data-testid="goal-card-rounds"]').text()).toContain("第 2 轮");
      // 细节默认折叠：成功条件不占消息流。
      expect(view.wrapper.find('[data-testid="goal-card-details"]').exists()).toBe(false);
      await view.wrapper.get('[data-testid="goal-card-toggle"]').trigger("click");
      expect(view.wrapper.find('[data-testid="goal-card-details"]').exists()).toBe(true);
      await view.wrapper.get('[data-testid="goal-card-toggle"]').trigger("click");
      expect(view.wrapper.find('[data-testid="goal-card-details"]').exists()).toBe(false);
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
      await view.wrapper.get('[data-testid="goal-card-toggle"]').trigger("click");
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

describe("退出聊天模式（AssistView 接线）", () => {
  const baseUrl = "http://127.0.0.1:8787";
  const workspaceId = "11111111-1111-4111-8111-111111111111";
  const projectId = "22222222-2222-4222-8222-222222222222";
  const sessionId = "33333333-3333-4333-8333-333333333333";
  const prefix = `/api/v1/workspaces/${workspaceId}`;

  function response(body: unknown, status = 200): Response {
    return { ok: status < 400, status, json: async () => body } as Response;
  }

  afterEach(() => { resetRelayConnectionForTest(); vi.unstubAllGlobals(); });

  it("退出回执后重读会话投影，徽标随服务端模式一起消失", async () => {
    activateRelayConnection({ baseUrl, workspaceId, bearerToken: "test-token" });
    // 服务端真值是唯一来源：POST 改状态，后续列表读回 CHAT。
    let chatMode: "CHAT" | "GOAL" = "GOAL";
    const modePosts: string[] = [];
    const session = () => ({ id: sessionId, workspace_id: workspaceId, project_id: projectId,
      task_id: null, title: "模式徽标接线", status: "ACTIVE", revision: "1",
      conversation_mode: "AGENT", chat_mode: chatMode,
      created_at: "2026-10-22T00:00:00Z", updated_at: "2026-10-22T00:00:00Z" });
    const fetchMock = vi.fn(async (input: string, init?: RequestInit) => {
      const path = new URL(String(input)).pathname;
      if (path === `${prefix}/projects/${projectId}`) return response({ id: projectId,
        title: "测试项目", project_type: "GENERAL", revision: "1", state_revision: "1",
        archived_at: null });
      if (path === `${prefix}/assist-sessions`) return response({ items: [session()] });
      if (path === `${prefix}/assist-sessions/${sessionId}/messages`) return response({ items: [] });
      if (path === `${prefix}/assist-sessions/${sessionId}/goal`) return response({ goal: null, rounds: [] });
      if (path === `${prefix}/assist-sessions/${sessionId}/plans`)
        return response({ latest: null, versions: [] });
      if (path === `${prefix}/assist-sessions/${sessionId}/model-selection`)
        return response({ model: null, revision: "0" });
      if (path === `${prefix}/assist-sessions/${sessionId}/chat-mode` && init?.method === "POST") {
        modePosts.push(path);
        const body = JSON.parse(String(init.body ?? "{}")) as Record<string, unknown>;
        chatMode = body.mode === "CHAT" ? "CHAT" : "GOAL";
        return response({ command_id: body.command_id, committed_at: "2026-10-22T00:00:00Z",
          result: { session_id: sessionId, chat_mode: chatMode, revision: "2",
            goal_stopping: false } });
      }
      if (path === `${prefix}/assist-proposals`) return response({ items: [] });
      if (path === `${prefix}/skill-definitions`) return response({ items: [] });
      if (path === `${prefix}/model-port`) return response({ provider: "fake", configured: false,
        model: null, base_url: null, max_call_tokens: null });
      throw new Error(`unexpected request ${path}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    const view = await mountWorkbench(`/projects/${projectId}?skill=assist`);
    try {
      expect(view.wrapper.get('[data-testid="chat-mode-badge"]').text()).toContain("目标");
      expect(view.wrapper.find('[data-testid="chat-mode-select"]').exists()).toBe(false);
      await view.wrapper.get('[data-testid="chat-mode-exit"]').trigger("click");
      await flush(80);
      expect(modePosts).toHaveLength(1);
      expect(feedbackText("assist-receipt-notice")).toContain("已切换回普通模式");
      // 徽标读的是重读后的会话投影：不重读时它会一直停在目标模式（探针复现过）。
      expect(view.wrapper.find('[data-testid="chat-mode-badge"]').exists()).toBe(false);
    } finally { view.unmount(); }
  });

  /** goalFrom 需要的原始服务端行：只给接线测试用，字段集与投影函数一一对应。 */
  function rawGoal(status: string): Record<string, unknown> {
    return { goal_id: "goal-1", session_id: sessionId, objective: "持续把文档整理完",
      status, current_step: null, progress: null, stop_reason: null,
      criteria: [], steps: [], round_count: 1, no_progress_rounds: 0,
      plan_version_id: null, plan_version: null, last_round_at: null,
      actions: { pause: false, cancel: false, resume: status === "PAUSED",
        confirm_completion: false },
      revision: "1", created_at: "2026-10-24T00:00:00Z", updated_at: "2026-10-24T00:00:00Z" };
  }

  it("活动目标在途时退出 GOAL：说明行报安全停止，不误报计划模式；目标停下后说明行随服务端状态消失", async () => {
    activateRelayConnection({ baseUrl, workspaceId, bearerToken: "test-token" });
    let chatMode: "CHAT" | "GOAL" = "GOAL";
    let goalStatus: string = "ACTIVE";
    const session = () => ({ id: sessionId, workspace_id: workspaceId, project_id: projectId,
      task_id: null, title: "活动目标退出", status: "ACTIVE", revision: "1",
      conversation_mode: "AGENT", chat_mode: chatMode,
      created_at: "2026-10-24T00:00:00Z", updated_at: "2026-10-24T00:00:00Z" });
    const fetchMock = vi.fn(async (input: string, init?: RequestInit) => {
      const path = new URL(String(input)).pathname;
      if (path === `${prefix}/projects/${projectId}`) return response({ id: projectId,
        title: "测试项目", project_type: "GENERAL", revision: "1", state_revision: "1",
        archived_at: null });
      if (path === `${prefix}/assist-sessions`) return response({ items: [session()] });
      if (path === `${prefix}/assist-sessions/${sessionId}/messages`) return response({ items: [] });
      if (path === `${prefix}/assist-sessions/${sessionId}/goal`) {
        return response({ goal: goalStatus === "NONE" ? null : rawGoal(goalStatus), rounds: [] });
      }
      if (path === `${prefix}/assist-sessions/${sessionId}/plans`)
        return response({ latest: null, versions: [] });
      if (path === `${prefix}/assist-sessions/${sessionId}/model-selection`)
        return response({ model: null, revision: "0" });
      if (path === `${prefix}/assist-sessions/${sessionId}/chat-mode` && init?.method === "POST") {
        const body = JSON.parse(String(init.body ?? "{}")) as Record<string, unknown>;
        // 服务端语义：切走时模式立即落定，目标才进入 PAUSING 慢慢停（chat-mode.ts 的投影）。
        chatMode = body.mode === "CHAT" ? "CHAT" : "GOAL";
        if (chatMode === "CHAT") goalStatus = "PAUSING";
        return response({ command_id: body.command_id, committed_at: "2026-10-24T00:00:00Z",
          result: { session_id: sessionId, chat_mode: chatMode, revision: "2",
            goal_stopping: chatMode === "CHAT" } });
      }
      if (path === `${prefix}/assist-proposals`) return response({ items: [] });
      if (path === `${prefix}/skill-definitions`) return response({ items: [] });
      if (path === `${prefix}/model-port`) return response({ provider: "fake", configured: false,
        model: null, base_url: null, max_call_tokens: null });
      throw new Error(`unexpected request ${path}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    const view = await mountWorkbench(`/projects/${projectId}?skill=assist`);
    try {
      // 活动目标 + 目标模式：说明行是目标模式描述。
      expect(view.wrapper.get('[data-testid="chat-mode-hint"]').text()).toContain("目标模式");
      await view.wrapper.get('[data-testid="chat-mode-exit"]').trigger("click");
      await flush(80);
      // 回执后目标仍在安全停止：说明行只报停止事实，不按普通模式误报「进入计划模式」。
      const hint = view.wrapper.get('[data-testid="chat-mode-hint"]').text();
      expect(hint).toContain("安全停止");
      expect(hint).not.toContain("计划模式");
    } finally { view.unmount(); }
    // 重载恢复：目标是 PAUSED、会话是普通模式时（刷新后读到的服务端事实），说明行不出现。
    chatMode = "CHAT"; goalStatus = "PAUSED";
    const reloaded = await mountWorkbench(`/projects/${projectId}?skill=assist`);
    try {
      expect(reloaded.wrapper.find('[data-testid="chat-mode-hint"]').exists()).toBe(false);
    } finally { reloaded.unmount(); }
  });
});
