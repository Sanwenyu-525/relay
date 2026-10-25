import { afterEach, describe, expect, it, vi } from "vitest";
import { activateRelayConnection, resetRelayConnectionForTest } from "../src/lib/relayConnection";
import { flush, mountWorkbench } from "./mountApp";

/**
 * 项目任务页前置详情读取失败恢复（禅道 #113）。
 *
 * 锁五件事：
 *   * 前置详情读取失败要在局部可见、可原地重试，不能静默清成空依赖；
 *   * 重试不产生 POST、不绕过 START 门槛（仍只按服务端 allowed_actions）；
 *   * 403/404 按失权说明并撤下重试入口，与暂时性失败分开；
 *   * 上一任务的迟到失败不污染新选择；
 *   * 确实无依赖与读取失败文案不同。
 */
const wid = "11111111-1111-4111-8111-111111111111";
const pid = "22222222-2222-4222-8222-222222222222";
const tid = "33333333-3333-4333-8333-333333333333";
const dep = "44444444-4444-4444-8444-444444444444";
const depTitle = "可恢复前置任务名称";

function response(body: unknown, status = 200): Response {
  return { ok: status < 400, status, json: async () => body } as Response;
}

function task(overrides: Record<string, unknown> = {}) {
  return { id: tid, title: "唯一任务等待前置", project_id: pid, status: "READY", mode: "ME",
    revision: "0", executor: { kind: "HUMAN", run_id: null }, current_completion_id: null,
    waiting_reason: null, blocking_task_ids: [dep], unresolved_blocker_ids: [],
    allowed_actions: [], ...overrides };
}

function detail(overrides: Record<string, unknown> = {}) {
  return { ...task(), acceptance: { acceptance_revision: "1", objective: "objective",
    source: "CREATE", criteria: [] },
    dependencies: [{ task_id: dep, dependency_kind: "REQUIRED", title: depTitle, status: "INBOX" }],
    ...overrides };
}

interface Harness {
  detailReads: number;
  postCount: number;
  setHealthy: (healthy: boolean) => void;
}

/** 挂载 /projects/{pid}/tasks，前置详情读取可控；健康后详情返回原前置 D。 */
async function mountWithDependencyControl(): Promise<{ wrapper: Awaited<ReturnType<typeof mountWorkbench>>["wrapper"]; unmount: () => void; harness: Harness }> {
  let healthy = false;
  const harness: Harness = {
    detailReads: 0, postCount: 0,
    setHealthy: (value) => { healthy = value; }
  };
  const blocked = task();
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    if ((init?.method ?? "GET") !== "GET") { harness.postCount++; return response({}); }
    if (url.pathname.endsWith(`/projects/${pid}`)) return response({ id: pid,
      title: "dependency recovery project", project_type: "GENERAL", revision: "1",
      state_revision: "1", archived_at: null });
    if (url.pathname.endsWith("/tasks") && url.searchParams.get("project_id") === pid)
      return response({ items: [blocked], next_cursor: null });
    if (url.pathname.endsWith(`/tasks/${tid}`)) {
      harness.detailReads++;
      if (!healthy) return response({ code: "DATABASE_UNAVAILABLE", detail: "temporary dependency detail read failure" }, 503);
      return response(detail());
    }
    if (url.pathname.endsWith("/attention/interventions")) return response({ items: [] });
    return response({ items: [], next_cursor: null });
  }));
  activateRelayConnection({ baseUrl: "http://127.0.0.1:8787", workspaceId: wid, bearerToken: "test-token" });
  const mounted = await mountWorkbench(`/projects/${pid}/tasks`);
  return { wrapper: mounted.wrapper, unmount: mounted.unmount, harness };
}

afterEach(() => { resetRelayConnectionForTest(); vi.unstubAllGlobals(); sessionStorage.clear(); });

