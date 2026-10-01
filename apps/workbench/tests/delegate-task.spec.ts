import { createElement } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import TaskDelegatePanel, { type DelegateTarget } from "../src/components/TaskDelegatePanel";
import { RelayApiClient } from "../src/api/relayClient";
import { activateRelayConnection, resetRelayConnectionForTest } from "../src/lib/relayConnection";
import { flush, mountReact, mountWorkbench } from "./mountApp";

const baseUrl = "http://127.0.0.1:8787";
const workspaceId = "11111111-1111-4111-8111-111111111111";
const projectId = "22222222-2222-4222-8222-222222222222";
const taskId = "33333333-3333-4333-8333-333333333333";
const runId = "44444444-4444-4444-8444-444444444444";
const prefix = `${baseUrl}/api/v1/workspaces/${workspaceId}`;
const taskUrl = `${prefix}/tasks/${taskId}`;
const runUrl = `${prefix}/runs/${runId}`;
let unmount: (() => void) | null = null;

afterEach(() => {
  unmount?.(); unmount = null;
  resetRelayConnectionForTest();
  vi.unstubAllGlobals();
});

function response(status: number, body: unknown): Response {
  return { ok: status >= 200 && status < 300, status, json: async () => body } as Response;
}

function task(delegated = false, project: string | null = projectId, allowedActions: string[] = ["START"]) {
  return {
    id: taskId, project_id: project, title: "待委托任务", status: delegated ? "IN_PROGRESS" : "READY",
    mode: delegated ? "DELEGATE_AI" : "ME", revision: delegated ? "3" : "2",
    executor: { kind: delegated ? "AI" : "HUMAN", run_id: delegated ? runId : null, ownership_epoch: delegated ? "1" : "0" },
    current_completion_id: null, waiting_reason: null, blocking_task_ids: [], unresolved_blocker_ids: [],
    allowed_actions: delegated ? [] : allowedActions,
    acceptance: { acceptance_revision: "1", objective: "交付可核对结果", source: "CREATE", criteria: [] },
    dependencies: []
  };
}

function run() {
  return {
    id: runId, task_id: taskId, status: "CREATED", revision: "0", wait_reason: null,
    current_step_id: null, steps: [], recent_attempts: [], blocking_review_ids: [],
    pending_control_request: null, unresolved_operation_ids: []
  };
}

function result() {
  return { run_id: runId, task_id: taskId, task_revision: "3", run_revision: "0", status: "CREATED", retry_of_run_id: null };
}

function activate(): void {
  activateRelayConnection({ baseUrl, workspaceId, bearerToken: "test-token" });
}

function downstream(url: string, delegated: boolean): Response | null {
  if (url === `${prefix}/projects/${projectId}`) return response(200, { id: projectId, title: "待委托项目", project_type: "GENERAL", revision: "1", state_revision: "1", archived_at: null });
  if (url === taskUrl) return response(200, task(delegated));
  if (url === runUrl) return response(200, run());
  if (url === `${runUrl}/reviews`) return response(200, { items: [] });
  if (url === `${runUrl}/context-manifests`) return response(200, { items: [], build: { status: "NOT_STARTED", reason_code: null, message: null } });
  return null;
}

