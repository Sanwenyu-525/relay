import { afterEach, describe, expect, it, vi } from "vitest";
import { activateRelayConnection, resetRelayConnectionForTest } from "../src/lib/relayConnection";
import { flush, mountWorkbench } from "./mountApp";

const baseUrl = "http://127.0.0.1:8787";
const workspaceId = "11111111-1111-4111-8111-111111111111";
const projectId = "22222222-2222-4222-8222-222222222222";
const connectionId = "33333333-3333-4333-8333-333333333333";
const resourceId = "44444444-4444-4444-8444-444444444444";
const policyId = "55555555-5555-4555-8555-555555555555";
const root = `${baseUrl}/api/v1/workspaces/${workspaceId}`;
const created = "2026-09-26T00:00:00.000Z";
let unmount: (() => void) | null = null;

afterEach(() => {
  unmount?.(); unmount = null;
  resetRelayConnectionForTest();
  vi.unstubAllGlobals();
});

function response(status: number, body: unknown): Response {
  return { ok: status >= 200 && status < 300, status, json: async () => body } as Response;
}
function receipt(commandId: string, result: Record<string, unknown>) {
  return { command_id: commandId, committed_at: created, result };
}
function connect() {
  activateRelayConnection({ baseUrl, workspaceId, bearerToken: "test-bearer-token-0123456789abcdef" });
}
function baseGet(path: string, state: {
  connections: Record<string, unknown>[]; policies: Record<string, unknown>[];
  resources: Record<string, unknown>[]; versions: Record<string, unknown>[];
  archivedAt: string | null;
}): Response | null {
  if (path === `/projects/${projectId}`) return response(200, { id: projectId, title: "真实项目", project_type: "GENERAL", revision: "1", state_revision: "1", archived_at: state.archivedAt });
  if (path === `/projects/${projectId}/view-configuration`) return response(200, { project_id: projectId,
    revision: "1", kind: "general", template_version: "1", template_sha256: "a".repeat(64),
    pages: ["state", "tasks", "artifacts", "reviews"].map((page_id, position) =>
      ({ page_id, visible: true, position })), updated_at: created });
  if (path === `/projects/${projectId}/connections`) return response(200, state.connections);
  if (path === `/projects/${projectId}/permission-policies`) return response(200, state.policies);
  if (path === `/projects/${projectId}/managed-resources`) return response(200, state.resources);
  if (path === `/projects/${projectId}/permission-policies/${policyId}/versions`) return response(200, state.versions);
  return null;
}
function state() { return { connections: [] as Record<string, unknown>[], policies: [] as Record<string, unknown>[],
  resources: [] as Record<string, unknown>[], versions: [] as Record<string, unknown>[],
  archivedAt: null as string | null }; }

