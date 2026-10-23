import { afterEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { activateRelayConnection, resetRelayConnectionForTest } from "../src/lib/relayConnection";
import { flush, mountWorkbench } from "./mountApp";

/**
 * 设置 › 基本设置 › 默认工作目录（工作台 §18.1.5 / HTTP §10.96 / 运行架构 §2.8）。
 *
 * 这里锁的是**用户可走通的配置路径与它的失败边界**：只读打开零写入、取消选择不发命令、
 * Open 未就绪不写入、只读 READY 也能设为默认、设置/清除严格用最近修订、409 刷新而不覆盖、
 * 结果未知按原 command_id 核对、换 Workspace 后旧投影与迟到响应不落进新范围。
 * 真实 PG/HTTP 的 CAS 与并发收敛在 API 集成用例里，不能由这里代替。
 *
 * 单独成文件而不是并入 settingsView.spec.ts：本文件在文件级 mock `desktopHost` 的原生目录
 * 选择器（`vi.mock` 是提升到整个文件生效的），放进共用文件会连带改变既有 15 条设置用例的
 * 宿主能力，让那些与目录无关的断言多一个前提。
 */

const host = vi.hoisted(() => ({ available: false, picked: null as string | null, calls: 0 }));
vi.mock("../src/lib/desktopHost", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/lib/desktopHost")>();
  return { ...actual,
    nativeFolderPickerAvailable: () => host.available,
    selectWorkingDirectory: async () => { host.calls += 1; return host.picked; } };
});

const baseUrl = "http://127.0.0.1:8787";
const workspaceId = "11111111-1111-4111-8111-111111111111";
const otherWorkspaceId = "22222222-2222-4222-8222-222222222222";
const projectId = "33333333-3333-4333-8333-333333333333";
const root = "D:\\Develop\\Demo";
const prefix = `/api/v1/workspaces/${workspaceId}`;

function response(body: unknown, status = 200): Response {
  return { ok: status < 400, status, json: async () => body } as Response;
}

type Projection = { resource_id: string | null; canonical_root: string | null; display_name: string | null;
  write_tier: string | null; default_write_tier: string | null;
  status: "UNSET" | "READY" | "UNAVAILABLE"; reason: string | null; revision: string };

function unset(revision = "0"): Projection {
  return { resource_id: null, canonical_root: null, display_name: null, write_tier: null,
    default_write_tier: null, status: "UNSET", reason: null, revision };
}

function ready(revision = "1"): Projection {
  return { resource_id: "res-1", canonical_root: root, display_name: "Demo", write_tier: "READ_ONLY",
    default_write_tier: null, status: "READY", reason: null, revision };
}

function openResult(over: Record<string, unknown> = {}) {
  return { canonical_root: root, display_name: "Demo", status: "READY", reason: null,
    association: { project_id: projectId, project_title: "Demo", project_archived: false,
      resource_id: "res-1", resource_status: "ACTIVE", file_write_identity_bound: true },
    created_project: false, created_resource: false, candidates: [],
    write_readiness: { status: "READY", detail: "本目录当前为只读档位。" }, ...over };
}

interface Routes {
  /** 当前服务端投影；写命令按它收敛修订。 */
  projection?: () => Projection;
  open?: (body: Record<string, unknown>) => Response;
  /** 设置命令的受控故障：lose 只丢前 n 次响应；conflict 模拟并发改过修订。 */
  loseSetResponse?: boolean;
  conflictOnSet?: boolean;
  /** GET /default-working-directory 的受控延迟（用于换 Workspace 的迟到响应反例）。 */
  gateGet?: (workspace: string) => Promise<void> | null;
  receipt?: (commandId: string) => Response;
}