describe("M03 首片 Task Delegate", () => {
  it("真实 READY/HUMAN 任务提交原版本命令，202 后进入真实 Run", async () => {
    activate();
    let delegated = false;
    let posted: Record<string, unknown> | null = null;
    vi.stubGlobal("fetch", vi.fn(async (input: string, init?: RequestInit) => {
      const url = String(input);
      if (url === `${taskUrl}/delegations` && init?.method === "POST") {
        posted = JSON.parse(String(init.body)) as Record<string, unknown>;
        delegated = true;
        return response(202, { command_id: posted.command_id, committed_at: "2026-09-24T00:00:00.000Z", result: result() });
      }
      return downstream(url, delegated) ?? Promise.reject(new Error(`unexpected request: ${url}`));
    }));
    const mounted = await mountWorkbench(`/tasks/${taskId}`); unmount = mounted.unmount;
    await mounted.wrapper.get('[data-testid="task-detail-tab-runs"]').trigger("click");
    expect(mounted.wrapper.get('[data-testid="task-delegate"]').attributes("disabled")).toBeUndefined();
    await mounted.wrapper.get('[data-testid="task-delegate"]').trigger("click");
    await flush(50);
    expect(posted).toMatchObject({ expected_task_revision: "2" });
    expect(posted).not.toHaveProperty("mock_gateway_action");
    expect(posted).not.toHaveProperty("file_read_action");
    expect(posted).not.toHaveProperty("web_fetch_action");
    expect(typeof (posted as Record<string, unknown> | null)?.command_id).toBe("string");
    expect(mounted.router.currentRoute.value.path).toBe(`/runs/${runId}`);
    expect(mounted.wrapper.get('[data-testid="run-detail"]').text()).toContain("待委托任务");
  });

  it("Delegate 将当前选中的不可变来源版本冻结为 context_sources", async () => {
    activate();
    const sourceId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    let posted: Record<string, unknown> | null = null;
    vi.stubGlobal("fetch", vi.fn(async (input: string, init?: RequestInit) => {
      const url = String(input);
      if (url.startsWith(`${prefix}/search?`)) return response(200, { items: [{
        type: "KNOWLEDGE", id: sourceId, version: "4", title: "明确资料", snippet: "摘要",
        matched_fields: ["title"], source_ref: `knowledge:${sourceId}:v4`,
        status: "ACTIVE", project_id: projectId }], next_cursor: null });
      if (url === `${taskUrl}/delegations` && init?.method === "POST") {
        posted = JSON.parse(String(init.body)) as Record<string, unknown>;
        return response(202, { command_id: posted.command_id,
          committed_at: "2026-09-26T00:00:00Z", result: result() });
      }
      return downstream(url, false) ?? Promise.reject(new Error(`unexpected request: ${url}`));
    }));
    const mounted = await mountWorkbench(`/tasks/${taskId}`); unmount = mounted.unmount;
    await mounted.wrapper.get('[data-testid="task-detail-tab-runs"]').trigger("click");
    await mounted.wrapper.get("#assist-source-query").setValue("资料");
    await mounted.wrapper.get('[data-testid="assist-source-picker"] form').trigger("submit");
    await flush();
    await mounted.wrapper.get('[data-testid="assist-source-picker"] input[type="checkbox"]').setValue(true);
    await mounted.wrapper.get('[data-testid="task-delegate"]').trigger("click");
    expect(posted).toMatchObject({ context_sources: [{ kind: "KNOWLEDGE", root_id: sourceId,
      version: "4" }] });
  });

  it("可选 Mock 文件动作从本项目配置选择，并随原 Delegate 命令冻结", async () => {
    activate();
    const connectionId = "55555555-5555-4555-8555-555555555555";
    const resourceId = "66666666-6666-4666-8666-666666666666";
    const target = "C:\\relay-mock\\sample.txt";
    let delegated = false;
    let posted: Record<string, unknown> | null = null;
    vi.stubGlobal("fetch", vi.fn(async (input: string, init?: RequestInit) => {
      const url = String(input);
      if (url === `${prefix}/projects/${projectId}/connections`) return response(200, [
        { id: connectionId, status: "ACTIVE", capabilities: ["FAKE_WRITE"], allowed_host: null },
        { id: "77777777-7777-4777-8777-777777777777", status: "DISABLED", capabilities: ["FAKE_WRITE"], allowed_host: null }
      ]);
      if (url === `${prefix}/projects/${projectId}/managed-resources`) return response(200, [
        { id: resourceId, status: "ACTIVE", canonical_root: "C:\\relay-mock" }
      ]);
      if (url === `${taskUrl}/delegations` && init?.method === "POST") {
        posted = JSON.parse(String(init.body)) as Record<string, unknown>;
        delegated = true;
        return response(202, { command_id: posted.command_id, committed_at: "2026-09-24T00:00:00.000Z", result: result() });
      }
      return downstream(url, delegated) ?? Promise.reject(new Error(`unexpected request: ${url}`));
    }));
    const mounted = await mountWorkbench(`/tasks/${taskId}`); unmount = mounted.unmount;
    await mounted.wrapper.get('[data-testid="task-detail-tab-runs"]').trigger("click");
    await mounted.wrapper.get('[data-testid="task-mock-action-toggle"]').setValue(true);
    await flush();
    expect(mounted.wrapper.get('[data-testid="task-mock-connection"]').findAll("option")).toHaveLength(2);
    const targetField = mounted.wrapper.get('[data-testid="task-mock-target"]');
    (targetField.element as HTMLInputElement).focus();
    await targetField.setValue(target);
    expect(document.activeElement).toBe(targetField.element);
    const contentField = mounted.wrapper.get('[data-testid="task-mock-content"]');
    (contentField.element as HTMLTextAreaElement).focus();
    await contentField.setValue("Mock marker");
    expect(document.activeElement).toBe(contentField.element);
    await mounted.wrapper.get('[data-testid="task-delegate"]').trigger("click");
    await flush(50);
    expect(posted).toMatchObject({ expected_task_revision: "2", mock_gateway_action: {
      connection_id: connectionId, resource_id: resourceId, target, content: "Mock marker"
    } });
    expect(mounted.router.currentRoute.value.path).toBe(`/runs/${runId}`);
  });

  it("响应丢失与回执暂缺时仅用原 command_id 查询，核对后进入 Run", async () => {
    activate();
    let delegated = false;
    let commandId = "";
    let postCount = 0;
    let receiptCount = 0;
    vi.stubGlobal("fetch", vi.fn(async (input: string, init?: RequestInit) => {
      const url = String(input);
      if (url === `${taskUrl}/delegations` && init?.method === "POST") {
        postCount++; commandId = String((JSON.parse(String(init.body)) as Record<string, unknown>).command_id);
        throw new TypeError("network lost");
      }
      if (url === `${prefix}/commands/${commandId}`) {
        receiptCount++;
        if (receiptCount === 1) return response(404, { code: "COMMAND_NOT_FOUND", detail: "pending" });
        delegated = true;
        return response(200, { command_id: commandId, command_type: "DelegateTask", committed_at: "2026-09-24T00:00:00.000Z", result: result() });
      }
      return downstream(url, delegated) ?? Promise.reject(new Error(`unexpected request: ${url}`));
    }));
    const mounted = await mountWorkbench(`/tasks/${taskId}`); unmount = mounted.unmount;
    await mounted.wrapper.get('[data-testid="task-detail-tab-runs"]').trigger("click");
    await mounted.wrapper.get('[data-testid="task-delegate"]').trigger("click");
    await flush();
    expect(mounted.wrapper.get('[data-testid="delegate-command-id"]').text()).toContain(commandId);
    expect(mounted.wrapper.find('[data-testid="task-delegate"]').exists()).toBe(false);
    await mounted.wrapper.get('[data-testid="delegate-check-receipt"]').trigger("click");
    await flush();
    expect(mounted.wrapper.text()).toContain("结果仍未确定");
    await mounted.wrapper.get('[data-testid="delegate-check-receipt"]').trigger("click");
    await flush(50);
    expect(postCount).toBe(1); expect(receiptCount).toBe(2);
    expect(mounted.router.currentRoute.value.path).toBe(`/runs/${runId}`);
  });

  it("成功响应无法核对时保留原 ID，拒绝不匹配的 Delegate 回执", async () => {
    activate();
    let commandId = "";
    let postCount = 0;
    let receiptCount = 0;
    vi.stubGlobal("fetch", vi.fn(async (input: string, init?: RequestInit) => {
      const url = String(input);
      if (url === `${taskUrl}/delegations` && init?.method === "POST") {
        postCount++; commandId = String((JSON.parse(String(init.body)) as Record<string, unknown>).command_id);
        return response(202, { command_id: "wrong-command", committed_at: "2026-09-24T00:00:00.000Z", result: result() });
      }
      if (url === `${prefix}/commands/${commandId}`) {
        receiptCount++;
        return response(200, { command_id: commandId, command_type: receiptCount === 1 ? "ResumeRun" : "DelegateTask",
          committed_at: "2026-09-24T00:00:00.000Z", result: result() });
      }
      return downstream(url, false) ?? Promise.reject(new Error(`unexpected request: ${url}`));
    }));
    const mounted = await mountWorkbench(`/tasks/${taskId}`); unmount = mounted.unmount;
    await mounted.wrapper.get('[data-testid="task-detail-tab-runs"]').trigger("click");
    await mounted.wrapper.get('[data-testid="task-delegate"]').trigger("click");
    await flush();
    await mounted.wrapper.get('[data-testid="delegate-check-receipt"]').trigger("click");
    await flush();
    expect(mounted.wrapper.text()).toContain("无法匹配");
    expect(mounted.router.currentRoute.value.path).toBe(`/tasks/${taskId}`);
    expect(mounted.wrapper.get('[data-testid="delegate-command-id"]').text()).toContain(commandId);
    expect(postCount).toBe(1);
  });

  it("fixture 不提供 Delegate；无 Project 的 READY 任务也不能委托", async () => {
    let mounted = await mountWorkbench("/tasks/task-evaluation-metrics"); unmount = mounted.unmount;
    await mounted.wrapper.get('[data-testid="task-detail-tab-runs"]').trigger("click");
    expect(mounted.wrapper.find('[data-testid="task-delegate"]').exists()).toBe(false);
    mounted.unmount(); unmount = null;
    activate();
    vi.stubGlobal("fetch", vi.fn(async (input: string) => {
      if (String(input) === taskUrl) return response(200, task(false, null));
      throw new Error("unexpected request");
    }));
    mounted = await mountWorkbench(`/tasks/${taskId}`); unmount = mounted.unmount;
    await mounted.wrapper.get('[data-testid="task-detail-tab-runs"]').trigger("click");
    expect(mounted.wrapper.get('[data-testid="task-delegate"]').attributes("disabled")).toBeDefined();
    expect(mounted.wrapper.get('[data-testid="task-delegate-panel"]').text()).toContain("缺少 AI 执行作用域");
  });

  it("已归档 Project 的 READY Task 深链保留事实但不发新 Delegate", async () => {
    activate();
    const fetchMock = vi.fn(async (input: string, init?: RequestInit) => {
      const url = String(input);
      if (url === `${prefix}/projects/${projectId}`) return response(200, { id: projectId, title: "历史项目",
        project_type: "GENERAL", revision: "2", state_revision: "1", archived_at: "2026-09-26T00:00:00Z" });
      if (init?.method === "POST") throw new Error("archived Task must not write");
      return downstream(url, false) ?? Promise.reject(new Error(`unexpected request: ${url}`));
    }); vi.stubGlobal("fetch", fetchMock);
    const mounted = await mountWorkbench(`/tasks/${taskId}`); unmount = mounted.unmount;
    await mounted.wrapper.get('[data-testid="task-detail-tab-runs"]').trigger("click");
    expect(mounted.wrapper.get('[data-testid="task-project-archive-reason"]').text()).toContain("已归档");
    expect(mounted.wrapper.get('[data-testid="task-delegate"]').attributes("disabled")).toBeDefined();
    await mounted.wrapper.get('[data-testid="task-delegate"]').trigger("click");
    expect(fetchMock.mock.calls.filter(([, init]) => init?.method === "POST")).toHaveLength(0);
  });
});

