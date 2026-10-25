import { act, createElement, type FC } from "react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import AssistView from "../src/views/AssistView";
import { activateRelayConnection, resetRelayConnectionForTest } from "../src/lib/relayConnection";
import { mountReact } from "./mountApp";

/**
 * 计划/目标投影读取失败恢复（禅道 #122）。
 *
 * 锁五件事：
 *   * 读取失败不冒充「无目标」：目标卡撤下的同时必须出现读取错误与重试入口；
 *   * 页内刷新（assist-refresh）与页内重试都能恢复，不需要离开会话；
 *   * 失败期间不做无界快速自动重试；恢复后 15 秒轮询继续工作；
 *   * 403/404 失权与暂时性失败分开说明；
 *   * 读取成功且为空才是「确实无目标」，不显示错误。
 */
const wid = "11111111-1111-4111-8111-111111111111";
const pid = "22222222-2222-4222-8222-222222222222";
const sid = "33333333-3333-4333-8333-333333333333";

afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); resetRelayConnectionForTest(); vi.unstubAllGlobals(); });

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body),
  { status, headers: { "content-type": "application/json" } });

interface GoalProbeOptions {
  /** 目标 GET 的失败状态码；null 表示健康。 */
  failGoalWith?: number | null;
  /** 计划 GET 的失败状态码；null 表示健康。 */
  failPlansWith?: number | null;
  /** 服务端目标状态；null 表示确实无目标。 */
  goalStatus?: string | null;
}

async function mountGoalProbe(options: GoalProbeOptions = {}) {
  const { goalStatus = "ACTIVE" } = options;
  /** 运行中可控的失败注入：测试在挂载后切换服务端故障状态。 */
  const control = { failGoalWith: options.failGoalWith ?? null, failPlansWith: options.failPlansWith ?? null };
  const counters = { goalReads: 0, messageReads: 0 };
  const session = { id: sid, workspace_id: wid, project_id: pid, task_id: null,
    title: "goal recovery probe", status: "ACTIVE", revision: "1", chat_mode: "GOAL",
    created_at: "2026-10-23T00:00:00Z", updated_at: "2026-10-23T00:00:00Z" };
  const goal = { goal_id: "44444444-4444-4444-8444-444444444444", session_id: sid,
    objective: "GOAL_RECOVERY_PROBE", status: goalStatus, current_step: null, progress: null,
    stop_reason: null, criteria: [], steps: [], round_count: 1, no_progress_rounds: 0,
    plan_version_id: null, plan_version: null, last_round_at: null,
    actions: { pause: true, cancel: true, resume: false, confirm_completion: false },
    revision: "1", created_at: "2026-10-23T00:00:00Z", updated_at: "2026-10-23T00:00:00Z" };
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
    const p = new URL(String(input)).pathname;
    if (p.endsWith(`/projects/${pid}`)) return json({ id: pid, title: "goal project",
      project_type: "GENERAL", revision: "1", state_revision: "1", archived_at: null });
    if (p.endsWith(`/projects/${pid}/state`)) return json({ project_id: pid, revision: "1",
      phase_key: "GENERAL", next_action_task_id: null, selected_artifact_version_refs: [],
      completed_highlight_refs: [] });
    if (p.endsWith("/assist-sessions")) return json({ items: [session] });
    if (p.endsWith(`/assist-sessions/${sid}`)) return json(session);
    if (p.endsWith(`/assist-sessions/${sid}/goal`)) {
      counters.goalReads++;
      return control.failGoalWith !== null
        ? json({ code: "DATABASE_UNAVAILABLE", title: "数据库暂不可用", detail: "临时读取失败" }, control.failGoalWith)
        : json({ goal: goalStatus === null ? null : goal, rounds: [] });
    }
    if (p.endsWith(`/assist-sessions/${sid}/plans`)) {
      return control.failPlansWith !== null
        ? json({ code: "DATABASE_UNAVAILABLE", title: "数据库暂不可用", detail: "临时读取失败" }, control.failPlansWith)
        : json({ latest: null, versions: [] });
    }
    if (p.endsWith(`/assist-sessions/${sid}/messages`)) { counters.messageReads++; return json({ items: [] }); }
    if (p.endsWith("/model-selection")) return json({ model: null, revision: "0" });
    if (p.endsWith("/model-port/verification")) return json({ current_config_fingerprint: null,
      last: null, matches_current_config: false, worker_startup_validation: "NOT_CONFIGURED" });
    if (p.endsWith("/model-port")) return json({ provider: "fake", configured: false, model: null,
      base_url: null, max_call_tokens: null });
    if (p.endsWith("/default-working-directory")) return json({ resource_id: null,
      canonical_root: null, display_name: null, write_tier: null, default_write_tier: null,
      status: "UNSET", reason: null, revision: "0" });
    if (p.endsWith("/memory-settings")) return json({ workspace_id: wid, revision: "0",
      recall_enabled: true, automatic_compaction: true, auto_capture: true });
    return json({ items: [], next_cursor: null });
  }));
  activateRelayConnection({ baseUrl: "http://127.0.0.1:8787", workspaceId: wid, bearerToken: "test-token" });
  // AssistView 的 props 类型内联在超长签名里，createElement 直接推断会失败；
  // 这里按它实际消费的两个 prop 做最小断言（无 Routes match 时 params.id 为空，必须显式给 target）。
  const AssistViewElement = AssistView as FC<{ targetKind?: "PROJECT" | "TASK"; targetId?: string }>;
  const element = () => createElement(MemoryRouter, { initialEntries: [`/projects/${pid}?skill=assist`] },
    createElement(AssistViewElement, { targetKind: "PROJECT", targetId: pid }));
  const mounted = await mountReact(element());
  return { ...mounted, counters, control, element };
}

