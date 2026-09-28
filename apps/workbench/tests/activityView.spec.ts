import { afterEach, describe, expect, it, vi } from "vitest";
import { activateRelayConnection, resetRelayConnectionForTest } from "../src/lib/relayConnection";
import { flush, mountWorkbench } from "./mountApp";

const baseUrl = "http://127.0.0.1:8787";
const workspaceId = "11111111-1111-4111-8111-111111111111";
const projectId = "22222222-2222-4222-8222-222222222222";
const taskId = "33333333-3333-4333-8333-333333333333";
const runId = "44444444-4444-4444-8444-444444444444";
const reviewId = "55555555-5555-4555-8555-555555555555";
const artifactVersionId = "99999999-9999-4999-8999-999999999999";
const completionId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const root = `${baseUrl}/api/v1/workspaces/${workspaceId}`;
let unmount: (() => void) | null = null;
afterEach(() => { unmount?.(); unmount = null; resetRelayConnectionForTest(); vi.unstubAllGlobals(); });
function connect() { activateRelayConnection({ baseUrl, workspaceId, bearerToken: "test-bearer-token-0123456789abcdef" }); }
function response(body: unknown, status = 200): Response { return { ok: status >= 200 && status < 300, status, json: async () => body } as Response; }
function activity(id: string, summary: string) { return { id, created_at: "2026-09-26T00:00:00Z", actor_kind: "SYSTEM", actor_ref: "secret-actor-ref",
  command_id: null, event_type: "TASK_COMPLETED", summary, project_id: projectId, task_id: taskId, run_id: runId,
  entity_refs: [
    { kind: "PROJECT", id: projectId }, { kind: "TASK", id: taskId }, { kind: "RUN", id: runId },
    { kind: "REVIEW", id: reviewId }, { kind: "ARTIFACT_VERSION", id: artifactVersionId },
    { kind: "COMPLETION", id: completionId },
    { kind: "GOAL", id: "66666666-6666-4666-8666-666666666666" }
  ] }; }

describe("P15 Activity 只读追溯", () => {
  it("fixture 不查 API；live 按服务端游标续页，安全摘要与确切引用可达", async () => {
    const fixtureFetch = vi.fn(); vi.stubGlobal("fetch", fixtureFetch);
    let mounted = await mountWorkbench("/activity"); unmount = mounted.unmount;
    expect(mounted.wrapper.text()).toContain("没有真实 Activity 记录");
    expect(fixtureFetch).not.toHaveBeenCalled(); unmount(); unmount = null;

    connect(); const calls: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      expect(init?.method ?? "GET").toBe("GET");
      const path = String(input).slice(root.length); calls.push(path);
      if (path === "/activities") return response({ items: [activity("77777777-7777-4777-8777-777777777777", "完成任务")], next_cursor: "page-two" });
      if (path === "/activities?cursor=page-two") return response({ items: [activity("88888888-8888-4888-8888-888888888888", "审计下一页")], next_cursor: null });
      throw new Error(`Unexpected ${path}`);
    }));
    mounted = await mountWorkbench("/activity"); unmount = mounted.unmount;
    expect(mounted.wrapper.text()).toContain("完成任务");
    expect(mounted.wrapper.text()).not.toContain("secret-actor-ref");
    expect(mounted.wrapper.text()).toContain("目标 66666666-6666-4666-8666-666666666666（当前无直达页）");
    expect(mounted.wrapper.find(`a[href="/projects/${projectId}"]`).exists()).toBe(true);
    expect(mounted.wrapper.find(`a[href="/tasks/${taskId}"]`).exists()).toBe(true);
    expect(mounted.wrapper.find(`a[href="/runs/${runId}"]`).exists()).toBe(true);
    expect(mounted.wrapper.find(`a[href="/reviews?id=${reviewId}"]`).exists()).toBe(true);
    expect(mounted.wrapper.find(`a[href="/artifact-versions/${artifactVersionId}/lineage"]`).exists()).toBe(true);
    expect(mounted.wrapper.find(`a[href="/completion-records/${completionId}"]`).exists()).toBe(true);
    await mounted.wrapper.findAll("button").find((button) => button.text() === "继续加载")!.trigger("click"); await flush();
    expect(calls).toContain("/activities?cursor=page-two");
    expect(mounted.wrapper.text()).toContain("当前已读取 2 条；本次查询没有后续游标");
  });

  it("项目/任务/Run/时间筛选发送 UTC 边界，切换范围后旧响应不能覆盖", async () => {
    connect(); const old: { resolve?: (value: Response) => void } = {};
    const calls: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const path = String(input).slice(root.length); calls.push(path);
      if (path === "/activities") return new Promise<Response>((resolve) => { old.resolve = resolve; });
      if (path.startsWith("/activities?")) return response({ items: [activity("77777777-7777-4777-8777-777777777777", "新筛选")], next_cursor: null });
      throw new Error(`Unexpected ${path}`);
    }));
    const mounted = await mountWorkbench("/activity"); unmount = mounted.unmount;
    const inputs = mounted.wrapper.findAll(".activity-filter input");
    await inputs[0]!.setValue(projectId); await inputs[1]!.setValue(taskId); await inputs[2]!.setValue(runId);
    await inputs[3]!.setValue("2026-09-26T08:00"); await inputs[4]!.setValue("2026-09-27T08:00");
    await mounted.wrapper.get(".activity-filter").trigger("submit"); await flush();
    expect(calls.some((path) => path.includes(`project_id=${projectId}`) && path.includes(`task_id=${taskId}`) && path.includes(`run_id=${runId}`)
      && path.includes("from=") && path.includes("to="))).toBe(true);
    expect(mounted.wrapper.text()).toContain("新筛选");
    old.resolve?.(response({ items: [activity("99999999-9999-4999-8999-999999999999", "旧范围")], next_cursor: null })); await flush();
    expect(mounted.wrapper.text()).not.toContain("旧范围");
  });

  it("刷新遇到作用域无权时清除旧记录和深链", async () => {
    connect(); let reads = 0;
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const path = String(input).slice(root.length);
      if (path !== "/activities") throw new Error(`Unexpected ${path}`);
      reads++;
      return reads === 1 ? response({ items: [activity("77777777-7777-4777-8777-777777777777", "旧可见记录")], next_cursor: null })
        : response({ code: "RESOURCE_NOT_FOUND", detail: "not found" }, 404);
    }));
    const mounted = await mountWorkbench("/activity"); unmount = mounted.unmount;
    expect(mounted.wrapper.text()).toContain("旧可见记录");
    const refresh = mounted.wrapper.findAll("button").find((button) => button.text() === "刷新当前范围")!;
    await refresh.trigger("click"); await flush();
    expect(mounted.wrapper.text()).toContain("当前不可见或无权读取");
    expect(mounted.wrapper.text()).not.toContain("旧可见记录");
    expect(mounted.wrapper.find(`a[href="/runs/${runId}"]`).exists()).toBe(false);
  });
});