function router(routes: Routes, calls: { method: string; path: string; body: Record<string, unknown> }[]) {
  let lost = false;
  return vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const path = new URL(url).pathname;
    const workspace = /\/workspaces\/([^/]+)/u.exec(path)?.[1] ?? "";
    const body = init?.method === "POST" ? JSON.parse(String(init.body ?? "{}")) as Record<string, unknown> : null;
    if (init?.method === "POST" && body !== null) calls.push({ method: "POST", path, body });
    else calls.push({ method: init?.method ?? "GET", path, body: {} });

    if (path === `${prefix}/model-port`) return response({ provider: "fake", configured: false,
      model: null, base_url: null, max_call_tokens: null });
    if (path === `${prefix}/model-port/verification`) return response({ current_config_fingerprint: null,
      last: null, matches_current_config: false, worker_startup_validation: "NOT_CONFIGURED" });
    if (path.endsWith("/attention/interventions")) return response({ items: [] });

    if (path.endsWith("/default-working-directory")) {
      const projection = routes.projection?.() ?? unset();
      if (init?.method !== "POST") {
        const gate = routes.gateGet?.(workspace) ?? null;
        if (gate !== null) await gate;
        return response(projection);
      }
      if (routes.conflictOnSet) {
        // 并发改过修订：服务端现在看到的是更高修订，客户端还按旧修订提交。
        return response({ code: "REVISION_CONFLICT", detail: "revision conflict",
          conflict: { expected_revision: String(body?.expected_revision), actual_revision: "9" } }, 409);
      }
      if (routes.loseSetResponse && !lost) { lost = true; throw new TypeError("set response lost"); }
      return response({ command_id: body?.command_id, committed_at: "2026-10-19T00:00:00Z",
        result: { workspace_id: workspace, resource_id: body?.resource_id, revision: "2" } });
    }
    if (path.endsWith("/default-working-directory/clear")) {
      if (routes.loseSetResponse && !lost) { lost = true; throw new TypeError("clear response lost"); }
      return response({ command_id: body?.command_id, committed_at: "2026-10-19T00:00:00Z",
        result: { workspace_id: workspace, resource_id: null, revision: "3" } });
    }
    if (path.endsWith("/working-directories/open")) return routes.open?.(body ?? {}) ?? response({ command_id: body?.command_id,
      committed_at: "2026-10-19T00:00:00Z", result: openResult() });
    const receipt = /\/commands\/([^/]+)$/u.exec(path);
    if (receipt) return routes.receipt?.(receipt[1]!) ?? response({ code: "NOT_FOUND", detail: "命令回执不存在" }, 404);
    throw new Error(`Unexpected ${init?.method ?? "GET"} ${path}`);
  });
}

let unmount: (() => void) | null = null;
afterEach(() => { unmount?.(); unmount = null; resetRelayConnectionForTest();
  vi.unstubAllGlobals(); host.available = false; host.picked = null; host.calls = 0; });

function connect(workspace = workspaceId) {
  activateRelayConnection({ baseUrl, workspaceId: workspace, bearerToken: "synthetic-token" });
}

function valueText(view: Awaited<ReturnType<typeof mountWorkbench>>): string {
  return view.wrapper.get('[data-testid="settings-default-directory-value"]').text();
}

const choose = (view: Awaited<ReturnType<typeof mountWorkbench>>) =>
  view.wrapper.get('[data-testid="settings-default-directory-choose"]');

const manual = async (view: Awaited<ReturnType<typeof mountWorkbench>>, path = root) => {
  await view.wrapper.get('[data-testid="settings-default-directory-manual"]').setValue(path);
  await view.wrapper.get('[data-testid="settings-default-directory-manual-submit"]').trigger("click");
  await flush(60);
};