const fileConnectionId = "55555555-5555-4555-8555-555555555555";
const webConnectionId = "66666666-6666-4666-8666-666666666666";
const resourceId = "77777777-7777-4777-8777-777777777777";
const otherResourceId = "88888888-8888-4888-8888-888888888888";
const otherProjectId = "99999999-9999-4999-8999-999999999999";

function readConnections() {
  return [
    { id: fileConnectionId, status: "ACTIVE", capabilities: ["FILE_READ", "FAKE_WRITE"], allowed_host: null },
    { id: webConnectionId, status: "ACTIVE", capabilities: ["WEB_FETCH"], allowed_host: "localhost" },
    { id: "disabled-connection", status: "DISABLED", capabilities: ["FILE_READ", "WEB_FETCH"], allowed_host: null },
    { id: "wrong-capability", status: "ACTIVE", capabilities: ["FAKE_PUBLIC_READ"], allowed_host: null }
  ];
}

function readResources(project = projectId) {
  return [resourceId, otherResourceId].map((id) => ({ id, project_id: project,
    canonical_root: id === resourceId ? "C:\\relay-read" : "C:\\relay-read-other",
    status: "ACTIVE", revision: "1", resource_epoch: "2" }));
}

function readConfig(url: string): Response | null {
  if (url === `${prefix}/projects/${projectId}/connections`) return response(200, readConnections());
  if (url === `${prefix}/projects/${projectId}/managed-resources`) return response(200, readResources());
  return null;
}