function makeActivity(id: string, options: { event: string; actor: string; created: string; summary: string }) {
  return { id, created_at: options.created, actor_kind: options.actor, actor_ref: "raw-actor-ref", command_id: null,
    event_type: options.event, summary: options.summary, project_id: projectId, task_id: taskId, run_id: runId, entity_refs: [] };
}
function basisButton(mounted: Awaited<ReturnType<typeof mountWorkbench>>, id: string) {
  return mounted.wrapper.find(`[data-testid="activity-basis-${id}"]`);
}

describe("P15 Activity 分组、执行方筛选与依据侧栏", () => {
  it("按日历日分组，选中事件在侧栏显示依据并分开批准与执行", async () => {
    connect();
    const approval = makeActivity("aaaaaaaa-0000-4000-8000-000000000001", { event: "REVIEW_DECIDED", actor: "HUMAN", created: "2026-09-26T12:00:00Z", summary: "接受研究问题" });
    const execution = makeActivity("aaaaaaaa-0000-4000-8000-000000000002", { event: "ARTIFACT_VERSION_SAVED", actor: "AI", created: "2026-09-26T12:00:00Z", summary: "保存候选产物" });
    const older = makeActivity("aaaaaaaa-0000-4000-8000-000000000003", { event: "TASK_COMPLETED", actor: "SYSTEM", created: "2026-09-20T12:00:00Z", summary: "完成任务" });
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      if (String(input).slice(root.length) !== "/activities") throw new Error("Unexpected");
      return response({ items: [approval, execution, older], next_cursor: null });
    }));
    const mounted = await mountWorkbench("/activity"); unmount = mounted.unmount;
    // 同一天的两条聚合在一个分组，另一天单独成组。
    expect(mounted.wrapper.findAll(".activity-day")).toHaveLength(2);
    expect(mounted.wrapper.text()).not.toContain("raw-actor-ref");
    // 批准事件：侧栏说明批准不等于执行成功。
    await basisButton(mounted, approval.id).trigger("click"); await flush();
    let panel = mounted.wrapper.get('[data-testid="activity-basis-panel"]');
    expect(panel.text()).toContain("作出审批决定");
    expect(panel.text()).toContain("不代表相关动作已经执行成功");
    expect(panel.text()).toContain("本页面不展示 AI 的原始推理过程");
    // 执行事件：与批准分开的独立事实。
    await basisButton(mounted, execution.id).trigger("click"); await flush();
    panel = mounted.wrapper.get('[data-testid="activity-basis-panel"]');
    expect(panel.text()).toContain("保存产物版本");
    expect(panel.text()).toContain("分开的独立事实");
  });

  it("执行方筛选只作用于已加载项并如实标注服务端缺口", async () => {
    connect();
    const human = makeActivity("bbbbbbbb-0000-4000-8000-000000000001", { event: "TASK_STARTED", actor: "HUMAN", created: "2026-09-26T12:00:00Z", summary: "我开始了任务" });
    const ai = makeActivity("bbbbbbbb-0000-4000-8000-000000000002", { event: "RUN_CREATED", actor: "AI", created: "2026-09-26T12:00:00Z", summary: "AI 创建了运行" });
    const system = makeActivity("bbbbbbbb-0000-4000-8000-000000000003", { event: "VERIFICATION_COMPLETED", actor: "SYSTEM", created: "2026-09-26T12:00:00Z", summary: "系统完成验证" });
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      if (String(input).slice(root.length) !== "/activities") throw new Error("Unexpected");
      return response({ items: [human, ai, system], next_cursor: null });
    }));
    const mounted = await mountWorkbench("/activity"); unmount = mounted.unmount;
    expect(mounted.wrapper.text()).toContain("我开始了任务");
    expect(mounted.wrapper.text()).toContain("AI 创建了运行");
    expect(mounted.wrapper.text()).toContain("系统完成验证");
    expect(mounted.wrapper.text()).toContain("服务端暂不支持按执行方分页筛选（待接入）");
    const aiChip = mounted.wrapper.findAll("button").find((button) => button.text() === "AI")!;
    await aiChip.trigger("click"); await flush();
    expect(mounted.wrapper.text()).toContain("AI 创建了运行");
    expect(mounted.wrapper.text()).not.toContain("我开始了任务");
    expect(mounted.wrapper.text()).not.toContain("系统完成验证");
    const allChip = mounted.wrapper.findAll("button").find((button) => button.text() === "全部")!;
    await allChip.trigger("click"); await flush();
    expect(mounted.wrapper.text()).toContain("我开始了任务");
  });
});