const advance = async (milliseconds: number) => {
  await act(async () => { await vi.advanceTimersByTimeAsync(milliseconds); });
};

describe("目标投影读取失败恢复", () => {
  it("轮询读取失败后卡片撤下但错误可见；页内刷新恢复且轮询继续，无无界自动重试", async () => {
    vi.useFakeTimers();
    const probe = await mountGoalProbe();
    const mounted = probe;
    try {
      await advance(100);
      expect(mounted.wrapper.find('[data-testid="goal-card"]').exists()).toBe(true);
      probe.control.failGoalWith = 503;
      await advance(16000);
      // 卡片撤下，但失败不再是静默的：读取错误与页内重试同时出现。
      expect(mounted.wrapper.find('[data-testid="goal-card"]').exists()).toBe(false);
      const errorBlock = mounted.wrapper.get('[data-testid="goal-projection-read-error"]');
      expect(errorBlock.text()).toContain("目标与计划状态读取失败");
      expect(mounted.wrapper.find('[data-testid="goal-projection-retry"]').exists()).toBe(true);
      const readsAfterFailure = probe.counters.goalReads;
      // 服务恢复但用户未操作：不做无界快速自动重试，读取数保持不变。
      probe.control.failGoalWith = null;
      await advance(60000);
      expect(probe.counters.goalReads).toBe(readsAfterFailure);
      // 页内刷新覆盖投影：消息与目标一起重读，卡片恢复、错误结清。
      const beforeRefreshMessages = probe.counters.messageReads;
      await mounted.wrapper.get('[data-testid="assist-refresh"]').trigger("click");
      await advance(100);
      expect(probe.counters.messageReads).toBeGreaterThan(beforeRefreshMessages);
      expect(mounted.wrapper.find('[data-testid="goal-card"]').exists()).toBe(true);
      expect(mounted.wrapper.find('[data-testid="goal-projection-read-error"]').exists()).toBe(false);
      // 恢复后 15 秒轮询继续工作。
      const readsAfterRecovery = probe.counters.goalReads;
      await advance(16000);
      expect(probe.counters.goalReads).toBeGreaterThan(readsAfterRecovery);
    } finally { mounted.unmount(); }
    // 健康对照：重新进入同一会话，目标卡照常出现。
    const healthy = await mountGoalProbe();
    try {
      await advance(100);
      expect(healthy.wrapper.find('[data-testid="goal-card"]').exists()).toBe(true);
    } finally { healthy.unmount(); }
  });

  it("页内重试按钮同样能恢复目标卡", async () => {
    vi.useFakeTimers();
    const probe = await mountGoalProbe();
    try {
      await advance(100);
      expect(probe.wrapper.find('[data-testid="goal-card"]').exists()).toBe(true);
      probe.control.failGoalWith = 503;
      await advance(16000);
      expect(probe.wrapper.find('[data-testid="goal-card"]').exists()).toBe(false);
      probe.control.failGoalWith = null;
      await probe.wrapper.get('[data-testid="goal-projection-retry"]').trigger("click");
      await advance(100);
      expect(probe.wrapper.find('[data-testid="goal-card"]').exists()).toBe(true);
      expect(probe.wrapper.find('[data-testid="goal-projection-read-error"]').exists()).toBe(false);
    } finally { probe.unmount(); }
  });

  it("403 失权与暂时性失败分开说明", async () => {
    vi.useFakeTimers();
    const denied = await mountGoalProbe({ failGoalWith: 403 });
    try {
      await advance(100);
      expect(denied.wrapper.get('[data-testid="goal-projection-read-error"]').text())
        .toContain("不可见或无权读取");
      expect(denied.wrapper.get('[data-testid="goal-projection-read-error"]').text())
        .not.toContain("数据库不可达");
    } finally { denied.unmount(); }
    const transient = await mountGoalProbe({ failGoalWith: 503 });
    try {
      await advance(100);
      expect(transient.wrapper.get('[data-testid="goal-projection-read-error"]').text())
        .toContain("数据库不可达");
      expect(transient.wrapper.get('[data-testid="goal-projection-read-error"]').text())
        .not.toContain("不可见或无权读取");
    } finally { transient.unmount(); }
  });

  it("读取成功且为空才是确实无目标，不显示读取错误", async () => {
    vi.useFakeTimers();
    const probe = await mountGoalProbe({ goalStatus: null });
    try {
      await advance(100);
      expect(probe.wrapper.find('[data-testid="goal-card"]').exists()).toBe(false);
      expect(probe.wrapper.find('[data-testid="goal-projection-read-error"]').exists()).toBe(false);
    } finally { probe.unmount(); }
  });

  it("计划读取失败同样显示读取错误，不冒充无计划", async () => {
    vi.useFakeTimers();
    const probe = await mountGoalProbe({ failPlansWith: 503 });
    try {
      await advance(100);
      expect(probe.wrapper.find('[data-testid="goal-card"]').exists()).toBe(false);
      expect(probe.wrapper.get('[data-testid="goal-projection-read-error"]').text())
        .toContain("目标与计划状态读取失败");
    } finally { probe.unmount(); }
  });
});