describe("项目连接与 Permission 设置", () => {
  it("归档项目深链只读连接和 View，禁止新的配置命令", async () => {
    connect(); const data = state(); data.archivedAt = created;
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input).slice(root.length);
      if ((init?.method ?? "GET") === "GET") return baseGet(path, data) ?? response(404, {});
      throw new Error(`Unexpected write ${path}`);
    }); vi.stubGlobal("fetch", fetchMock);
    const mounted = await mountWorkbench(`/projects/${projectId}/connections`); unmount = mounted.unmount;
    expect(mounted.wrapper.get('[data-testid="connections-archive-reason"]').text()).toContain("已归档");
    expect(mounted.wrapper.get('[data-testid="view-archive-reason"]').text()).toContain("已归档");
    expect(mounted.wrapper.findAll("button").find((button) => button.text() === "创建连接")!.attributes("disabled")).toBeDefined();
    expect(mounted.wrapper.get('[data-testid="policy-save"]').attributes("disabled")).toBeDefined();
    await mounted.wrapper.get(".connections-form").trigger("submit");
    expect(fetchMock.mock.calls.filter(([, init]) => init?.method === "POST")).toHaveLength(0);
  });
  it("示例入口可达但不查询、不写入真实配置", async () => {
    const fetchMock = vi.fn(); vi.stubGlobal("fetch", fetchMock);
    const mounted = await mountWorkbench("/connections"); unmount = mounted.unmount;
    expect(mounted.wrapper.text()).toContain("示例数据");
    await mounted.wrapper.get('[data-testid="connections-project-id"]').setValue(projectId);
    await mounted.wrapper.get(".connections-entry").trigger("submit"); await flush();
    expect(mounted.router.currentRoute.value.path).toBe(`/projects/${projectId}/connections`);
    expect(mounted.wrapper.text()).toContain("没有真实连接或权限配置");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("WEB_FETCH 连接创建后仍为默认 DENY，显式提交同主机 AUTO 策略才出现版本", async () => {
    connect(); const data = state();
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input).slice(root.length);
      if ((init?.method ?? "GET") === "GET") return baseGet(path, data) ?? response(404, {});
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      if (path === `/projects/${projectId}/connections`) {
        expect(body).toMatchObject({ capabilities: ["WEB_FETCH"], allowed_host: "example.org" });
        expect(body).not.toHaveProperty("allow_private");
        data.connections = [{ id: connectionId, project_id: projectId, status: "ACTIVE", version: "1", capabilities: ["WEB_FETCH"], allowed_host: "example.org", created_at: created }];
        return response(201, receipt(String(body.command_id), { project_id: projectId, connection_id: connectionId, version: "1", status: "ACTIVE" }));
      }
      if (path === `/projects/${projectId}/permission-policies`) {
        expect(body).toMatchObject({ capability: "WEB_FETCH", resource_id: null, host: "example.org", decision: "AUTO", max_payload_bytes: 2 });
        data.policies = [{ id: policyId, project_id: projectId, status: "ACTIVE", active_version: "1", revision: "1", created_at: created }];
        data.versions = [{ version: "1", capability: "WEB_FETCH", action_type: "WEB_FETCH", target_prefix: "example.org", decision: "AUTO", max_payload_bytes: 2, created_at: created }];
        return response(201, receipt(String(body.command_id), { project_id: projectId, policy_id: policyId, revision: "1", version: "1", status: "ACTIVE" }));
      }
      throw new Error(`Unexpected POST ${path}`);
    }); vi.stubGlobal("fetch", fetchMock);
    const mounted = await mountWorkbench(`/projects/${projectId}/connections`); unmount = mounted.unmount;
    expect(mounted.wrapper.text()).toContain("当前默认：通用 · 配置修订 v1");
    expect(mounted.wrapper.text()).toContain("本项目没有权限策略，当前默认 DENY");
    await mounted.wrapper.get('[data-testid="connection-host"]').setValue("example.org");
    await mounted.wrapper.get(".connections-form").trigger("submit"); await flush();
    expect(mounted.wrapper.text()).toContain("连接创建已由服务端回执和最新项目查询确认");
    expect(mounted.wrapper.text()).toContain("本项目没有权限策略，当前默认 DENY");
    expect(fetchMock.mock.calls.filter(([, init]) => init?.method === "POST")).toHaveLength(1);
    await mounted.wrapper.get('[data-testid="policy-host"]').setValue("example.org");
    await mounted.wrapper.get('[data-testid="policy-decision"]').setValue("AUTO");
    await mounted.wrapper.get('[data-testid="policy-form"]').trigger("submit"); await flush();
    expect(mounted.wrapper.text()).toContain("WEB_FETCH · AUTO");
    expect(mounted.wrapper.text()).toContain("example.org");
    expect(mounted.wrapper.findAll(`a[href="/projects/${projectId}"]`).some((link) => link.text() === "返回原项目页")).toBe(true);
  });

  it("FILE_READ 创建只提交目录边界，停用后连接历史仍可见且没有自动 Permission", async () => {
    connect(); const data = state(); const rootPath = "D:\\Workspace\\source";
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input).slice(root.length);
      if ((init?.method ?? "GET") === "GET") return baseGet(path, data) ?? response(404, {});
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      if (path === `/projects/${projectId}/connections`) {
        expect(body).toMatchObject({ capabilities: ["FILE_READ"], root_path: rootPath });
        expect(body).not.toHaveProperty("allowed_host");
        data.connections = [{ id: connectionId, project_id: projectId, status: "ACTIVE", version: "1", capabilities: ["FILE_READ"], allowed_host: null, created_at: created }];
        return response(201, receipt(String(body.command_id), { project_id: projectId, connection_id: connectionId, version: "1", status: "ACTIVE" }));
      }
      if (path === `/projects/${projectId}/connections/${connectionId}/disable`) {
        expect(body).toMatchObject({ expected_version: "1" });
        data.connections = [{ ...data.connections[0], status: "DISABLED", version: "2" }];
        return response(200, receipt(String(body.command_id), { project_id: projectId, connection_id: connectionId, version: "2", status: "DISABLED" }));
      }
      throw new Error(`Unexpected POST ${path}`);
    }); vi.stubGlobal("fetch", fetchMock);
    const mounted = await mountWorkbench(`/projects/${projectId}/connections`); unmount = mounted.unmount;
    await mounted.wrapper.get('[data-testid="connection-capability"]').setValue("FILE_READ");
    await mounted.wrapper.get('[data-testid="connection-root"]').setValue(rootPath);
    await mounted.wrapper.get(".connections-form").trigger("submit"); await flush();
    expect(mounted.wrapper.text()).toContain("本项目没有权限策略，当前默认 DENY");
    expect(mounted.wrapper.text()).toContain("连接目录未由此接口公开");
    expect(mounted.wrapper.get('[data-testid="connection-root"]').element).toHaveProperty("value", "");
    await mounted.wrapper.findAll("button").find((button) => button.text() === "停用连接")!.trigger("click"); await flush();
    expect(mounted.wrapper.text()).toContain(`${connectionId}`);
    expect(mounted.wrapper.text()).toContain("DISABLED · v2");
    expect(mounted.wrapper.text()).toContain("本项目没有权限策略，当前默认 DENY");
    expect(fetchMock.mock.calls.filter(([, init]) => init?.method === "POST")).toHaveLength(2);
  });

  it("Connection 列表受 100 条上限截断时，创建结果仍按同项目详情核对", async () => {
    connect(); const data = state();
    const detail = { id: connectionId, project_id: projectId, status: "ACTIVE", version: "1", capabilities: ["WEB_FETCH"], allowed_host: "example.org", created_at: created };
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input).slice(root.length);
      if ((init?.method ?? "GET") === "GET") {
        if (path === `/projects/${projectId}/connections/${connectionId}`) return response(200, detail);
        return baseGet(path, data) ?? response(404, {});
      }
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return response(201, receipt(String(body.command_id), { project_id: projectId, connection_id: connectionId, version: "1", status: "ACTIVE" }));
    }); vi.stubGlobal("fetch", fetchMock);
    const mounted = await mountWorkbench(`/projects/${projectId}/connections`); unmount = mounted.unmount;
    await mounted.wrapper.get('[data-testid="connection-host"]').setValue("example.org");
    await mounted.wrapper.get(".connections-form").trigger("submit"); await flush();
    expect(mounted.wrapper.text()).toContain("连接创建已由服务端回执和最新项目查询确认");
    expect(mounted.wrapper.text()).toContain("本列表最多读取服务端前 100 条且无游标");
    expect(fetchMock.mock.calls.some(([input]) => String(input).endsWith(`/connections/${connectionId}`))).toBe(true);
    expect(mounted.wrapper.text()).toContain("本项目没有权限策略，当前默认 DENY");
  });

  it("FILE_READ 不回显连接目录，受管资源独立列出并由用户选入策略；撤销后仍可查历史", async () => {
    connect(); const data = state();
    data.connections = [{ id: connectionId, project_id: projectId, status: "ACTIVE", version: "1", capabilities: ["FILE_READ"], allowed_host: null, created_at: created }];
    data.resources = [{ id: resourceId, project_id: projectId, canonical_root: "D:\\Workspace\\managed", status: "ACTIVE", revision: "1", resource_epoch: "1" }];
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input).slice(root.length);
      if ((init?.method ?? "GET") === "GET") return baseGet(path, data) ?? response(404, {});
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      if (path === `/projects/${projectId}/permission-policies`) {
        expect(body).toMatchObject({ capability: "FILE_READ", resource_id: resourceId, decision: "ASK", max_payload_bytes: 2 });
        expect(body).not.toHaveProperty("host");
        data.policies = [{ id: policyId, project_id: projectId, status: "ACTIVE", active_version: "1", revision: "1", created_at: created }];
        data.versions = [{ version: "1", capability: "FILE_READ", action_type: "READ_FILE", target_prefix: "D:\\Workspace\\managed", decision: "ASK", max_payload_bytes: 2, created_at: created }];
        return response(201, receipt(String(body.command_id), { project_id: projectId, policy_id: policyId, revision: "1", version: "1", status: "ACTIVE" }));
      }
      if (path === `/projects/${projectId}/permission-policies/${policyId}/revoke`) {
        expect(body).toMatchObject({ expected_revision: "1" });
        data.policies = [{ ...data.policies[0], status: "REVOKED", active_version: null, revision: "2" }];
        return response(200, receipt(String(body.command_id), { project_id: projectId, policy_id: policyId, revision: "2", status: "REVOKED" }));
      }
      throw new Error(`Unexpected POST ${path}`);
    }); vi.stubGlobal("fetch", fetchMock);
    const mounted = await mountWorkbench(`/projects/${projectId}/connections`); unmount = mounted.unmount;
    expect(mounted.wrapper.text()).toContain("连接目录未由此接口公开");
    expect(mounted.wrapper.text()).toContain("D:\\Workspace\\managed");
    expect(mounted.wrapper.text()).toContain("Windows 文件写入目录身份：未绑定");
    await mounted.wrapper.get('[data-testid="policy-capability"]').setValue("FILE_READ");
    expect(mounted.wrapper.get('[data-testid="policy-resource"]').findAll("option")).toHaveLength(2);
    await mounted.wrapper.get('[data-testid="policy-resource"]').setValue(resourceId);
    await mounted.wrapper.get('[data-testid="policy-decision"]').setValue("ASK");
    await mounted.wrapper.get('[data-testid="policy-form"]').trigger("submit"); await flush();
    expect(mounted.wrapper.text()).toContain("FILE_READ · ASK");
    await mounted.wrapper.findAll("button").find((button) => button.text() === "撤销")!.trigger("click"); await flush();
    expect(mounted.wrapper.text()).toContain("无有效版本 · DENY");
    expect(mounted.wrapper.text()).toContain("查看已读取版本（1，最多最近 100 条）");
  });

  it("WEB_FETCH 策略主机与连接主机不同时只陈列事实，不宣称已获准入", async () => {
    connect(); const data = state();
    data.connections = [{ id: connectionId, project_id: projectId, status: "ACTIVE", version: "1", capabilities: ["WEB_FETCH"], allowed_host: "example.org", created_at: created }];
    data.policies = [{ id: policyId, project_id: projectId, status: "ACTIVE", active_version: "1", revision: "1", created_at: created }];
    data.versions = [{ version: "1", capability: "WEB_FETCH", action_type: "WEB_FETCH", target_prefix: "other.org", decision: "AUTO", max_payload_bytes: 2, created_at: created }];
    const fetchMock = vi.fn(async (input: RequestInfo | URL, _init?: RequestInit) => baseGet(String(input).slice(root.length), data) ?? response(404, {}));
    vi.stubGlobal("fetch", fetchMock);
    const mounted = await mountWorkbench(`/projects/${projectId}/connections`); unmount = mounted.unmount;
    expect(mounted.wrapper.text()).toContain("允许主机：example.org");
    expect(mounted.wrapper.text()).toContain("目标：other.org");
    expect(mounted.wrapper.text()).toContain("还需有效连接及目标边界匹配");
    expect(mounted.wrapper.text()).not.toContain("已授权");
    expect(fetchMock.mock.calls.every(([, init]) => (init?.method ?? "GET") === "GET")).toBe(true);
  });

  it("连接只读健康核对只重读服务端配置，不触发写入", async () => {
    connect(); const data = state();
    data.connections = [{ id: connectionId, project_id: projectId, status: "ACTIVE", version: "1", capabilities: ["WEB_FETCH"], allowed_host: "example.org", created_at: created }];
    const detail = { id: connectionId, project_id: projectId, status: "ACTIVE", version: "1", capabilities: ["WEB_FETCH"], allowed_host: "example.org", created_at: created };
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input).slice(root.length);
      if ((init?.method ?? "GET") !== "GET") throw new Error(`Unexpected write ${path}`);
      if (path === `/projects/${projectId}/connections/${connectionId}`) return response(200, detail);
      return baseGet(path, data) ?? response(404, {});
    }); vi.stubGlobal("fetch", fetchMock);
    const mounted = await mountWorkbench(`/projects/${projectId}/connections`); unmount = mounted.unmount;
    expect(mounted.wrapper.text()).toContain("已连接（尚未授权）");
    await mounted.wrapper.get(`[data-testid="connection-health-${connectionId}"]`).trigger("click"); await flush();
    expect(mounted.wrapper.text()).toContain("服务端只读核对");
    expect(mounted.wrapper.text()).toContain("允许主机 example.org");
    expect(mounted.wrapper.text()).toContain("真实可达性探针当前无只读接口");
    expect(fetchMock.mock.calls.every(([, init]) => (init?.method ?? "GET") === "GET")).toBe(true);
    expect(fetchMock.mock.calls.filter(([, init]) => init?.method === "POST")).toHaveLength(0);
  });

  it("版本冲突保留策略草稿与原 command_id；不静默覆盖新版", async () => {
    connect(); const data = state();
    data.policies = [{ id: policyId, project_id: projectId, status: "ACTIVE", active_version: "1", revision: "1", created_at: created }];
    data.versions = [{ version: "1", capability: "WEB_FETCH", action_type: "WEB_FETCH", target_prefix: "example.org", decision: "DENY", max_payload_bytes: 2, created_at: created }];
    let attemptedId = "";
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input).slice(root.length);
      if ((init?.method ?? "GET") === "GET") return baseGet(path, data) ?? response(404, {});
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      attemptedId = String(body.command_id);
      expect(body).toMatchObject({ expected_revision: "1", capability: "WEB_FETCH", resource_id: null, host: "example.org", decision: "ASK" });
      data.policies = [{ ...data.policies[0], revision: "2" }];
      return response(409, { code: "REVISION_CONFLICT", detail: "stale", conflict: { expected_revision: "1", actual_revision: "2" } });
    }); vi.stubGlobal("fetch", fetchMock);
    const mounted = await mountWorkbench(`/projects/${projectId}/connections`); unmount = mounted.unmount;
    await mounted.wrapper.findAll("button").find((button) => button.text() === "修订")!.trigger("click");
    await mounted.wrapper.get('[data-testid="policy-decision"]').setValue("ASK");
    await mounted.wrapper.get('[data-testid="policy-form"]').trigger("submit"); await flush();
    expect(mounted.wrapper.text()).toContain(`原 command_id：${attemptedId}`);
    expect(mounted.wrapper.get('[data-testid="policy-decision"]').attributes("value") ??
      (mounted.wrapper.get('[data-testid="policy-decision"]').element as HTMLSelectElement).value).toBe("ASK");
    expect(mounted.wrapper.text()).toContain("服务端当前版本是 2");
    expect(fetchMock.mock.calls.filter(([, init]) => init?.method === "POST")).toHaveLength(1);
  });

  it("响应丢失先查原回执，404 后只以原 command_id 和冻结内容重试", async () => {
    connect(); const data = state(); let sent: Record<string, unknown> | null = null; let sentCommandId = ""; let posts = 0;
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input).slice(root.length);
      if ((init?.method ?? "GET") === "GET") {
        if (path.startsWith("/commands/")) return response(404, { code: "COMMAND_NOT_FOUND", detail: "missing" });
        return baseGet(path, data) ?? response(404, {});
      }
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      if (path !== `/projects/${projectId}/connections`) throw new Error(`Unexpected POST ${path}`);
      posts++;
      if (posts === 1) { sent = body; sentCommandId = String(body.command_id); throw new TypeError("connection lost"); }
      expect(body).toEqual(sent);
      data.connections = [{ id: connectionId, project_id: projectId, status: "ACTIVE", version: "1", capabilities: ["WEB_FETCH"], allowed_host: "example.org", created_at: created }];
      return response(201, receipt(String(body.command_id), { project_id: projectId, connection_id: connectionId, version: "1", status: "ACTIVE" }));
    }); vi.stubGlobal("fetch", fetchMock);
    const mounted = await mountWorkbench(`/projects/${projectId}/connections`); unmount = mounted.unmount;
    await mounted.wrapper.get('[data-testid="connection-host"]').setValue("example.org");
    await mounted.wrapper.get(".connections-form").trigger("submit"); await flush();
    expect(mounted.wrapper.text()).toContain(`原 command_id：${sentCommandId}`);
    expect(mounted.wrapper.get(".connections-form button").attributes("disabled")).toBeDefined();
    await mounted.wrapper.findAll("button").find((button) => button.text() === "查询原命令回执")!.trigger("click"); await flush();
    expect(mounted.wrapper.text()).toContain("原命令回执暂未找到");
    await mounted.wrapper.findAll("button").find((button) => button.text() === "用原 ID 和内容重试")!.trigger("click"); await flush();
    expect(posts).toBe(2);
    expect(mounted.wrapper.text()).toContain("连接创建已由服务端回执和最新项目查询确认");
  });
});