async function mountDelegate() {
  activate();
  const client = new RelayApiClient({ baseUrl, workspaceId, bearerToken: "test-token" });
  let target: DelegateTarget = { id: taskId, projectId, status: "READY", executor: "HUMAN", revision: "2",
    executorRunId: null, allowedActions: ["START"] };
  const onDelegated = vi.fn();
  const render = () => createElement(TaskDelegatePanel, { client, task: target, projectWriteBlockedReason: null, onDelegated });
  const mounted = await mountReact(render()); unmount = mounted.unmount;
  return { ...mounted, onDelegated, setTarget: async (patch: Partial<DelegateTarget>) => {
    target = { ...target, ...patch }; await mounted.rerender(render());
  } };
}

describe("M04 Delegate 可选真实读取", () => {
  it("文件读取仅冻结确切 connection/resource/relative_target，保留原委托版本", async () => {
    let posted: Record<string, unknown> | null = null;
    vi.stubGlobal("fetch", vi.fn(async (input: string, init?: RequestInit) => {
      const url = String(input);
      if (url === `${taskUrl}/delegations` && init?.method === "POST") {
        posted = JSON.parse(String(init.body)) as Record<string, unknown>;
        return response(202, { command_id: posted.command_id, committed_at: "2026-09-30T00:00:00Z", result: result() });
      }
      return readConfig(url) ?? Promise.reject(new Error(`unexpected request: ${url}`));
    }));
    const mounted = await mountDelegate();
    expect((mounted.wrapper.get('[data-testid="task-read-kind"]').element as HTMLSelectElement).value).toBe("NONE");
    await mounted.wrapper.get('[data-testid="task-read-kind"]').setValue("FILE_READ"); await flush();
    expect(mounted.wrapper.get('[data-testid="task-read-connection"]').findAll("option")).toHaveLength(2);
    expect(mounted.wrapper.get('[data-testid="task-read-resource"]').findAll("option")).toHaveLength(3);
    await mounted.wrapper.get('[data-testid="task-read-relative-target"]').setValue(" notes/明确资料.md ");
    await mounted.wrapper.get('[data-testid="task-delegate"]').trigger("click"); await flush();
    expect(posted).toEqual({ command_id: expect.any(String), expected_task_revision: "2",
      file_read_action: { connection_id: fileConnectionId, resource_id: resourceId, relative_target: "notes/明确资料.md" } });
    expect(mounted.onDelegated).toHaveBeenCalledWith(runId);
  });

  it("网页读取仅冻结所选 WEB_FETCH 连接和 URL，允许明示 localhost 的隔离连接且不读目录", async () => {
    let posted: Record<string, unknown> | null = null;
    const fetchMock = vi.fn(async (input: string, init?: RequestInit) => {
      const url = String(input);
      if (url === `${taskUrl}/delegations` && init?.method === "POST") {
        posted = JSON.parse(String(init.body)) as Record<string, unknown>;
        return response(202, { command_id: posted.command_id, committed_at: "2026-09-30T00:00:00Z", result: result() });
      }
      return readConfig(url) ?? Promise.reject(new Error(`unexpected request: ${url}`));
    }); vi.stubGlobal("fetch", fetchMock);
    const mounted = await mountDelegate();
    await mounted.wrapper.get('[data-testid="task-read-kind"]').setValue("WEB_FETCH"); await flush();
    expect(mounted.wrapper.get('[data-testid="task-read-connection"]').text()).toContain("localhost");
    expect(mounted.wrapper.find('[data-testid="task-read-resource"]').exists()).toBe(false);
    await mounted.wrapper.get('[data-testid="task-read-url"]').setValue(" http://localhost:8765/source?q=relay ");
    await mounted.wrapper.get('[data-testid="task-delegate"]').trigger("click"); await flush();
    expect(posted).toEqual({ command_id: expect.any(String), expected_task_revision: "2",
      web_fetch_action: { connection_id: webConnectionId, url: "http://localhost:8765/source?q=relay" } });
    expect(fetchMock.mock.calls.some(([url]) => String(url).endsWith("/managed-resources"))).toBe(false);
  });

  it("文件目标空值、绝对路径和上级逃逸均禁止委托，合法相对文件可提交", async () => {
    const fetchMock = vi.fn(async (input: string) => readConfig(String(input)) ?? Promise.reject(new Error("must not delegate")));
    vi.stubGlobal("fetch", fetchMock);
    const mounted = await mountDelegate();
    await mounted.wrapper.get('[data-testid="task-read-kind"]').setValue("FILE_READ"); await flush();
    for (const value of ["", "../secret.txt", "notes/../../secret.txt", "notes\\..\\secret.txt", "C:\\secret.txt", "C:secret.txt", "/secret.txt", "\\\\host\\share\\secret.txt", ".", "notes/"]) {
      await mounted.wrapper.get('[data-testid="task-read-relative-target"]').setValue(value);
      expect(mounted.wrapper.get('[data-testid="task-delegate"]').attributes("disabled")).toBeDefined();
      expect(mounted.wrapper.get('[data-testid="task-read-blocked"]').text()).not.toBe("");
      await mounted.wrapper.get('[data-testid="task-delegate"]').trigger("click");
    }
    expect(fetchMock.mock.calls).toHaveLength(2);
    await mounted.wrapper.get('[data-testid="task-read-relative-target"]').setValue("资料\\source.md");
    expect(mounted.wrapper.get('[data-testid="task-delegate"]').attributes("disabled")).toBeUndefined();
  });

  it("网页目标拒绝非法 URL、非 http(s)、凭据和 fragment，不发委托", async () => {
    const fetchMock = vi.fn(async (input: string) => readConfig(String(input)) ?? Promise.reject(new Error("must not delegate")));
    vi.stubGlobal("fetch", fetchMock);
    const mounted = await mountDelegate();
    await mounted.wrapper.get('[data-testid="task-read-kind"]').setValue("WEB_FETCH"); await flush();
    for (const value of ["", "not a url", "file:///secret.txt", "ftp://example.org/source", "http:example.org", "https://user:password@example.org/source", "https://example.org/source#part", "https://example.org/source#"]) {
      await mounted.wrapper.get('[data-testid="task-read-url"]').setValue(value);
      expect(mounted.wrapper.get('[data-testid="task-delegate"]').attributes("disabled")).toBeDefined();
      await mounted.wrapper.get('[data-testid="task-delegate"]').trigger("click");
    }
    expect(fetchMock.mock.calls).toHaveLength(1);
    await mounted.wrapper.get('[data-testid="task-read-url"]').setValue("https://example.org/source?q=资料");
    expect(mounted.wrapper.get('[data-testid="task-delegate"]').attributes("disabled")).toBeUndefined();
  });

  it("真实读取与 Mock 双向互斥，切换种类清空旧目标且不暗留委托载荷", async () => {
    let posted: Record<string, unknown> | null = null;
    vi.stubGlobal("fetch", vi.fn(async (input: string, init?: RequestInit) => {
      const url = String(input);
      if (init?.method === "POST") {
        posted = JSON.parse(String(init.body)) as Record<string, unknown>;
        return response(202, { command_id: posted.command_id, committed_at: "2026-09-30T00:00:00Z", result: result() });
      }
      return readConfig(url) ?? Promise.reject(new Error(`unexpected request: ${url}`));
    }));
    const mounted = await mountDelegate();
    await mounted.wrapper.get('[data-testid="task-mock-action-toggle"]').setValue(true); await flush();
    await mounted.wrapper.get('[data-testid="task-mock-target"]').setValue("C:\\relay-read\\old.txt");
    await mounted.wrapper.get('[data-testid="task-mock-content"]').setValue("old Mock");
    await mounted.wrapper.get('[data-testid="task-read-kind"]').setValue("FILE_READ"); await flush();
    expect((mounted.wrapper.get('[data-testid="task-mock-action-toggle"]').element as HTMLInputElement).checked).toBe(false);
    await mounted.wrapper.get('[data-testid="task-read-relative-target"]').setValue("old.md");
    await mounted.wrapper.get('[data-testid="task-read-kind"]').setValue("WEB_FETCH"); await flush();
    expect((mounted.wrapper.get('[data-testid="task-read-url"]').element as HTMLInputElement).value).toBe("");
    await mounted.wrapper.get('[data-testid="task-read-url"]').setValue("http://localhost/source");
    await mounted.wrapper.get('[data-testid="task-mock-action-toggle"]').setValue(true); await flush();
    expect((mounted.wrapper.get('[data-testid="task-read-kind"]').element as HTMLSelectElement).value).toBe("NONE");
    expect((mounted.wrapper.get('[data-testid="task-mock-target"]').element as HTMLInputElement).value).toBe("");
    expect((mounted.wrapper.get('[data-testid="task-mock-content"]').element as HTMLTextAreaElement).value).toBe("");
    await mounted.wrapper.get('[data-testid="task-mock-target"]').setValue("C:\\relay-read\\new.txt");
    await mounted.wrapper.get('[data-testid="task-mock-content"]').setValue("new Mock");
    await mounted.wrapper.get('[data-testid="task-delegate"]').trigger("click"); await flush();
    expect(posted).toEqual({ command_id: expect.any(String), expected_task_revision: "2", mock_gateway_action: {
      connection_id: fileConnectionId, resource_id: resourceId, target: "C:\\relay-read\\new.txt", content: "new Mock" } });
  });

  it("关闭读取后提交不带任何旧读字段", async () => {
    let posted: Record<string, unknown> | null = null;
    vi.stubGlobal("fetch", vi.fn(async (input: string, init?: RequestInit) => {
      if (init?.method === "POST") {
        posted = JSON.parse(String(init.body)) as Record<string, unknown>;
        return response(202, { command_id: posted.command_id, committed_at: "2026-09-30T00:00:00Z", result: result() });
      }
      return readConfig(String(input)) ?? Promise.reject(new Error("unexpected request"));
    }));
    const mounted = await mountDelegate();
    await mounted.wrapper.get('[data-testid="task-read-kind"]').setValue("FILE_READ"); await flush();
    await mounted.wrapper.get('[data-testid="task-read-relative-target"]').setValue("old.md");
    await mounted.wrapper.get('[data-testid="task-read-kind"]').setValue("NONE");
    await mounted.wrapper.get('[data-testid="task-delegate"]').trigger("click"); await flush();
    expect(posted).toEqual({ command_id: expect.any(String), expected_task_revision: "2" });
  });

  it("配置加载中与失败时禁止提交，显式重读后才采用当前配置", async () => {
    let rejectConfig: ((reason: unknown) => void) | null = null;
    let connectionReads = 0;
    vi.stubGlobal("fetch", vi.fn(async (input: string) => {
      if (String(input).endsWith("/connections") && connectionReads++ === 0) {
        return new Promise<Response>((_resolve, reject) => { rejectConfig = reject; });
      }
      return readConfig(String(input)) ?? Promise.reject(new Error("must not delegate"));
    }));
    const mounted = await mountDelegate();
    await mounted.wrapper.get('[data-testid="task-read-kind"]').setValue("FILE_READ");
    expect(mounted.wrapper.get('[data-testid="task-read-blocked"]').text()).toContain("正在读取");
    expect(mounted.wrapper.get('[data-testid="task-delegate"]').attributes("disabled")).toBeDefined();
    rejectConfig!(new TypeError("configuration unavailable")); await flush();
    expect(mounted.wrapper.get('[data-testid="task-read-blocked"]').text()).toContain("无法读取");
    expect(mounted.wrapper.get('[data-testid="task-delegate"]').attributes("disabled")).toBeDefined();
    await mounted.wrapper.get('[data-testid="task-read-reload"]').trigger("click"); await flush();
    expect(connectionReads).toBe(2);
    await mounted.wrapper.get('[data-testid="task-read-relative-target"]').setValue("source.md");
    expect(mounted.wrapper.get('[data-testid="task-delegate"]').attributes("disabled")).toBeUndefined();
    await mounted.wrapper.get('[data-testid="task-read-reload"]').trigger("click"); await flush();
    expect((mounted.wrapper.get('[data-testid="task-read-relative-target"]').element as HTMLInputElement).value).toBe("");
    expect(mounted.wrapper.get('[data-testid="task-delegate"]').attributes("disabled")).toBeDefined();
  });

  it.each(["connection", "resource"])("没有 ACTIVE 所需能力或本项目 ACTIVE 目录时禁止文件委托：%s", async (missing) => {
    vi.stubGlobal("fetch", vi.fn(async (input: string) => {
      const url = String(input);
      if (url.endsWith("/connections")) return response(200, missing === "connection" ? readConnections().slice(1) : readConnections());
      if (url.endsWith("/managed-resources")) return response(200, missing === "resource"
        ? [{ ...readResources()[0], status: "DISABLED" }, ...readResources(otherProjectId)] : readResources());
      throw new Error("must not delegate");
    }));
    const mounted = await mountDelegate();
    await mounted.wrapper.get('[data-testid="task-read-kind"]').setValue("FILE_READ"); await flush();
    await mounted.wrapper.get('[data-testid="task-read-relative-target"]').setValue("source.md");
    expect(mounted.wrapper.get('[data-testid="task-read-blocked"]').text()).toContain(missing === "connection" ? "文件读取连接" : "受管目录");
    expect(mounted.wrapper.get('[data-testid="task-delegate"]').attributes("disabled")).toBeDefined();
  });

  it("变更连接或目录会清空旧目标，连接变更须重新选目录", async () => {
    vi.stubGlobal("fetch", vi.fn(async (input: string) => {
      if (String(input).endsWith("/connections")) return response(200, [...readConnections(),
        { id: "another-file-connection", status: "ACTIVE", capabilities: ["FILE_READ"], allowed_host: null }]);
      return readConfig(String(input)) ?? Promise.reject(new Error("unexpected request"));
    }));
    const mounted = await mountDelegate();
    await mounted.wrapper.get('[data-testid="task-read-kind"]').setValue("FILE_READ"); await flush();
    await mounted.wrapper.get('[data-testid="task-read-relative-target"]').setValue("source.md");
    await mounted.wrapper.get('[data-testid="task-read-resource"]').setValue(otherResourceId);
    expect((mounted.wrapper.get('[data-testid="task-read-relative-target"]').element as HTMLInputElement).value).toBe("");
    await mounted.wrapper.get('[data-testid="task-read-relative-target"]').setValue("other.md");
    await mounted.wrapper.get('[data-testid="task-read-connection"]').setValue("another-file-connection");
    expect((mounted.wrapper.get('[data-testid="task-read-resource"]').element as HTMLSelectElement).value).toBe("");
    expect((mounted.wrapper.get('[data-testid="task-read-relative-target"]').element as HTMLInputElement).value).toBe("");
    expect(mounted.wrapper.get('[data-testid="task-delegate"]').attributes("disabled")).toBeDefined();
  });

  it.each(["task", "project"])("切换 %s 清空读取输入，迟到的旧配置不污染新目标", async (changed) => {
    let releaseOld: ((value: Response) => void) | null = null;
    let firstRead = true;
    vi.stubGlobal("fetch", vi.fn(async (input: string) => {
      const url = String(input);
      if (url.endsWith("/connections")) {
        if (firstRead) { firstRead = false; return new Promise<Response>((resolve) => { releaseOld = resolve; }); }
        return response(200, [{ id: "current-connection", status: "ACTIVE", capabilities: ["FILE_READ"], allowed_host: null }]);
      }
      if (url.endsWith("/managed-resources")) return response(200, readResources(changed === "project" && !url.includes(`/projects/${projectId}/`) ? otherProjectId : projectId));
      throw new Error("unexpected request");
    }));
    const mounted = await mountDelegate();
    await mounted.wrapper.get('[data-testid="task-read-kind"]').setValue("FILE_READ");
    await mounted.wrapper.get('[data-testid="task-read-relative-target"]').setValue("old.md");
    await mounted.setTarget(changed === "task" ? { id: "new-task" } : { projectId: otherProjectId }); await flush();
    expect((mounted.wrapper.get('[data-testid="task-read-kind"]').element as HTMLSelectElement).value).toBe("NONE");
    await mounted.wrapper.get('[data-testid="task-read-kind"]').setValue("FILE_READ"); await flush();
    expect((mounted.wrapper.get('[data-testid="task-read-relative-target"]').element as HTMLInputElement).value).toBe("");
    releaseOld!(response(200, readConnections())); await flush();
    expect(mounted.wrapper.get('[data-testid="task-read-connection"]').text()).toContain("current-connection");
    expect(mounted.wrapper.get('[data-testid="task-read-connection"]').text()).not.toContain(fileConnectionId);
  });

  it("读取种类切换后的旧响应不能覆盖新 WEB_FETCH 配置", async () => {
    let releaseOld: ((value: Response) => void) | null = null;
    let reads = 0;
    vi.stubGlobal("fetch", vi.fn(async (input: string) => {
      if (String(input).endsWith("/connections") && reads++ === 0) return new Promise<Response>((resolve) => { releaseOld = resolve; });
      return readConfig(String(input)) ?? Promise.reject(new Error("unexpected request"));
    }));
    const mounted = await mountDelegate();
    await mounted.wrapper.get('[data-testid="task-read-kind"]').setValue("FILE_READ");
    await mounted.wrapper.get('[data-testid="task-read-kind"]').setValue("WEB_FETCH"); await flush();
    await mounted.wrapper.get('[data-testid="task-read-url"]').setValue("http://localhost/current");
    releaseOld!(response(200, readConnections().slice(0, 1))); await flush();
    expect((mounted.wrapper.get('[data-testid="task-read-connection"]').element as HTMLSelectElement).value).toBe(webConnectionId);
    expect((mounted.wrapper.get('[data-testid="task-read-url"]').element as HTMLInputElement).value).toBe("http://localhost/current");
  });

  it("读取委托结果 UNKNOWN 冻结原 command_id 与配置，只查询原回执", async () => {
    let posted: Record<string, unknown> | null = null;
    let posts = 0;
    const receiptIds: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (input: string, init?: RequestInit) => {
      const url = String(input);
      if (init?.method === "POST") { posts++; posted = JSON.parse(String(init.body)); throw new TypeError("response lost"); }
      if (url.includes("/commands/")) {
        receiptIds.push(url.split("/commands/")[1]);
        return response(404, { code: "COMMAND_NOT_FOUND", detail: "pending" });
      }
      return readConfig(url) ?? Promise.reject(new Error(`unexpected request: ${url}`));
    }));
    const mounted = await mountDelegate();
    await mounted.wrapper.get('[data-testid="task-read-kind"]').setValue("FILE_READ"); await flush();
    await mounted.wrapper.get('[data-testid="task-read-relative-target"]').setValue("source.md");
    await mounted.wrapper.get('[data-testid="task-delegate"]').trigger("click"); await flush();
    for (const selector of ["task-read-kind", "task-read-connection", "task-read-resource", "task-read-relative-target", "task-read-reload", "task-mock-action-toggle"]) {
      expect(mounted.wrapper.get(`[data-testid="${selector}"]`).attributes("disabled")).toBeDefined();
    }
    expect(mounted.wrapper.find('[data-testid="task-delegate"]').exists()).toBe(false);
    const original = posted as Record<string, unknown> | null;
    expect(mounted.wrapper.get('[data-testid="delegate-command-id"]').text()).toContain(String(original?.command_id));
    await mounted.wrapper.get('[data-testid="task-read-reload"]').trigger("click");
    await mounted.wrapper.get('[data-testid="task-mock-action-toggle"]').setValue(true);
    await mounted.wrapper.get('[data-testid="delegate-check-receipt"]').trigger("click"); await flush();
    await mounted.wrapper.get('[data-testid="delegate-check-receipt"]').trigger("click"); await flush();
    expect(posts).toBe(1); expect(receiptIds).toEqual([original?.command_id, original?.command_id]);
    expect(original?.file_read_action).toEqual({ connection_id: fileConnectionId, resource_id: resourceId, relative_target: "source.md" });
    expect((mounted.wrapper.get('[data-testid="task-read-relative-target"]').element as HTMLInputElement).value).toBe("source.md");
  });
});
