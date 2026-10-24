import { afterEach, describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { RelayApiClient } from "../src/api/relayClient";
import ContinuationPointPanel from "../src/components/ContinuationPointPanel";
import { flush, mountReact } from "./mountApp";

const baseUrl = "http://127.0.0.1:8787";
const workspaceId = "11111111-1111-4111-8111-111111111111";
const projectId = "22222222-2222-4222-8222-222222222222";
const root = `${baseUrl}/api/v1/workspaces/${workspaceId}`;
const collectionPath = `/projects/${projectId}/continuation-points`;
const pointId = "33333333-3333-4333-8333-333333333333";
const taskId = "44444444-4444-4444-8444-444444444444";
const capturedAt = "2026-09-29T00:00:00.000Z";
let unmount: (() => void) | null = null;

afterEach(() => {
  unmount?.(); unmount = null;
  sessionStorage.clear();
  vi.unstubAllGlobals();
});

function response(status: number, body: unknown): Response {
  return { ok: status >= 200 && status < 300, status, json: async () => body } as Response;
}
function summary(refCount: number) {
  return { id: pointId, project_id: projectId, name: "收工前", note: null,
    captured_at: capturedAt,
    captured_state: { phase_key: "DISCOVERY", revision: "0", next_action_task_id: null },
    ref_count: refCount };
}
function client() {
  return new RelayApiClient({ baseUrl, workspaceId, bearerToken: "test-bearer-token-0123456789abcdef" });
}

describe("N01 接续点面板", () => {
  it("没有接续点时不显示变化对比，名称为空也不提交命令", async () => {
    const methods: string[] = [];
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      methods.push(init?.method ?? "GET");
      if (String(input) === `${root}${collectionPath}`) return response(200, { items: [] });
      throw new Error(`Unexpected ${String(input)}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    const mounted = await mountReact(createElement(ContinuationPointPanel,
      { client: client(), projectId }));
    unmount = mounted.unmount;
    await flush();
    expect(mounted.wrapper.text()).toContain("还没有保存过接续点");
    expect(mounted.wrapper.find('[data-testid="continuation-comparison"]').exists()).toBe(false);
    expect(mounted.wrapper.get('.continuation-capture-form').attributes("open")).toBeUndefined();
    expect(mounted.wrapper.get('[data-testid="continuation-capture"]').attributes("disabled"))
      .toBeDefined();
    expect(methods.every((method) => method === "GET")).toBe(true);
  });

  it("保存后按回执确认，并只展示可核对的事实差异", async () => {
    const posts: Record<string, unknown>[] = [];
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input).slice(root.length);
      if (path === collectionPath && (init?.method ?? "GET") === "GET") {
        return response(200, { items: posts.length === 0 ? [] : [summary(1)] });
      }
      if (path === collectionPath && init?.method === "POST") {
        const body = JSON.parse(String(init.body)) as Record<string, unknown>;
        posts.push(body);
        return response(201, { command_id: body.command_id,
          command_type: "CreateProjectContinuationPoint", committed_at: capturedAt,
          result: summary(1) });
      }
      if (path === `${collectionPath}/${pointId}/comparison`) {
        return response(200, { continuation_point: summary(1),
          current_state: { phase_key: "IMPLEMENTATION", revision: "1", next_action_task_id: null },
          facts: { state_revision_changed: true, phase_changed: true, next_action_changed: false,
            task_added: [{ task_id: taskId, title: "新增未决", status: "READY" }],
            artifact_version_added: [] },
          ref_changes: [{ ref_kind: "TASK", ref_id: taskId, captured_revision: "0",
            change: "REVISED", current_revision: "1", note: "当前状态 READY" }],
          interpretation: null });
      }
      throw new Error(`Unexpected ${path}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    const mounted = await mountReact(createElement(ContinuationPointPanel,
      { client: client(), projectId }));
    unmount = mounted.unmount;
    await flush();
    await mounted.wrapper.get('[data-testid="continuation-name"]').setValue("收工前");
    await mounted.wrapper.get('[data-testid="continuation-capture"]').trigger("click");
    await flush();
    expect(posts).toHaveLength(1);
    expect(posts[0]).toEqual({ command_id: expect.any(String), name: "收工前", note: null });
    expect(mounted.wrapper.text()).toContain("接续点「收工前」已保存，包含 1 项引用");

    await mounted.wrapper.get('[data-testid="continuation-open"]').trigger("click");
    await flush();
    const comparison = mounted.wrapper.get('[data-testid="continuation-comparison"]').text();
    expect(comparison).toContain("本版不生成解读");
    expect(comparison).toContain("Project State 版本：已变化");
    expect(comparison).toContain("已从 DISCOVERY 变为 IMPLEMENTATION");
    expect(comparison).toContain("已修订");
    expect(comparison).toContain("新增未决");
    expect(sessionStorage.length).toBe(0);
  });

  it("响应丢失后按原 command_id 查回执，未确认前不重复提交", async () => {
    const posts: Record<string, unknown>[] = [];
    const receipts: string[] = [];
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input).slice(root.length);
      if (path === collectionPath && (init?.method ?? "GET") === "GET") return response(200, { items: [] });
      if (path.startsWith("/commands/")) {
        receipts.push(path.slice("/commands/".length));
        return response(404, { code: "COMMAND_NOT_FOUND", detail: "not found" });
      }
      if (path === collectionPath && init?.method === "POST") {
        const body = JSON.parse(String(init.body)) as Record<string, unknown>;
        posts.push(body);
        throw new TypeError("connection closed");
      }
      throw new Error(`Unexpected ${path}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    const mounted = await mountReact(createElement(ContinuationPointPanel,
      { client: client(), projectId }));
    unmount = mounted.unmount;
    await flush();
    await mounted.wrapper.get('[data-testid="continuation-name"]').setValue("收工前");
    await mounted.wrapper.get('[data-testid="continuation-capture"]').trigger("click");
    await flush();
    expect(posts).toHaveLength(1);
    expect(receipts).toEqual([posts[0].command_id]);
    const pending = mounted.wrapper.get('[data-testid="continuation-pending"]').text();
    expect(pending).toContain(`原 command_id：${posts[0].command_id}`);
    expect(pending).toContain("核对完成前不会生成新命令");
    expect(mounted.wrapper.get('.continuation-capture-form').attributes("open")).toBeDefined();
    expect(mounted.wrapper.get('[data-testid="continuation-capture"]').attributes("disabled"))
      .toBeDefined();
    await mounted.wrapper.findAll("button").find((button) => button.text() === "查询原命令回执")!
      .trigger("click");
    await flush();
    expect(posts).toHaveLength(1);
    expect(receipts).toEqual([posts[0].command_id, posts[0].command_id]);
  });

  // 禅道 #23（DEV-0137）：列表读取失败后父页重读成功，旧读取错误必须撤下——空列表
  // 显示真实空态、有记录显示记录；capture/回执错误在另一路（error），不受影响。
  it.each([false, true])("列表读取失败，父页重读成功%s后撤下旧读取错误", async (populated) => {
    let reads = 0;
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const path = String(input).slice(root.length);
      if (path === collectionPath) {
        reads++;
        if (reads === 1) return response(503, { code: "DATABASE_UNAVAILABLE", detail: "temporary failure" });
        return response(200, { items: populated ? [summary(0)] : [] });
      }
      throw new Error(`Unexpected ${path}`);
    }));
    const relay = client();
    const mounted = await mountReact(createElement(ContinuationPointPanel,
      { client: relay, projectId }));
    unmount = mounted.unmount;
    await flush();
    expect(mounted.wrapper.text()).toContain("接续点没有读到");
    expect(mounted.wrapper.find('[role="alert"]').exists()).toBe(true);
    // 模拟 ProjectResumeView 的重读生命周期：事实不可读 → 重新可读并成功。
    await mounted.rerender(createElement(ContinuationPointPanel,
      { client: relay, projectId, factsReadable: false, captureBlockedReason: "正在重读项目事实" }));
    await mounted.rerender(createElement(ContinuationPointPanel,
      { client: relay, projectId, factsReadable: true }));
    await flush();
    expect(reads).toBe(2);
    if (populated) expect(mounted.wrapper.text()).toContain("收工前");
    else expect(mounted.wrapper.text()).toContain("还没有保存过接续点");
    expect(mounted.wrapper.text()).not.toContain("接续点没有读到");
    expect(mounted.wrapper.find('[role="alert"]').exists()).toBe(false);
  });

  it("列表读取失败与未决保存命令并存，重读成功后未决、门槛与回执错误保留", async () => {
    let posts = 0;
    let reads = 0;
    let submittedId = "";
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input).slice(root.length);
      if (path === collectionPath && (init?.method ?? "GET") === "GET") {
        reads++;
        if (reads === 1) return response(503, { code: "DATABASE_UNAVAILABLE", detail: "temporary failure" });
        return response(200, { items: [summary(1)] });
      }
      if (path === collectionPath && init?.method === "POST") {
        posts++;
        submittedId = String((JSON.parse(String(init.body)) as Record<string, unknown>).command_id);
        throw new TypeError("connection closed");
      }
      if (path.startsWith("/commands/")) {
        return response(404, { code: "COMMAND_NOT_FOUND", detail: "not found" });
      }
      throw new Error(`Unexpected ${path}`);
    }));
    const relay = client();
    const mounted = await mountReact(createElement(ContinuationPointPanel,
      { client: relay, projectId }));
    unmount = mounted.unmount;
    await flush();
    expect(mounted.wrapper.text()).toContain("接续点没有读到");
    await mounted.wrapper.get('[data-testid="continuation-name"]').setValue("收工前");
    await mounted.wrapper.get('[data-testid="continuation-capture"]').trigger("click");
    await flush();
    expect(posts).toBe(1);
    // 列表读取失败与未决命令可以并存：待核对面板与写入门槛不受读取错误影响。
    expect(mounted.wrapper.get('[data-testid="continuation-pending"]').text()).toContain(submittedId);
    expect(mounted.wrapper.get('[data-testid="continuation-capture"]').attributes("disabled"))
      .toBeDefined();
    // 父页重读成功：旧读取错误撤下、列表显示；未决命令、写入门槛与回执未知错误原样保留。
    await mounted.rerender(createElement(ContinuationPointPanel, { client: relay, projectId, factsReadable: false }));
    await mounted.rerender(createElement(ContinuationPointPanel, { client: relay, projectId, factsReadable: true }));
    await flush();
    expect(reads).toBe(2);
    expect(mounted.wrapper.text()).toContain("收工前");
    expect(mounted.wrapper.text()).not.toContain("接续点没有读到");
    expect(mounted.wrapper.get('[data-testid="continuation-pending"]').text()).toContain(submittedId);
    expect(mounted.wrapper.get('[data-testid="continuation-capture"]').attributes("disabled"))
      .toBeDefined();
    expect(mounted.wrapper.text()).toContain("原命令回执暂未找到");
  });

  it("列表读取的迟到失败响应不覆盖重读成功的结果", async () => {
    // 装进对象再赋值：TS 会把「回调里才赋值」的局部量按初始值 null 收窄，调用点就成了 never。
    const pending = { resolve: null as ((value: Response) => void) | null };
    let reads = 0;
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const path = String(input).slice(root.length);
      if (path !== collectionPath) throw new Error(`Unexpected ${path}`);
      reads++;
      if (reads === 1) return new Promise<Response>((resolve) => { pending.resolve = resolve; });
      return response(200, { items: [summary(1)] });
    }));
    const relay = client();
    const mounted = await mountReact(createElement(ContinuationPointPanel,
      { client: relay, projectId }));
    unmount = mounted.unmount;
    await flush();
    expect(reads).toBe(1);
    await mounted.rerender(createElement(ContinuationPointPanel, { client: relay, projectId, factsReadable: false }));
    await mounted.rerender(createElement(ContinuationPointPanel, { client: relay, projectId, factsReadable: true }));
    await flush();
    expect(reads).toBe(2);
    expect(mounted.wrapper.text()).toContain("收工前");
    // 第一轮读取迟到落地：按事实读取序号丢弃，不把旧失败挂回成功后的列表。
    pending.resolve?.(response(503, { code: "DATABASE_UNAVAILABLE", detail: "late failure" }));
    await flush();
    expect(mounted.wrapper.text()).toContain("收工前");
    expect(mounted.wrapper.find('[role="alert"]').exists()).toBe(false);
  });
});
