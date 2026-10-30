import { createElement } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import ChatModeSwitch, { ChatModeHint, chatModeLabel } from "../src/components/ChatModeSwitch";
import GoalCard from "../src/components/GoalCard";
import PlanCard from "../src/components/PlanCard";
import { chatModeCommandFromText } from "../src/lib/chatModeCommand";
import { activateRelayConnection, resetRelayConnectionForTest } from "../src/lib/relayConnection";
import type { RelayAssistPlan, RelayGoalView, RelayPlanView } from "../src/api/relayClient";
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
      const toggle = view.wrapper.get('[data-testid="goal-card-toggle"]');
      expect(toggle.attributes("aria-expanded")).toBe("false");
      expect(toggle.attributes("aria-controls")).toBe("goal-card-details");
      await toggle.trigger("click");
      expect(view.wrapper.find('[data-testid="goal-card-details"]').exists()).toBe(true);
      expect(view.wrapper.get('[data-testid="goal-card-toggle"]').attributes("aria-expanded")).toBe("true");
      await view.wrapper.get('[data-testid="goal-card-toggle"]').trigger("click");
      expect(view.wrapper.find('[data-testid="goal-card-details"]').exists()).toBe(false);
    } finally { view.unmount(); }
  });

  it("11 种服务端状态按真实投影显示：暂停中不说已暂停，待确认不说已完成", async () => {
    const expected: Record<string, string> = {
      ACTIVE: "正在推进", PAUSING: "正在暂停", PAUSED: "已暂停",
      CANCELLING: "正在取消", CANCELLED: "已取消", WAITING_USER: "等你决定",
      BLOCKED: "已阻塞", BUDGET_EXHAUSTED: "额度耗尽",
      AWAITING_ACCEPTANCE: "等你确认完成", COMPLETED: "已完成", FAILED: "失败",
    };
    const view = await mountReact(createElement(GoalCard, { view: goalView("ACTIVE"),
      busy: false, error: null, onPause: vi.fn(), onCancel: vi.fn(), onResume: vi.fn(),
      onConfirm: vi.fn() }));
    try {
      for (const [status, label] of Object.entries(expected)) {
        await view.rerender(createElement(GoalCard, { view: goalView(status),
          busy: false, error: null, onPause: vi.fn(), onCancel: vi.fn(), onResume: vi.fn(),
          onConfirm: vi.fn() }));
        expect(view.wrapper.get('[data-testid="goal-card-status"]').text(), status).toBe(label);
      }
      await view.rerender(createElement(GoalCard, { view: goalView("PAUSING"),
        busy: false, error: null, onPause: vi.fn(), onCancel: vi.fn(), onResume: vi.fn(),
        onConfirm: vi.fn() }));
      expect(view.wrapper.get('[data-testid="goal-card-status"]').text()).not.toBe("已暂停");
      await view.rerender(createElement(GoalCard, { view: goalView("AWAITING_ACCEPTANCE"),
        busy: false, error: null, onPause: vi.fn(), onCancel: vi.fn(), onResume: vi.fn(),
        onConfirm: vi.fn() }));
      expect(view.wrapper.get('[data-testid="goal-card-status"]').text()).not.toBe("已完成");
    } finally { view.unmount(); }
  });

  it("展开区按分组行给出当前步骤、进展、停止原因、条件依据与历史，不新增命令", async () => {
    const onPause = vi.fn(); const onResume = vi.fn();
    const view = await mountReact(createElement(GoalCard, {
      view: { goal: { ...goalView("BLOCKED").goal!, currentStep: "补回归测试",
          progress: "已完成前两步。", stopReason: { code: "NEEDS_INPUT", detail: "缺少登录超时规则",
            questions: ["超时多久算失败？"], resumable: true },
          steps: [{ title: "梳理现状", status: "DONE" }, { title: "补回归测试", status: "DOING" }] },
        rounds: [{ roundIndex: 1, outcome: "CONTINUE", note: "已立墙", createdAt: "2026-10-20T00:00:00Z" },
          { roundIndex: 2, outcome: "BLOCKED", note: null, createdAt: "2026-10-20T01:00:00Z" }] } as RelayGoalView,
      busy: false, error: null, onPause, onCancel: vi.fn(), onResume, onConfirm: vi.fn() }));
    try {
      await view.wrapper.get('[data-testid="goal-card-toggle"]').trigger("click");
      expect(view.wrapper.get('[data-testid="goal-card-objective-full"]').text()).toContain("把 README 改到能跑");
      expect(view.wrapper.get('[data-testid="goal-card-step"]').text()).toContain("补回归测试");
      expect(view.wrapper.get('[data-testid="goal-card-progress"]').text()).toContain("已完成前两步。");
      expect(view.wrapper.get('[data-testid="goal-card-reason"]').text()).toContain("缺少登录超时规则");
      expect(view.wrapper.get('[data-testid="goal-card-reason"]').text()).toContain("超时多久算失败？");
      expect(view.wrapper.get('[data-testid="goal-criterion-c1"]').text()).toContain("README 第 3 节");
      expect(view.wrapper.get('[data-testid="goal-card-steps"]').text()).toContain("1/2");
      expect(view.wrapper.get('[data-testid="goal-card-history"]').text()).toContain("最近 2 轮");
      // 展开是纯视图偏好：按钮仍只来自服务端 actions，没有触发任何控制命令。
      expect(onPause).not.toHaveBeenCalled();
      expect(onResume).not.toHaveBeenCalled();
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

  it("暂停与继续各发对应命令；在途时两个键都禁用，不排队第二次命令", async () => {
    const onPause = vi.fn(); const onResume = vi.fn();
    const view = await mountReact(createElement(GoalCard, { view: goalView("ACTIVE"),
      busy: false, error: null, onPause, onCancel: vi.fn(), onResume, onConfirm: vi.fn() }));
    try {
      await view.wrapper.get('[data-testid="goal-card-pause"]').trigger("click");
      expect(onPause).toHaveBeenCalledTimes(1);
      expect(onResume).not.toHaveBeenCalled();
      await view.rerender(createElement(GoalCard, {
        view: goalView("PAUSED", { actions: { pause: false, cancel: true, resume: true,
          confirmCompletion: false } }),
        busy: false, error: null, onPause, onCancel: vi.fn(), onResume, onConfirm: vi.fn() }));
      expect(view.wrapper.find('[data-testid="goal-card-pause"]').exists()).toBe(false);
      await view.wrapper.get('[data-testid="goal-card-resume"]').trigger("click");
      expect(onResume).toHaveBeenCalledTimes(1);
      await view.rerender(createElement(GoalCard, { view: goalView("ACTIVE"), busy: true,
        error: null, onPause, onCancel: vi.fn(), onResume, onConfirm: vi.fn() }));
      expect(view.wrapper.get('[data-testid="goal-card-pause"]').attributes("disabled")).toBeDefined();
      expect(view.wrapper.get('[data-testid="goal-card-cancel"]').attributes("disabled")).toBeDefined();
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

function planRecord(overrides: Partial<RelayAssistPlan> = {}): RelayAssistPlan {
  return {
    planId: "plan-2", sessionId: "session-1", version: 2, status: "CURRENT",
    goal: "登录流程重构", scope: ["web"],
    steps: [{ title: "梳理现状", detail: "列出入口与重复实现" },
      { title: "收敛接口", detail: "统一 token 读取" },
      { title: "补回归测试", detail: "覆盖成功与失败路径" },
      { title: "更新文档", detail: null }],
    verification: [{ statement: "人工走查", method: "HUMAN" },
      { statement: "回归测试通过", method: "AUTOMATED" }],
    openQuestions: ["旧入口是否保留一版兼容？"],
    sourceMessageId: "m1", createdAt: "2026-10-20T00:00:00Z", ...overrides };
}

function planView(overrides: Partial<RelayAssistPlan> = {}): RelayPlanView {
  const latest = planRecord(overrides);
  return { latest, versions: [
    planRecord({ planId: "plan-1", version: 1, status: "SUPERSEDED", goal: "旧",
      scope: [], steps: [], verification: [], openQuestions: [],
      sourceMessageId: "m0", createdAt: "2026-10-19T00:00:00Z" }),
    latest] };
}

describe("计划卡", () => {
  it("摘要显示确切版本、目标、前 3 步与验证；执行回调带这一版的确切 id", async () => {
    const onExecute = vi.fn();
    const view = await mountReact(createElement(PlanCard, { view: planView(), busy: false,
      error: null, onExecute, onCopy: vi.fn(), onDismiss: vi.fn() }));
    try {
      expect(view.wrapper.get('[data-testid="plan-card"]').attributes("data-version")).toBe("2");
      expect(view.wrapper.get('[data-testid="plan-card-goal"]').text()).toBe("登录流程重构");
      expect(view.wrapper.get('[data-testid="plan-card-title"]').text()).toContain("第 2 版");
      expect(view.wrapper.get('[data-testid="plan-card-steps"]').findAll("li")).toHaveLength(3);
      expect(view.wrapper.get('[data-testid="plan-card-steps"]').text()).toContain("梳理现状");
      expect(view.wrapper.get('[data-testid="plan-card-steps"]').text()).toContain("列出入口与重复实现");
      expect(view.wrapper.get('[data-testid="plan-card-steps"]').text()).not.toContain("更新文档");
      expect(view.wrapper.get('[data-testid="plan-card-verification"]').text()).toContain("人工走查");
      expect(view.wrapper.get('[data-testid="plan-card-more-steps"]').text()).toBe("查看全部 4 步");
      // 默认摘要：详情面板、完整步骤、版本历史都不占高。
      expect(view.wrapper.find('[data-testid="plan-card-details"]').exists()).toBe(false);
      await view.wrapper.get('[data-testid="plan-card-execute"]').trigger("click");
      expect(onExecute).toHaveBeenCalledWith("plan-2", 2);
    } finally { view.unmount(); }
  });

  it("查看全部步骤后展开完整细节：全部步骤、范围、验证、待定与版本历史", async () => {
    const view = await mountReact(createElement(PlanCard, { view: planView(), busy: false,
      error: null, onExecute: vi.fn(), onCopy: vi.fn(), onDismiss: vi.fn() }));
    try {
      const toggle = view.wrapper.get('[data-testid="plan-card-toggle"]');
      expect(toggle.attributes("aria-expanded")).toBe("false");
      expect(toggle.attributes("aria-controls")).toBeTruthy();
      await view.wrapper.get('[data-testid="plan-card-more-steps"]').trigger("click");
      expect(view.wrapper.get('[data-testid="plan-card-toggle"]').attributes("aria-expanded")).toBe("true");
      expect(view.wrapper.get('[data-testid="plan-card-details"]').exists()).toBe(true);
      expect(view.wrapper.get('[data-testid="plan-card-all-steps"]').findAll("li")).toHaveLength(4);
      expect(view.wrapper.get('[data-testid="plan-card-all-steps"]').text()).toContain("更新文档");
      expect(view.wrapper.get('[data-testid="plan-card-scope"]').text()).toContain("web");
      expect(view.wrapper.get('[data-testid="plan-card-verification-list"]').text()).toContain("回归测试通过");
      expect(view.wrapper.get('[data-testid="plan-card-questions"]').text()).toContain("旧入口是否保留一版兼容？");
      expect(view.wrapper.get('[data-testid="plan-card-details"]').text()).toContain("共 2 版");
      expect(view.wrapper.get('[data-testid="plan-card-history"]').text()).toContain("第 1 版");
      expect(view.wrapper.get('[data-testid="plan-version-1"]').text()).toContain("已被取代");
      expect(view.wrapper.get('[data-testid="plan-version-2"]').text()).toContain("当前有效");
      await view.wrapper.get('[data-testid="plan-card-toggle"]').trigger("click");
      expect(view.wrapper.find('[data-testid="plan-card-details"]').exists()).toBe(false);
    } finally { view.unmount(); }
  });

  it("没有结构化步骤时明确说明，不生成虚假清单", async () => {
    const view = await mountReact(createElement(PlanCard, {
      view: planView({ steps: [], scope: [], verification: [], openQuestions: [] }),
      busy: false, error: null, onExecute: vi.fn(), onCopy: vi.fn(), onDismiss: vi.fn() }));
    try {
      expect(view.wrapper.get('[data-testid="plan-card-no-steps"]').text()).toContain("还没有结构化步骤");
      expect(view.wrapper.find('[data-testid="plan-card-steps"]').exists()).toBe(false);
      expect(view.wrapper.find('[data-testid="plan-card-more-steps"]').exists()).toBe(false);
      expect(view.wrapper.get('[data-testid="plan-card-verification"]').text()).toContain("尚未指定验证标准");
      await view.wrapper.get('[data-testid="plan-card-toggle"]').trigger("click");
      expect(view.wrapper.get('[data-testid="plan-card-all-steps-empty"]').text()).toContain("还没有结构化步骤");
    } finally { view.unmount(); }
  });

  it("复制计划调用剪贴板回调并带上这一版 Markdown；不冒充导出文件", async () => {
    const onCopy = vi.fn();
    const view = await mountReact(createElement(PlanCard, { view: planView(), busy: false,
      error: null, onExecute: vi.fn(), onCopy, onDismiss: vi.fn() }));
    try {
      const copy = view.wrapper.get('[data-testid="plan-card-copy"]');
      expect(copy.text()).toBe("复制计划");
      expect(view.wrapper.find('[data-testid="plan-card-export"]').exists()).toBe(false);
      await copy.trigger("click");
      expect(onCopy).toHaveBeenCalledTimes(1);
      const [markdown, version] = onCopy.mock.calls[0] as [string, number];
      expect(version).toBe(2);
      expect(markdown).toContain("# 计划（第 2 版）");
      expect(markdown).toContain("4. 更新文档");
    } finally { view.unmount(); }
  });

  it("过期计划明确标注，版本历史仍指向确切版本", async () => {
    const view = await mountReact(createElement(PlanCard, {
      view: planView({ status: "SUPERSEDED" }), busy: false,
      error: null, onExecute: vi.fn(), onCopy: vi.fn(), onDismiss: vi.fn() }));
    try {
      expect(view.wrapper.get('[data-testid="plan-card-version-status"]').text()).toBe("已被更新版取代");
    } finally { view.unmount(); }
  });

  it("没有计划时不渲染", async () => {
    const view = await mountReact(createElement(PlanCard, { view: null, busy: false,
      error: null, onExecute: vi.fn(), onCopy: vi.fn(), onDismiss: vi.fn() }));
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
