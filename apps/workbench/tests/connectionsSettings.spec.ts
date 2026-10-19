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
  it("目录检索连接可从页面配置且仍不自动授权", async () => {
    connect(); const data = state(); const rootPath = "D:\\Workspace\\query";
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input).slice(root.length);
      if ((init?.method ?? "GET") === "GET") return baseGet(path, data) ?? response(404, {});
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      expect(path).toBe(`/projects/${projectId}/connections`);
      expect(body).toMatchObject({ capabilities: ["FILE_QUERY"], root_path: rootPath });
      expect(body).not.toHaveProperty("allowed_host");
      data.connections = [{ id: connectionId, project_id: projectId, status: "ACTIVE", version: "1",
        capabilities: ["FILE_QUERY"], allowed_host: null, created_at: created }];
      return response(201, receipt(String(body.command_id), { project_id: projectId,
        connection_id: connectionId, version: "1", status: "ACTIVE" }));
    }); vi.stubGlobal("fetch", fetchMock);
    const mounted = await mountWorkbench(`/projects/${projectId}/connections`); unmount = mounted.unmount;
    expect(mounted.wrapper.find('[data-testid="connection-capability"] option[value="FILE_QUERY"]').exists()).toBe(true);
    await mounted.wrapper.get('[data-testid="connection-capability"]').setValue("FILE_QUERY");
    await mounted.wrapper.get('[data-testid="connection-root"]').setValue(rootPath);
    await mounted.wrapper.get(".connections-form").trigger("submit"); await flush();
    expect(mounted.wrapper.text()).toContain("连接创建已由服务端回执和最新项目查询确认");
    expect(mounted.wrapper.text()).toContain("本项目没有权限策略，当前默认 DENY");
    expect(fetchMock.mock.calls.filter(([, init]) => init?.method === "POST")).toHaveLength(1);
  });

  it("CLI_RUN 连接可点名根外可执行文件并在列表读回；其他能力不出现该输入", async () => {
    connect(); const data = state(); const rootPath = "D:\\Workspace\\query";
    const inputNodePath = "C:\\Program Files\\NodeJS\\node.exe";
    const normalizedNodePath = "C:\\Program Files\\nodejs\\node.exe";
    const toolPath = "D:\\Tools with spaces\\runner.exe";
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input).slice(root.length);
      if ((init?.method ?? "GET") === "GET") return baseGet(path, data) ?? response(404, {});
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      expect(path).toBe(`/projects/${projectId}/connections`);
      expect(body).toMatchObject({ capabilities: ["CLI_RUN"], root_path: rootPath,
        allowed_executables: [inputNodePath, toolPath] });
      data.connections = [{ id: connectionId, project_id: projectId, status: "ACTIVE", version: "1",
        capabilities: ["CLI_RUN"], allowed_host: null, allowed_executables: [normalizedNodePath, toolPath],
        created_at: created }];
      return response(201, receipt(String(body.command_id), { project_id: projectId,
        connection_id: connectionId, version: "1", status: "ACTIVE" }));
    }); vi.stubGlobal("fetch", fetchMock);
    const mounted = await mountWorkbench(`/projects/${projectId}/connections`); unmount = mounted.unmount;

    // 非 CLI_RUN 能力下不出现这个输入：挂到别的能力会被服务端明确拒绝。
    await mounted.wrapper.get('[data-testid="connection-capability"]').setValue("FILE_QUERY");
    expect(mounted.wrapper.find('[data-testid="connection-executables"]').exists()).toBe(false);

    await mounted.wrapper.get('[data-testid="connection-capability"]').setValue("CLI_RUN");
    expect(mounted.wrapper.find('[data-testid="connection-executables"]').exists()).toBe(true);
    await mounted.wrapper.get('[data-testid="connection-root"]').setValue(rootPath);
    await mounted.wrapper.get('[data-testid="connection-executables"]').setValue(`${inputNodePath}\r\n  \r\n${toolPath}\n`);
    await mounted.wrapper.get(".connections-form").trigger("submit"); await flush();

    // 读回的是服务端规范化后的生效值，不是用户输入的原文。
    expect(mounted.wrapper.get('[data-testid="connection-allowed-executables"]').text())
      .toBe(`允许的可执行文件：${normalizedNodePath}、${toolPath}`);
    expect(fetchMock.mock.calls.filter(([, init]) => init?.method === "POST")).toHaveLength(1);
  });

  it("离开 CLI_RUN 后即使保留草稿，其他能力也不提交允许可执行文件", async () => {
    connect(); const data = state(); const rootPath = "D:\\Workspace\\query";
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input).slice(root.length);
      if ((init?.method ?? "GET") === "GET") return baseGet(path, data) ?? response(404, {});
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      expect(path).toBe(`/projects/${projectId}/connections`);
      expect(body).toMatchObject({ capabilities: ["FILE_QUERY"], root_path: rootPath });
      expect(body).not.toHaveProperty("allowed_executables");
      data.connections = [{ id: connectionId, project_id: projectId, status: "ACTIVE", version: "1",
        capabilities: ["FILE_QUERY"], allowed_host: null, created_at: created }];
      return response(201, receipt(String(body.command_id), { project_id: projectId,
        connection_id: connectionId, version: "1", status: "ACTIVE" }));
    }); vi.stubGlobal("fetch", fetchMock);
    const mounted = await mountWorkbench(`/projects/${projectId}/connections`); unmount = mounted.unmount;

    await mounted.wrapper.get('[data-testid="connection-capability"]').setValue("CLI_RUN");
    await mounted.wrapper.get('[data-testid="connection-executables"]').setValue("C:\\Program Files\\nodejs\\node.exe");
    await mounted.wrapper.get('[data-testid="connection-capability"]').setValue("FILE_QUERY");
    expect(mounted.wrapper.find('[data-testid="connection-executables"]').exists()).toBe(false);
    await mounted.wrapper.get('[data-testid="connection-root"]').setValue(rootPath);
    await mounted.wrapper.get(".connections-form").trigger("submit"); await flush();
    expect(fetchMock.mock.calls.filter(([, init]) => init?.method === "POST")).toHaveLength(1);
  });

  it("CLI_RUN 服务端 422 是明确拒绝，不留下未知回执或原样重试入口", async () => {
    connect(); const data = state();
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input).slice(root.length);
      if ((init?.method ?? "GET") === "GET") return baseGet(path, data) ?? response(404, { code: "FIXTURE_NOT_FOUND", detail: path });
      return response(422, { code: "VALIDATION_FAILED", detail: "请求未通过校验。",
        field_errors: [{ field: "allowed_executables", message: "文件不存在或不是普通文件" }] });
    }); vi.stubGlobal("fetch", fetchMock);
    const mounted = await mountWorkbench(`/projects/${projectId}/connections`); unmount = mounted.unmount;
    await mounted.wrapper.get('[data-testid="connection-capability"]').setValue("CLI_RUN");
    await mounted.wrapper.get('[data-testid="connection-root"]').setValue("D:\\Workspace\\query");
    await mounted.wrapper.get('[data-testid="connection-executables"]').setValue("D:\\Missing\\tool.exe");
    await mounted.wrapper.get(".connections-form").trigger("submit"); await flush();

    expect(mounted.wrapper.find('[data-testid="connections-pending"]').exists()).toBe(false);
    expect(mounted.wrapper.findAll("button").some((button) => button.text().includes("用原 ID 和内容重试"))).toBe(false);
    expect(mounted.wrapper.findAll('[role="alert"]').map((alert) => alert.text()).join(" "))
      .toContain("allowed_executables");
    expect(fetchMock.mock.calls.filter(([, init]) => init?.method === "POST")).toHaveLength(1);
  });

  it("服务端撤销连接写权限时显示明确拒绝，不把 403 当成未知命令", async () => {
    connect(); const data = state();
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input).slice(root.length);
      if ((init?.method ?? "GET") === "GET") return baseGet(path, data) ?? response(404, {});
      return response(403, { code: "FORBIDDEN", detail: "连接写权限已撤销。" });
    }); vi.stubGlobal("fetch", fetchMock);
    const mounted = await mountWorkbench(`/projects/${projectId}/connections`); unmount = mounted.unmount;
    await mounted.wrapper.get('[data-testid="connection-host"]').setValue("example.org");
    await mounted.wrapper.get(".connections-form").trigger("submit"); await flush();

    expect(mounted.wrapper.find('[data-testid="connections-pending"]').exists()).toBe(false);
    expect(mounted.wrapper.findAll("button").some((button) => button.text().includes("用原 ID 和内容重试"))).toBe(false);
    expect(mounted.wrapper.findAll('[role="alert"]').map((alert) => alert.text()).join(" "))
      .toContain("连接写权限已撤销");
    expect(fetchMock.mock.calls.filter(([, init]) => init?.method === "POST")).toHaveLength(1);
  });

  it("连接权限读取失败时不展示新建表单，也不发送写命令", async () => {
    connect(); const data = state();
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input).slice(root.length);
      if ((init?.method ?? "GET") !== "GET") throw new Error(`不应提交写命令：${path}`);
      if (path === `/projects/${projectId}/connections`) return response(403, { code: "FORBIDDEN", detail: "无权读取连接配置。" });
      return baseGet(path, data) ?? response(404, { code: "FIXTURE_NOT_FOUND", detail: path });
    }); vi.stubGlobal("fetch", fetchMock);
    const mounted = await mountWorkbench(`/projects/${projectId}/connections`); unmount = mounted.unmount;
    expect(mounted.wrapper.findAll('[role="alert"]').map((alert) => alert.text()).join(" "))
      .toContain("无权读取连接配置");
    expect(mounted.wrapper.find(".connections-form").exists()).toBe(false);
    expect(fetchMock.mock.calls.filter(([, init]) => init?.method === "POST")).toHaveLength(0);
  });

  it("CLI_RUN 响应丢失后即使表单暂存值变化，回执查询和重试仍使用原 ID 与规范化前清单", async () => {
    connect(); const data = state();
    const rootPath = "D:\\Workspace\\query";
    const executables = ["C:\\Program Files\\nodejs\\node.exe", "D:\\Tools\\runner.exe"];
    let sent: Record<string, unknown> = {}; let posts = 0;
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input).slice(root.length);
      if ((init?.method ?? "GET") === "GET") {
        if (path.startsWith("/commands/")) return response(404, { code: "COMMAND_NOT_FOUND", detail: "missing" });
        return baseGet(path, data) ?? response(404, {});
      }
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      if (path !== `/projects/${projectId}/connections`) throw new Error(`Unexpected POST ${path}`);
      posts++;
      if (posts === 1) { sent = body; throw new TypeError("connection lost"); }
      expect(body).toEqual(sent);
      data.connections = [{ id: connectionId, project_id: projectId, status: "ACTIVE", version: "1",
        capabilities: ["CLI_RUN"], allowed_host: null, allowed_executables: executables, created_at: created }];
      return response(201, receipt(String(body.command_id), { project_id: projectId,
        connection_id: connectionId, version: "1", status: "ACTIVE" }));
    }); vi.stubGlobal("fetch", fetchMock);
    const mounted = await mountWorkbench(`/projects/${projectId}/connections`); unmount = mounted.unmount;
    await mounted.wrapper.get('[data-testid="connection-capability"]').setValue("CLI_RUN");
    await mounted.wrapper.get('[data-testid="connection-root"]').setValue(rootPath);
    await mounted.wrapper.get('[data-testid="connection-executables"]').setValue(executables.join("\n"));
    await mounted.wrapper.get(".connections-form").trigger("submit"); await flush();
    const originalCommandId = String(sent.command_id);
    expect(mounted.wrapper.text()).toContain(`原 command_id：${originalCommandId}`);

    // 服务端结果未决时界面会锁字段；测试将控件临时解锁并派发真实输入事件，验证重试不读当前草稿。
    const rootInput = mounted.wrapper.get('[data-testid="connection-root"]').element as HTMLInputElement;
    const executableInput = mounted.wrapper.get('[data-testid="connection-executables"]').element as HTMLTextAreaElement;
    const capabilitySelect = mounted.wrapper.get('[data-testid="connection-capability"]').element as HTMLSelectElement;
    rootInput.disabled = false; executableInput.disabled = false; capabilitySelect.disabled = false;
    await mounted.wrapper.get('[data-testid="connection-root"]').setValue("D:\\Workspace\\changed");
    await mounted.wrapper.get('[data-testid="connection-executables"]').setValue("E:\\Changed\\other.exe");
    await mounted.wrapper.get('[data-testid="connection-capability"]').setValue("FILE_QUERY");
    rootInput.disabled = true; executableInput.disabled = true; capabilitySelect.disabled = true;
    expect(executableInput.value).toBe("E:\\Changed\\other.exe");
    expect(capabilitySelect.value).toBe("FILE_QUERY");

    await mounted.wrapper.findAll("button").find((button) => button.text() === "查询原命令回执")!.trigger("click"); await flush();
    expect(mounted.wrapper.text()).toContain("原命令回执暂未找到");
    await mounted.wrapper.findAll("button").find((button) => button.text() === "用原 ID 和内容重试")!.trigger("click"); await flush();
    expect(posts).toBe(2);
    expect(sent).toMatchObject({ command_id: originalCommandId, capabilities: ["CLI_RUN"], root_path: rootPath,
      allowed_executables: executables });
    expect(mounted.wrapper.text()).toContain("连接创建已由服务端回执和最新项目查询确认");
  });

  it("未点名时不发送空清单，避免把「没配」变成一个死配置", async () => {
    connect(); const data = state(); const rootPath = "D:\\Workspace\\query";
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input).slice(root.length);
      if ((init?.method ?? "GET") === "GET") return baseGet(path, data) ?? response(404, {});
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      expect(body).toMatchObject({ capabilities: ["CLI_RUN"], root_path: rootPath });
      expect(body).not.toHaveProperty("allowed_executables");
      data.connections = [{ id: connectionId, project_id: projectId, status: "ACTIVE", version: "1",
        capabilities: ["CLI_RUN"], allowed_host: null, allowed_executables: null, created_at: created }];
      return response(201, receipt(String(body.command_id), { project_id: projectId,
        connection_id: connectionId, version: "1", status: "ACTIVE" }));
    }); vi.stubGlobal("fetch", fetchMock);
    const mounted = await mountWorkbench(`/projects/${projectId}/connections`); unmount = mounted.unmount;
    await mounted.wrapper.get('[data-testid="connection-capability"]').setValue("CLI_RUN");
    await mounted.wrapper.get('[data-testid="connection-root"]').setValue(rootPath);
    // 只有空行与空白：按未配置处理，不提交空数组。
    await mounted.wrapper.get('[data-testid="connection-executables"]').setValue("  \n   \n");
    await mounted.wrapper.get(".connections-form").trigger("submit"); await flush();
    expect(mounted.wrapper.get('[data-testid="connection-allowed-executables"]').text())
      .toContain("未配置");
    expect(fetchMock.mock.calls.filter(([, init]) => init?.method === "POST")).toHaveLength(1);
  });

  it("查询策略明确选择动作并在修订中保留，切换能力后清除旧动作", async () => {
    connect(); const data = state();
    data.resources = [{ id: resourceId, project_id: projectId, canonical_root: "D:\\Workspace\\query",
      status: "ACTIVE", revision: "1", resource_epoch: "1" }];
    const writes: Record<string, unknown>[] = [];
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input).slice(root.length);
      if ((init?.method ?? "GET") === "GET") return baseGet(path, data) ?? response(404, {});
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>; writes.push(body);
      const version = path.endsWith("/versions") ? "2" : "1";
      expect(body).toMatchObject({ capability: "FILE_QUERY", resource_id: resourceId, decision: "ASK",
        action_type: version === "1" ? "SEARCH_TEXT" : "FIND_PATHS" });
      if (version === "2") expect(body.expected_revision).toBe("1");
      data.policies = [{ id: policyId, project_id: projectId, status: "ACTIVE", active_version: version,
        revision: version, created_at: created }];
      data.versions.push({ version, capability: "FILE_QUERY", action_type: body.action_type,
        target_prefix: "D:\\Workspace\\query", decision: "ASK", max_payload_bytes: 2, created_at: created });
      return response(version === "1" ? 201 : 200, receipt(String(body.command_id), {
        project_id: projectId, policy_id: policyId, revision: version, version, status: "ACTIVE" }));
    }); vi.stubGlobal("fetch", fetchMock);
    const mounted = await mountWorkbench(`/projects/${projectId}/connections`); unmount = mounted.unmount;
    await mounted.wrapper.get('[data-testid="policy-capability"]').setValue("FILE_QUERY");
    await mounted.wrapper.get('[data-testid="policy-action"]').setValue("SEARCH_TEXT");
    await mounted.wrapper.get('[data-testid="policy-resource"]').setValue(resourceId);
    await mounted.wrapper.get('[data-testid="policy-decision"]').setValue("ASK");
    await mounted.wrapper.get('[data-testid="policy-form"]').trigger("submit"); await flush();
    await mounted.wrapper.findAll("button").find((button) => button.text() === "修订")!.trigger("click");
    expect(mounted.wrapper.get('[data-testid="policy-action"]').element).toHaveProperty("value", "SEARCH_TEXT");
    await mounted.wrapper.get('[data-testid="policy-action"]').setValue("FIND_PATHS");
    await mounted.wrapper.get('[data-testid="policy-resource"]').setValue(resourceId);
    await mounted.wrapper.get('[data-testid="policy-form"]').trigger("submit"); await flush();
    expect(writes).toHaveLength(2);
    await mounted.wrapper.get('[data-testid="policy-capability"]').setValue("CLI_RUN");
    expect(mounted.wrapper.get('[data-testid="policy-action"]').element).toHaveProperty("value", "");
    expect(mounted.wrapper.find('[data-testid="policy-action"] option[value="SEARCH_TEXT"]').exists()).toBe(false);
  });

  it("策略下拉切换载入所选动作，选择新建不继承旧动作", async () => {
    connect(); const data = state(); const secondPolicyId = "66666666-6666-4666-8666-666666666666";
    data.policies = [policyId, secondPolicyId].map((id) => ({ id, project_id: projectId,
      status: "ACTIVE", active_version: "1", revision: "1", created_at: created }));
    data.versions = [{ version: "1", capability: "FILE_QUERY", action_type: "SEARCH_TEXT",
      target_prefix: "D:\\Workspace\\query", decision: "ASK", max_payload_bytes: 2, created_at: created }];
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      expect(init?.method ?? "GET").toBe("GET");
      const path = String(input).slice(root.length);
      if (path === `/projects/${projectId}/permission-policies/${secondPolicyId}/versions`) {
        return response(200, [{ ...data.versions[0], action_type: "FIND_PATHS", decision: "DENY" }]);
      }
      return baseGet(path, data) ?? response(404, {});
    }); vi.stubGlobal("fetch", fetchMock);
    const mounted = await mountWorkbench(`/projects/${projectId}/connections`); unmount = mounted.unmount;
    await mounted.wrapper.findAll("button").find((button) => button.text() === "修订")!.trigger("click");
    await mounted.wrapper.get('[data-testid="policy-select"]').setValue(secondPolicyId);
    expect(mounted.wrapper.get('[data-testid="policy-action"]').element).toHaveProperty("value", "FIND_PATHS");
    expect(mounted.wrapper.get('[data-testid="policy-decision"]').element).toHaveProperty("value", "DENY");
    await mounted.wrapper.get('[data-testid="policy-select"]').setValue("");
    expect(mounted.wrapper.get('[data-testid="policy-action"]').element).toHaveProperty("value", "");
  });

  it("连接入口按真实项目名称选择并保留分页，不要求复制项目 ID", async () => {
    connect(); const data = state(); const nextId = "88888888-8888-4888-8888-888888888888";
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input).slice(root.length);
      if (init?.method === "POST") throw new Error("选择项目不提交命令");
      if (path === "/projects?status=active") return response(200, { items: [{ id: projectId,
        title: "论文项目", project_type: "THESIS", phase_key: "WRITING", revision: "2", state_revision: "1", next_action_task_id: null,
        archive_status: "ACTIVE", archived_at: null, created_at: created, updated_at: created }], next_cursor: "page2" });
      if (path === "/projects?status=active&cursor=page2") return response(200, { items: [{ id: nextId,
        title: "开发项目", project_type: "DEVELOPMENT", phase_key: "BUILD", revision: "1", state_revision: "1", next_action_task_id: null,
        archive_status: "ACTIVE", archived_at: null, created_at: created, updated_at: created }], next_cursor: null });
      return baseGet(path, data) ?? response(200, { items: [], next_cursor: null });
    }); vi.stubGlobal("fetch", fetchMock);
    const mounted = await mountWorkbench("/connections"); unmount = mounted.unmount;
    expect(mounted.wrapper.get(`a[href="/projects/${projectId}/connections"]`).text()).toBe("论文项目");
    await mounted.wrapper.findAll("button").find((button) => button.text() === "继续加载项目")!.trigger("click"); await flush();
    expect(mounted.wrapper.get(`a[href="/projects/${nextId}/connections"]`).text()).toBe("开发项目");
    await mounted.wrapper.get(`a[href="/projects/${projectId}/connections"]`).trigger("click"); await flush();
    expect(mounted.router.currentRoute.value.path).toBe(`/projects/${projectId}/connections`);
    expect(fetchMock.mock.calls.every(([, init]) => (init?.method ?? "GET") === "GET")).toBe(true);
  });
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
    // 按已知项目 ID 打开是备用入口，按钮不用主色与主流程抢层级。
    const openButtonClass = mounted.wrapper.get(".connections-entry button").attributes("class") ?? "";
    expect(openButtonClass).not.toContain("primary-button");
    expect(openButtonClass).toContain("secondary-button");
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
    // 列表行以中文为主：状态不与原枚举双写，标题用能力中文名。
    expect(mounted.wrapper.text()).toContain("已连接（尚未授权） · v1");
    expect(mounted.wrapper.text()).not.toContain("已连接（尚未授权） · ACTIVE");
    await mounted.wrapper.get('[data-testid="policy-host"]').setValue("example.org");
    await mounted.wrapper.get('[data-testid="policy-decision"]').setValue("AUTO");
    await mounted.wrapper.get('[data-testid="policy-form"]').trigger("submit"); await flush();
    expect(mounted.wrapper.text()).toContain("网页抓取 · 自动准入");
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
    expect(mounted.wrapper.text()).toContain("已停用（失效） · v2");
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
    expect(mounted.wrapper.text()).toContain("本列表最多读取服务端前 100 条，没有下一页");
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
    // 受管资源状态用中文短名，原枚举降为 title。
    expect(mounted.wrapper.text()).toContain("有效 · rev 1");
    await mounted.wrapper.get('[data-testid="policy-capability"]').setValue("FILE_READ");
    expect(mounted.wrapper.get('[data-testid="policy-resource"]').findAll("option")).toHaveLength(2);
    await mounted.wrapper.get('[data-testid="policy-resource"]').setValue(resourceId);
    await mounted.wrapper.get('[data-testid="policy-decision"]').setValue("ASK");
    await mounted.wrapper.get('[data-testid="policy-form"]').trigger("submit"); await flush();
    expect(mounted.wrapper.text()).toContain("文件读取 · 每次请求审批");
    await mounted.wrapper.findAll("button").find((button) => button.text() === "撤销")!.trigger("click"); await flush();
    expect(mounted.wrapper.text()).toContain("无有效版本 · 拒绝");
    expect(mounted.wrapper.text()).toContain("查看已读取版本（1，最多最近 100 条）");
  });

  it("CLI_RUN 连接与策略只绑定受管目录：能力可选中、目录必填、策略不出现主机字段", async () => {
    connect(); const data = state(); const rootPath = "D:\\Workspace\\source";
    data.resources = [{ id: resourceId, project_id: projectId, canonical_root: "D:\\Workspace\\managed", status: "ACTIVE", revision: "1", resource_epoch: "1" }];
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input).slice(root.length);
      if ((init?.method ?? "GET") === "GET") return baseGet(path, data) ?? response(404, {});
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      if (path === `/projects/${projectId}/connections`) {
        expect(body).toMatchObject({ capabilities: ["CLI_RUN"], root_path: rootPath });
        expect(body).not.toHaveProperty("allowed_host");
        data.connections = [{ id: connectionId, project_id: projectId, status: "ACTIVE", version: "1", capabilities: ["CLI_RUN"], allowed_host: null, created_at: created }];
        return response(201, receipt(String(body.command_id), { project_id: projectId, connection_id: connectionId, version: "1", status: "ACTIVE" }));
      }
      if (path === `/projects/${projectId}/permission-policies`) {
        expect(body).toMatchObject({ capability: "CLI_RUN", resource_id: resourceId, decision: "ASK", max_payload_bytes: 2 });
        expect(body).not.toHaveProperty("host");
        data.policies = [{ id: policyId, project_id: projectId, status: "ACTIVE", active_version: "1", revision: "1", created_at: created }];
        data.versions = [{ version: "1", capability: "CLI_RUN", action_type: "CLI_RUN", target_prefix: "D:\\Workspace\\managed", decision: "ASK", max_payload_bytes: 2, created_at: created }];
        return response(201, receipt(String(body.command_id), { project_id: projectId, policy_id: policyId, revision: "1", version: "1", status: "ACTIVE" }));
      }
      throw new Error(`Unexpected POST ${path}`);
    }); vi.stubGlobal("fetch", fetchMock);
    const mounted = await mountWorkbench(`/projects/${projectId}/connections`); unmount = mounted.unmount;
    const connectionOptions = mounted.wrapper.get('[data-testid="connection-capability"]')
      .findAll("option").map((option) => option.attributes("value"));
    expect(connectionOptions).toEqual(["WEB_FETCH", "FILE_READ", "FILE_QUERY", "FILE_WRITE", "GIT_READ", "GIT_WRITE", "CLI_RUN",
      "COMPUTER_READ", "COMPUTER_INPUT", "GITHUB_READ", "BROWSER_READ", "BROWSER_ACTION", "BROWSER_COMMIT", "FAKE_WRITE", "FAKE_PUBLIC_READ"]);
    await mounted.wrapper.get('[data-testid="connection-capability"]').setValue("CLI_RUN");
    await mounted.wrapper.get(".connections-form").trigger("submit"); await flush();
    expect(fetchMock.mock.calls.filter(([, init]) => init?.method === "POST")).toHaveLength(0);
    await mounted.wrapper.get('[data-testid="connection-root"]').setValue(rootPath);
    await mounted.wrapper.get(".connections-form").trigger("submit"); await flush();
    expect(mounted.wrapper.text()).toContain("CLI_RUN");
    await mounted.wrapper.get('[data-testid="policy-capability"]').setValue("CLI_RUN");
    expect(mounted.wrapper.find('[data-testid="policy-host"]').exists()).toBe(false);
    await mounted.wrapper.get('[data-testid="policy-resource"]').setValue(resourceId);
    await mounted.wrapper.get('[data-testid="policy-decision"]').setValue("ASK");
    await mounted.wrapper.get('[data-testid="policy-form"]').trigger("submit"); await flush();
    expect(mounted.wrapper.text()).toContain("命令行执行 · 每次请求审批");
  });

  it("FAKE 能力不绑定任何边界：连接与策略都不出现目录或主机输入", async () => {
    connect(); const data = state();
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input).slice(root.length);
      if ((init?.method ?? "GET") === "GET") return baseGet(path, data) ?? response(404, {});
      throw new Error(`Unexpected write ${path}`);
    }); vi.stubGlobal("fetch", fetchMock);
    const mounted = await mountWorkbench(`/projects/${projectId}/connections`); unmount = mounted.unmount;
    await mounted.wrapper.get('[data-testid="connection-capability"]').setValue("FAKE_PUBLIC_READ");
    expect(mounted.wrapper.find('[data-testid="connection-root"]').exists()).toBe(false);
    expect(mounted.wrapper.find('[data-testid="connection-host"]').exists()).toBe(false);
    await mounted.wrapper.get('[data-testid="policy-capability"]').setValue("FAKE_PUBLIC_READ");
    expect(mounted.wrapper.find('[data-testid="policy-host"]').exists()).toBe(false);
    expect(mounted.wrapper.find('[data-testid="policy-resource"]').exists()).toBe(false);
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
    // 健康结果只保留一种状态表达，不再「枚举（中文）」双写。
    expect(mounted.wrapper.text()).not.toContain("ACTIVE（已连接）");
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