describe("设置页默认工作目录", () => {
  it("挂载与切分组只读：显示未设置，不发任何写命令", async () => {
    connect();
    const calls: { method: string; path: string; body: Record<string, unknown> }[] = [];
    vi.stubGlobal("fetch", router({}, calls));
    const view = await mountWorkbench("/settings"); unmount = view.unmount;
    await flush();
    expect(valueText(view)).toContain("未设置");
    // 未设置时没有「清除」这颗键，也不提供自动批准/完全访问选项。
    expect(view.wrapper.find('[data-testid="settings-default-directory-clear"]').exists()).toBe(false);
    expect(view.wrapper.text()).toContain("不提供自动批准或完全访问");
    await view.wrapper.get('[data-testid="settings-group-model"]').trigger("click");
    await view.wrapper.get('[data-testid="settings-group-basic"]').trigger("click");
    await flush();
    expect(calls.filter((call) => call.method === "POST")).toHaveLength(0);
    expect(calls.filter((call) => call.path === `${prefix}/default-working-directory`
      && call.method === "GET").length).toBeGreaterThanOrEqual(1);
  });

  it("取消选择不发任何命令，原设置保持不变", async () => {
    connect();
    const calls: { method: string; path: string; body: Record<string, unknown> }[] = [];
    vi.stubGlobal("fetch", router({ projection: () => ready("3") }, calls));
    host.available = true; host.picked = null;
    const view = await mountWorkbench("/settings"); unmount = view.unmount;
    await flush();
    expect(valueText(view)).toContain("Demo");
    await choose(view).trigger("click");
    await flush();
    expect(host.calls).toBe(1);
    expect(calls.filter((call) => call.method === "POST")).toHaveLength(0);
    expect(valueText(view)).toContain("Demo");
  });

  it("Open 未就绪不写入默认值，原样说明服务端原因并保留原设置", async () => {
    connect();
    const calls: { method: string; path: string; body: Record<string, unknown> }[] = [];
    vi.stubGlobal("fetch", router({ open: (body) => response({ command_id: body.command_id,
      committed_at: "2026-10-19T00:00:00Z",
      result: openResult({ status: "AMBIGUOUS", reason: "MULTIPLE_PROJECTS", association: null,
        candidates: [{ project_id: projectId, project_title: "Demo", project_archived: false,
          resource_id: "res-1", resource_status: "ACTIVE", file_write_identity_bound: true }] }) }) }, calls));    const view = await mountWorkbench("/settings"); unmount = view.unmount;
    await flush();
    await manual(view);
    expect(calls.filter((call) => call.path.endsWith("/working-directories/open"))).toHaveLength(1);
    expect(calls.filter((call) => call.method === "POST" && call.path.endsWith("/default-working-directory")))
      .toHaveLength(0);
    const problem = view.wrapper.get('[data-testid="settings-default-directory-problem"]').text();
    expect(problem).toContain("多个项目");
    expect(problem).toContain("原设置保持不变");
    expect(valueText(view)).toContain("未设置");
  });

  it("只读 READY 也可设为默认；设置后用最近修订清除，修订单调不回 0", async () => {
    connect();
    let projection = unset();
    const writes: Record<string, unknown>[] = [];
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = new URL(String(input)).pathname;
      const body = init?.method === "POST" ? JSON.parse(String(init.body ?? "{}")) as Record<string, unknown> : null;
      if (path === `${prefix}/model-port`) return response({ provider: "fake", configured: false,
        model: null, base_url: null, max_call_tokens: null });
      if (path === `${prefix}/model-port/verification`) return response({ current_config_fingerprint: null,
        last: null, matches_current_config: false, worker_startup_validation: "NOT_CONFIGURED" });
      if (path.endsWith("/attention/interventions")) return response({ items: [] });
      if (path.endsWith("/working-directories/open")) return response({ command_id: body?.command_id,
        committed_at: "2026-10-19T00:00:00Z", result: openResult() });
      if (path.endsWith("/default-working-directory/clear") && body !== null) {
        writes.push(body);
        projection = unset("2");
        return response({ command_id: body.command_id, committed_at: "2026-10-19T00:00:00Z",
          result: { workspace_id: workspaceId, resource_id: null, revision: "2" } });
      }
      if (path.endsWith("/default-working-directory") && body !== null) {
        writes.push(body);
        projection = ready("1");
        return response({ command_id: body.command_id, committed_at: "2026-10-19T00:00:00Z",
          result: { workspace_id: workspaceId, resource_id: "res-1", revision: "1" } });
      }
      if (path.endsWith("/default-working-directory")) return response(projection);
      throw new Error(`Unexpected ${init?.method ?? "GET"} ${path}`);
    }));
    const view = await mountWorkbench("/settings"); unmount = view.unmount;
    await flush();
    await manual(view);
    expect(writes).toEqual([{ command_id: expect.stringMatching(/^[0-9a-f-]{36}$/u),
      expected_revision: "0", resource_id: "res-1" }]);
    // 只读目录同样可以成为默认：设置成功与否不看写档位。
    expect(valueText(view)).toContain("有效");
    expect(valueText(view)).toContain("Demo");
    expect(view.wrapper.get('[data-testid="settings-default-directory-path"]').text()).toBe(root);
    expect(view.wrapper.get('[data-testid="settings-default-directory-tier"]').text()).toContain("只读");
    expect(view.wrapper.get('[data-testid="settings-default-directory-notice"]').text()).toContain("修订 1");

    await view.wrapper.get('[data-testid="settings-default-directory-clear"]').trigger("click");
    await flush(60);
    expect(writes[1]).toEqual({ command_id: expect.stringMatching(/^[0-9a-f-]{36}$/u),
      expected_revision: "1" });
    expect(view.wrapper.get('[data-testid="settings-default-directory-value"]').text()).toContain("未设置");
    expect(view.wrapper.get('[data-testid="settings-default-directory-notice"]').text()).toContain("修订 2");
  });

  it("409 刷新当前事实并提示冲突，不自动覆盖新设置", async () => {
    connect();
    const calls: { method: string; path: string; body: Record<string, unknown> }[] = [];
    vi.stubGlobal("fetch", router({ projection: () => ready("3"), conflictOnSet: true }, calls));
    const view = await mountWorkbench("/settings"); unmount = view.unmount;
    await flush();
    await manual(view);
    // 只发一次设置命令：冲突后不自动换修订重发。
    expect(calls.filter((call) => call.method === "POST" && call.path.endsWith("/default-working-directory")))
      .toHaveLength(1);
    const problem = view.wrapper.get('[data-testid="settings-default-directory-problem"]').text();
    expect(problem).toContain("409");
    expect(problem).toContain("没有覆盖新设置");
    // 刷新后仍显示服务端当前事实，而不是客户端想设置的值。
    expect(valueText(view)).toContain("Demo");
    expect(view.wrapper.text()).not.toContain("已把");
  });

  it("结果未知时保留原命令，按原 command_id 核对成功后才重读并报成功", async () => {
    connect();
    const calls: { method: string; path: string; body: Record<string, unknown> }[] = [];
    let projection = unset();
    let commandId = "";
    const base = router({
      projection: () => projection,
      loseSetResponse: true,
      receipt: (id) => response({ command_id: id, command_type: "SetWorkspaceDefaultDirectory",
        committed_at: "2026-10-19T00:00:00Z",
        result: { workspace_id: workspaceId, resource_id: "res-1", revision: "1" } })
    }, calls);
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = new URL(String(input)).pathname;
      if (init?.method === "POST" && path.endsWith("/default-working-directory")) {
        commandId = String((JSON.parse(String(init.body)) as { command_id: string }).command_id);
        projection = ready("1");
      }
      return base(input, init);
    }));
    const view = await mountWorkbench("/settings"); unmount = view.unmount;
    await flush();
    await manual(view);
    expect(commandId).toMatch(/^[0-9a-f-]{36}$/u);
    const pending = view.wrapper.get('[data-testid="settings-default-directory-pending"]');
    expect(pending.text()).toContain(commandId);
    expect(view.wrapper.get('[data-testid="settings-default-directory-problem"]').text()).toContain("结果未知");
    // 未核对前不显示成功，也不宣称已设置。
    expect(view.wrapper.text()).not.toContain("已把");
    await view.wrapper.get('[data-testid="settings-default-directory-receipt"]').trigger("click");
    await flush(60);
    expect(calls.some((call) => call.method === "POST" && call.path.endsWith("/default-working-directory")
      && call.body.command_id === commandId)).toBe(true);
    expect(view.wrapper.find('[data-testid="settings-default-directory-pending"]').exists()).toBe(false);
    expect(view.wrapper.get('[data-testid="settings-default-directory-notice"]').text()).toContain("原命令已确认");
    expect(valueText(view)).toContain("有效");
  });

  it("换 Workspace 后清空旧投影，迟到的旧响应不落进新范围", async () => {
    connect(workspaceId);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let reads = 0;
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = new URL(String(input)).pathname;
      const workspace = /\/workspaces\/([^/]+)/u.exec(path)?.[1] ?? "";
      if (path === `${prefix}/model-port`) return response({ provider: "fake", configured: false,
        model: null, base_url: null, max_call_tokens: null });
      if (path === `${prefix}/model-port/verification`) return response({ current_config_fingerprint: null,
        last: null, matches_current_config: false, worker_startup_validation: "NOT_CONFIGURED" });
      if (path.endsWith("/attention/interventions")) return response({ items: [] });
      if (path.endsWith("/default-working-directory") && init?.method !== "POST") {
        reads += 1;
        if (workspace === workspaceId) { await gate; return response(ready("4")); }
        return response(unset());
      }
      throw new Error(`Unexpected ${init?.method ?? "GET"} ${path}`);
    }));
    const view = await mountWorkbench("/settings"); unmount = view.unmount;
    await flush(10);
    expect(reads).toBe(1);
    await act(async () => { connect(otherWorkspaceId); });
    await flush(60);
    // 新范围读到的是未设置，旧范围挂起的响应随后到达也不能填进来。
    expect(valueText(view)).toContain("未设置");
    release();
    await flush(60);
    expect(valueText(view)).toContain("未设置");
    expect(view.wrapper.text()).not.toContain("Demo");
  });
});