describe("项目任务前置详情读取失败恢复", () => {
  it("首次读取失败局部可见且不冒充空依赖；显式重试成功后恢复原前置，不发 POST", async () => {
    const { wrapper, unmount, harness } = await mountWithDependencyControl();
    try {
      await flush();
      // 失败可见：局部错误文案出现，且不是「无依赖」的口径。
      const errorBlock = wrapper.get('[data-testid="project-task-dependency-error"]');
      expect(errorBlock.text()).toContain("前置任务详情读取失败");
      expect(errorBlock.text()).toContain("数据库不可达");
      // 不把失败等价为空依赖：已知前置数量仍按列表展示，重试入口在场。
      expect(wrapper.text()).toContain("1 个前置任务");
      expect(wrapper.find('[data-testid="project-task-dependency-retry"]').exists()).toBe(true);
      // 局部失败不清项目任务清单，也不绕过 START 门槛。
      expect(wrapper.find(`[data-testid="project-task-row-${tid}"]`).exists()).toBe(true);
      expect(wrapper.get('[data-testid="project-task-start"]').attributes("disabled")).toBeDefined();

      harness.setHealthy(true);
      const readsBeforeRetry = harness.detailReads;
      const postsBeforeRetry = harness.postCount;
      await wrapper.get('[data-testid="project-task-dependency-retry"]').trigger("click");
      await flush();
      expect(wrapper.text()).toContain(depTitle);
      expect(wrapper.find('[data-testid="project-task-dependency-error"]').exists()).toBe(false);
      // 重试只读详情：不产生新的 POST，也不触发开始任务。
      expect(harness.detailReads).toBe(readsBeforeRetry + 1);
      expect(harness.postCount).toBe(postsBeforeRetry);
      expect(wrapper.get('[data-testid="project-task-start"]').attributes("disabled")).toBeDefined();
    } finally { unmount(); }
  });

  it("连续失败仍可再次重试，不需要切页或重挂", async () => {
    const { wrapper, unmount, harness } = await mountWithDependencyControl();
    try {
      await flush();
      expect(wrapper.find('[data-testid="project-task-dependency-error"]').exists()).toBe(true);
      await wrapper.get('[data-testid="project-task-dependency-retry"]').trigger("click");
      await flush();
      const readsAfterFirstRetry = harness.detailReads;
      expect(wrapper.find('[data-testid="project-task-dependency-retry"]').exists()).toBe(true);
      await wrapper.get('[data-testid="project-task-dependency-retry"]').trigger("click");
      await flush();
      expect(harness.detailReads).toBe(readsAfterFirstRetry + 1);
      expect(wrapper.find('[data-testid="project-task-dependency-error"]').exists()).toBe(true);
    } finally { unmount(); }
  });

  it("403 按失权说明并撤下重试入口，不冒充数据库故障", async () => {
    const blocked = task();
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(String(input));
      if (url.pathname.endsWith(`/projects/${pid}`)) return response({ id: pid,
        title: "dependency recovery project", project_type: "GENERAL", revision: "1",
        state_revision: "1", archived_at: null });
      if (url.pathname.endsWith("/tasks") && url.searchParams.get("project_id") === pid)
        return response({ items: [blocked], next_cursor: null });
      if (url.pathname.endsWith(`/tasks/${tid}`))
        return response({ code: "PERMISSION_DENIED", detail: "task detail revoked" }, 403);
      if (url.pathname.endsWith("/attention/interventions")) return response({ items: [] });
      return response({ items: [], next_cursor: null });
    }));
    activateRelayConnection({ baseUrl: "http://127.0.0.1:8787", workspaceId: wid, bearerToken: "test-token" });
    const mounted = await mountWorkbench(`/projects/${pid}/tasks`);
    try {
      await flush();
      const errorBlock = mounted.wrapper.get('[data-testid="project-task-dependency-error"]');
      expect(errorBlock.text()).toContain("不可见或无权读取");
      expect(errorBlock.text()).not.toContain("数据库不可达");
      expect(mounted.wrapper.find('[data-testid="project-task-dependency-retry"]').exists()).toBe(false);
    } finally { mounted.unmount(); }
  });

  it("上一任务的迟到失败不污染新选择的依赖与错误状态", async () => {
    const tidA = tid;
    const tidB = "55555555-5555-4555-8555-555555555555";
    const depB = "66666666-6666-4666-8666-666666666666";
    let rejectA: ((reason: unknown) => void) | undefined;
    const taskA = task({ id: tidA, title: "任务A等待前置" });
    const taskB = task({ id: tidB, title: "任务B等待自己的前置", blocking_task_ids: [depB],
      allowed_actions: ["START"] });
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(String(input));
      if (url.pathname.endsWith(`/projects/${pid}`)) return response({ id: pid,
        title: "dependency recovery project", project_type: "GENERAL", revision: "1",
        state_revision: "1", archived_at: null });
      if (url.pathname.endsWith("/tasks") && url.searchParams.get("project_id") === pid)
        return response({ items: [taskA, taskB], next_cursor: null });
      if (url.pathname.endsWith(`/tasks/${tidA}`))
        return new Promise((_resolve, reject) => { rejectA = reject; });
      if (url.pathname.endsWith(`/tasks/${tidB}`))
        return response({ ...taskB, acceptance: { acceptance_revision: "1", objective: "objective",
          source: "CREATE", criteria: [] },
          dependencies: [{ task_id: depB, dependency_kind: "REQUIRED",
            title: "任务B自己的前置", status: "READY" }] });
      if (url.pathname.endsWith("/attention/interventions")) return response({ items: [] });
      return response({ items: [], next_cursor: null });
    }));
    activateRelayConnection({ baseUrl: "http://127.0.0.1:8787", workspaceId: wid, bearerToken: "test-token" });
    const mounted = await mountWorkbench(`/projects/${pid}/tasks`);
    try {
      await flush();
      // 首个被选中的是 blocked 的任务A，它的详情读取被挂起。
      expect(rejectA).toBeDefined();
      await mounted.wrapper.get(`[data-testid="project-task-row-${tidB}"]`).trigger("click");
      await flush();
      expect(mounted.wrapper.text()).toContain("任务B自己的前置");
      // 任务A的详情此刻才迟到失败：不得清掉任务B的前置，也不得给任务B挂读取错误。
      rejectA!(new Error("late dependency failure"));
      await flush();
      expect(mounted.wrapper.text()).toContain("任务B自己的前置");
      expect(mounted.wrapper.find('[data-testid="project-task-dependency-error"]').exists()).toBe(false);
    } finally { mounted.unmount(); }
  });

  it("确实无依赖时不显示读取失败或读取中的文案", async () => {
    const standalone = task({ blocking_task_ids: [], allowed_actions: ["START"] });
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(String(input));
      if (url.pathname.endsWith(`/projects/${pid}`)) return response({ id: pid,
        title: "dependency recovery project", project_type: "GENERAL", revision: "1",
        state_revision: "1", archived_at: null });
      if (url.pathname.endsWith("/tasks") && url.searchParams.get("project_id") === pid)
        return response({ items: [standalone], next_cursor: null });
      if (url.pathname.endsWith(`/tasks/${tid}`)) return response({ ...standalone,
        acceptance: { acceptance_revision: "1", objective: "objective", source: "CREATE",
          criteria: [] }, dependencies: [] });
      if (url.pathname.endsWith("/attention/interventions")) return response({ items: [] });
      return response({ items: [], next_cursor: null });
    }));
    activateRelayConnection({ baseUrl: "http://127.0.0.1:8787", workspaceId: wid, bearerToken: "test-token" });
    const mounted = await mountWorkbench(`/projects/${pid}/tasks`);
    try {
      await flush();
      expect(mounted.wrapper.text()).toContain("无");
      expect(mounted.wrapper.find('[data-testid="project-task-dependency-error"]').exists()).toBe(false);
      expect(mounted.wrapper.find('[data-testid="project-task-dependency-reading"]').exists()).toBe(false);
      expect(mounted.wrapper.find('[data-testid="project-task-dependency-empty"]').exists()).toBe(false);
    } finally { mounted.unmount(); }
  });
});
