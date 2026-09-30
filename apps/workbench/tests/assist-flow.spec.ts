import { afterEach, describe, expect, it, vi } from "vitest";
import { activateRelayConnection, resetRelayConnectionForTest } from "../src/lib/relayConnection";
import { flush, mountWorkbench } from "./mountApp";

const baseUrl = "http://127.0.0.1:8787";
const workspaceId = "11111111-1111-4111-8111-111111111111";
const projectId = "22222222-2222-4222-8222-222222222222";
const sessionId = "33333333-3333-4333-8333-333333333333";
const sourceId = "44444444-4444-4444-8444-444444444444";
const proposalId = "55555555-5555-4555-8555-555555555555";
const prefix = `/api/v1/workspaces/${workspaceId}`;
const otherTaskId = "99999999-9999-4999-8999-999999999999";

function response(body: unknown, status = 200): Response {
  return { ok: status < 400, status, json: async () => body } as Response;
}
function session() {
  return { id: sessionId, workspace_id: workspaceId, project_id: projectId, task_id: null,
    title: "关于测试项目", status: "ACTIVE", revision: "1", updated_at: "2026-09-26T00:00:00Z" };
}
function message(id: string, seq: string, role: string, status: string, content: string | null,
  sources: unknown[] = []) {
  return { id, session_id: sessionId, seq, role, status, intent: "DISCUSS", content,
    error_code: null, sources, usage: { input_tokens: null, output_tokens: null }, cancel_requested: false };
}
function proposal(status: string) {
  return { id: proposalId, session_id: sessionId, message_id: "77777777-7777-4777-8777-777777777777",
    kind: "TASK_DEFINITION", target_type: "PROJECT", target_id: projectId, base_revision: "1",
    payload: { title: "计划任务", objective: "完成计划", criteria: [{ statement: "可检查", required: true, method: "HUMAN" }],
      expected_outputs: { kind: "MARKDOWN_DOCUMENT" } }, payload_hash: "abc123", status };
}

afterEach(() => { resetRelayConnectionForTest(); vi.unstubAllGlobals(); });

describe("M04 Assist 真实路由与命令", () => {
  it("Provider 六类失败显示中文处理指引，历史与业务失败不猜类别，也不自动重试", async () => {
    activateRelayConnection({ baseUrl, workspaceId, bearerToken: "test-token" });
    const categories = ["AUTH", "RATE_LIMIT", "TIMEOUT", "STREAM_BROKEN", "PROTOCOL", "NETWORK"];
    const messages = categories.map((category, index) => ({
      ...message(`failed-${index}`, String(index + 1), "ASSISTANT", "FAILED", null),
      error_code: "MODEL_FAILED", provider_error_kind: category }));
    const historical = { ...message("historical", "7", "ASSISTANT", "FAILED", null), error_code: "MODEL_FAILED" };
    const budget = { ...message("budget", "8", "ASSISTANT", "FAILED", null),
      error_code: "MODEL_BUDGET_EXHAUSTED", provider_error_kind: null };
    const fetchMock = vi.fn(async (input: string, init?: RequestInit) => {
      const path = new URL(String(input)).pathname;
      if (init?.method === "POST") throw new Error("失败展示不能触发重试");
      if (path === `${prefix}/projects/${projectId}`) return response({ id: projectId, title: "测试项目",
        project_type: "GENERAL", revision: "1", state_revision: "1", archived_at: null });
      if (path === `${prefix}/assist-sessions`) return response({ items: [session()] });
      if (path === `${prefix}/assist-sessions/${sessionId}/messages`)
        return response({ items: [...messages, historical, budget] });
      if (path === `${prefix}/assist-proposals`) return response({ items: [] });
      throw new Error(`unexpected request ${path}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    const view = await mountWorkbench(`/projects/${projectId}?skill=assist`);
    const guides = view.wrapper.findAll("[data-testid='assist-provider-error']");
    expect(guides).toHaveLength(6);
    ["认证失败", "限流", "超时", "流中断", "响应结构异常", "网络不可达"].forEach((label, index) => {
      expect(guides[index]!.text()).toContain(label);
    });
    expect(view.wrapper.text()).toContain("MODEL_FAILED");
    expect(view.wrapper.text()).toContain("MODEL_BUDGET_EXHAUSTED");
    expect(fetchMock.mock.calls.filter(([, init]) => init?.method === "POST")).toHaveLength(0);
    view.unmount();
  });
  it("已归档 Project Assist 深链可读历史会话，但禁新会话、消息、取消和接受提案", async () => {
    activateRelayConnection({ baseUrl, workspaceId, bearerToken: "test-token" });
    const fetchMock = vi.fn(async (input: string, init?: RequestInit) => {
      const path = new URL(String(input)).pathname;
      if (init?.method === "POST") throw new Error(`Unexpected write ${path}`);
      if (path === `${prefix}/projects/${projectId}`) return response({ id: projectId, title: "已归档项目",
        project_type: "GENERAL", revision: "2", state_revision: "1", archived_at: "2026-09-26T00:00:00Z" });
      if (path === `${prefix}/assist-sessions`) return response({ items: [session()] });
      if (path === `${prefix}/assist-sessions/${sessionId}/messages`) return response({ items: [
        message("77777777-7777-4777-8777-777777777777", "1", "ASSISTANT", "PENDING", null)] });
      if (path === `${prefix}/assist-proposals`) return response({ items: [proposal("PENDING")] });
      if (path === `${prefix}/skill-definitions`) return response({ items: [] });
      throw new Error(`unexpected request ${path}`);
    }); vi.stubGlobal("fetch", fetchMock);
    const view = await mountWorkbench(`/projects/${projectId}?skill=assist`);
    expect(view.wrapper.get('[data-testid="assist-archive-reason"]').text()).toContain("已归档");
    expect(view.wrapper.get('[data-testid="assist-new-session"]').attributes("disabled")).toBeDefined();
    await view.wrapper.get('[data-testid="assist-draft"]').setValue("仍想发送");
    expect(view.wrapper.get('[data-testid="assist-send"]').attributes("disabled")).toBeDefined();
    expect(view.wrapper.get('[data-testid="assist-cancel"]').attributes("disabled")).toBeDefined();
    expect(view.wrapper.get(".assist-proposal .primary-button").attributes("disabled")).toBeDefined();
    expect(fetchMock.mock.calls.filter(([, init]) => init?.method === "POST")).toHaveLength(0);
    view.unmount();
  });
  it("Task Assist 单读归属 Project，归档后禁新会话且保留任务事实", async () => {
    activateRelayConnection({ baseUrl, workspaceId, bearerToken: "test-token" });
    const fetchMock = vi.fn(async (input: string, init?: RequestInit) => {
      const path = new URL(String(input)).pathname;
      if (init?.method === "POST") throw new Error("archived Task Assist must not write");
      if (path === `${prefix}/tasks/${otherTaskId}`) return response({ id: otherTaskId, project_id: projectId,
        title: "历史任务", status: "READY", mode: "ME", revision: "1",
        executor: { kind: "HUMAN", run_id: null, ownership_epoch: "0" }, current_completion_id: null,
        waiting_reason: null, blocking_task_ids: [], unresolved_blocker_ids: [], allowed_actions: [],
        acceptance: { acceptance_revision: "1", objective: "历史目标", source: "CREATE", criteria: [] }, dependencies: [] });
      if (path === `${prefix}/projects/${projectId}`) return response({ id: projectId, title: "历史项目",
        project_type: "GENERAL", revision: "2", state_revision: "1", archived_at: "2026-09-26T00:00:00Z" });
      if (path === `${prefix}/assist-sessions`) return response({ items: [] });
      throw new Error(`unexpected request ${path}`);
    }); vi.stubGlobal("fetch", fetchMock);
    const view = await mountWorkbench(`/tasks/${otherTaskId}?skill=assist`);
    expect(view.wrapper.get('[data-testid="assist-target"]').text()).toContain("历史任务");
    expect(view.wrapper.get('[data-testid="assist-archive-reason"]').text()).toContain("已归档");
    await view.wrapper.get('[data-testid="assist-new-session"]').trigger("click");
    expect(fetchMock.mock.calls.filter(([, init]) => init?.method === "POST")).toHaveLength(0);
    view.unmount();
  });
  it("项目子页创建会话，冻结来源发送消息，并按服务端提案接受回执刷新", async () => {
    activateRelayConnection({ baseUrl, workspaceId, bearerToken: "test-token" });
    let created = false;
    let proposalStatus: string | null = null;
    let messages: unknown[] = [];
    let sentBody: Record<string, unknown> | null = null;
    let acceptBody: Record<string, unknown> | null = null;
    vi.stubGlobal("fetch", vi.fn(async (input: string, init?: RequestInit) => {
      const url = new URL(String(input));
      const path = url.pathname;
      if (path === `${prefix}/projects/${projectId}`) return response({ id: projectId, title: "测试项目",
        project_type: "GENERAL", revision: "1", state_revision: "1", archived_at: null });
      if (path === `${prefix}/assist-sessions` && init?.method !== "POST") {
        expect(url.searchParams.get("project_id")).toBe(projectId);
        return response({ items: created ? [session()] : [] });
      }
      if (path === `${prefix}/assist-sessions` && init?.method === "POST") {
        const body = JSON.parse(String(init.body)) as { command_id: string };
        created = true;
        return response({ command_id: body.command_id, committed_at: "2026-09-26T00:00:00Z",
          result: { ...session(), session_id: sessionId } }, 201);
      }
      if (path === `${prefix}/assist-sessions/${sessionId}/messages` && init?.method !== "POST") {
        return response({ items: messages });
      }
      if (path === `${prefix}/assist-sessions/${sessionId}/messages` && init?.method === "POST") {
        sentBody = JSON.parse(String(init.body)) as Record<string, unknown>;
        messages = [message("66666666-6666-4666-8666-666666666666", "1", "USER", "COMPLETED", "请列出计划"),
          message("77777777-7777-4777-8777-777777777777", "2", "ASSISTANT", "PENDING", null,
            [{ source_ref: `knowledge:${sourceId}:v2`, status: "FROZEN" }])];
        return response({ command_id: sentBody.command_id, committed_at: "2026-09-26T00:00:00Z",
          result: { session_id: sessionId, user_message_id: "66666666-6666-4666-8666-666666666666",
            assistant_message_id: "77777777-7777-4777-8777-777777777777" } }, 202);
      }
      if (path === `${prefix}/assist-proposals` && init?.method !== "POST") {
        return response({ items: proposalStatus ? [proposal(proposalStatus)] : [] });
      }
      if (path === `${prefix}/assist-proposals/${proposalId}/accept`) {
        acceptBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
        proposalStatus = "ACCEPTED";
        return response({ command_id: acceptBody.command_id, committed_at: "2026-09-26T00:00:00Z",
          result: { task_id: "88888888-8888-4888-8888-888888888888" } });
      }
      if (path === `${prefix}/search`) return response({ items: [{ type: "KNOWLEDGE", id: sourceId,
        version: "2", title: "资料版本", snippet: "受管片段", matched_fields: ["title"],
        source_ref: `knowledge:${sourceId}:v2`, status: "ACTIVE", project_id: projectId }], next_cursor: null });
      throw new Error(`unexpected request ${path}`);
    }));
    const view = await mountWorkbench(`/projects/${projectId}?skill=assist`);
    expect(view.wrapper.get('[data-testid="assist-target"]').text()).toContain("测试项目");
    await view.wrapper.get('[data-testid="assist-new-session"]').trigger("click");
    await flush();
    expect(view.wrapper.get('[data-testid="assist-session"]').text()).toContain(sessionId);
    await view.wrapper.get("#assist-source-query").setValue("资料");
    await view.wrapper.get('[data-testid="assist-source-picker"] form').trigger("submit");
    await flush();
    await view.wrapper.get('[data-testid="assist-source-picker"] input[type="checkbox"]').setValue(true);
    await view.wrapper.get('[data-testid="assist-draft"]').setValue("请列出计划");
    await view.wrapper.get('[data-testid="assist-intent"]').setValue("PROPOSE_TASK");
    await view.wrapper.get('[data-testid="assist-send"]').trigger("click");
    await flush();
    expect(sentBody).toMatchObject({ intent: "PROPOSE_TASK", content: "请列出计划",
      source_refs: [{ kind: "KNOWLEDGE", root_id: sourceId, version: "2" }] });
    expect(view.wrapper.get('[data-testid="assist-session"]').text()).toContain("等待生成");
    messages = [message("66666666-6666-4666-8666-666666666666", "1", "USER", "COMPLETED", "请列出计划"),
      message("77777777-7777-4777-8777-777777777777", "2", "ASSISTANT", "COMPLETED", "已生成计划",
        [{ source_ref: `knowledge:${sourceId}:v2`, status: "SENT" }])];
    proposalStatus = "PENDING";
    await view.wrapper.get('[data-testid="assist-refresh"]').trigger("click");
    await flush();
    expect(view.wrapper.text()).toContain("已生成计划");
    expect(view.wrapper.text()).toContain("输入 未知、输出 未知");
    expect(view.wrapper.text()).toContain("计划任务");
    await view.wrapper.get(".assist-proposal .primary-button").trigger("click");
    await flush();
    expect(acceptBody && Object.keys(acceptBody)).toEqual(["command_id"]);
    expect(view.wrapper.text()).toContain("ACCEPTED");
    view.unmount();
  });

  it("切换任务后忽略旧会话迟到消息，并显示服务端取消中与失败状态", async () => {
    activateRelayConnection({ baseUrl, workspaceId, bearerToken: "test-token" });
    const oldTaskId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    const oldSessionId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
    const newSessionId = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
    const assistantId = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
    let releaseOld: ((value: Response) => void) | null = null;
    let newStatus: "PENDING" | "RUNNING" | "FAILED" = "PENDING";
    let cancelRequested = false;
    vi.stubGlobal("fetch", vi.fn(async (input: string, init?: RequestInit) => {
      const url = new URL(String(input)); const path = url.pathname;
      if (path === `${prefix}/tasks/${oldTaskId}` || path === `${prefix}/tasks/${otherTaskId}`) {
        const taskId = path.endsWith(oldTaskId) ? oldTaskId : otherTaskId;
        return response({ id: taskId, project_id: projectId, title: taskId === oldTaskId ? "旧任务" : "新任务",
          status: "READY", mode: "ME", revision: "1",
          executor: { kind: "HUMAN", run_id: null, ownership_epoch: "0" },
          current_completion_id: null, waiting_reason: null, blocking_task_ids: [],
          unresolved_blocker_ids: [], allowed_actions: [],
          acceptance: { acceptance_revision: "1", objective: "目标", source: "CREATE", criteria: [] },
          dependencies: [] });
      }
      if (path === `${prefix}/projects/${projectId}`) return response({ id: projectId, title: "当前项目",
        project_type: "GENERAL", revision: "1", state_revision: "1", archived_at: null });
      if (path === `${prefix}/assist-sessions`) {
        const old = url.searchParams.get("task_id") === oldTaskId;
        return response({ items: [{ ...session(), id: old ? oldSessionId : newSessionId,
          task_id: old ? oldTaskId : otherTaskId }] });
      }
      if (path === `${prefix}/assist-sessions/${oldSessionId}/messages`) {
        return new Promise<Response>((resolve) => { releaseOld = resolve; });
      }
      if (path === `${prefix}/assist-sessions/${newSessionId}/messages`) {
        return response({ items: [{ ...message(assistantId, "1", "ASSISTANT", newStatus,
          newStatus === "FAILED" ? null : null), session_id: newSessionId,
          error_code: newStatus === "FAILED" ? "MODEL_FAILED" : null,
          cancel_requested: cancelRequested }] });
      }
      if (path === `${prefix}/assist-messages/${assistantId}/cancel` && init?.method === "POST") {
        const body = JSON.parse(String(init.body)) as { command_id: string };
        cancelRequested = true; newStatus = "RUNNING";
        return response({ command_id: body.command_id, committed_at: "2026-09-26T00:00:00Z",
          result: { message_id: assistantId, status: "RUNNING" } });
      }
      if (path === `${prefix}/assist-proposals`) return response({ items: [] });
      throw new Error(`unexpected request ${path}`);
    }));
    const view = await mountWorkbench(`/tasks/${oldTaskId}?skill=assist`);
    expect(releaseOld).not.toBeNull();
    await view.router.push(`/tasks/${otherTaskId}?skill=assist`);
    await flush();
    expect(view.wrapper.get('[data-testid="assist-target"]').text()).toContain("新任务");
    releaseOld!(response({ items: [{ ...message("eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee", "1",
      "USER", "COMPLETED", "旧任务密文"), session_id: oldSessionId }] }));
    await flush();
    expect(view.wrapper.text()).not.toContain("旧任务密文");
    await view.wrapper.get('[data-testid="assist-cancel"]').trigger("click");
    await flush();
    expect(view.wrapper.text()).toContain("正在取消");
    newStatus = "FAILED";
    await view.wrapper.get('[data-testid="assist-refresh"]').trigger("click");
    await flush();
    expect(view.wrapper.text()).toContain("MODEL_FAILED");
    view.unmount();
  });

  it("提案目标修订变化时展示冲突并重读已失效状态", async () => {
    activateRelayConnection({ baseUrl, workspaceId, bearerToken: "test-token" });
    let proposalStatus = "PENDING";
    vi.stubGlobal("fetch", vi.fn(async (input: string, init?: RequestInit) => {
      const url = new URL(String(input)); const path = url.pathname;
      if (path === `${prefix}/projects/${projectId}`) return response({ id: projectId, title: "测试项目",
        project_type: "GENERAL", revision: "2", state_revision: "1", archived_at: null });
      if (path === `${prefix}/assist-sessions`) return response({ items: [session()] });
      if (path === `${prefix}/assist-sessions/${sessionId}/messages`) return response({ items: [] });
      if (path === `${prefix}/assist-proposals`) return response({ items: [proposal(proposalStatus)] });
      if (path === `${prefix}/assist-proposals/${proposalId}/accept` && init?.method === "POST") {
        proposalStatus = "EXPIRED";
        return response({ code: "REVISION_CONFLICT", detail: "target revision changed",
          conflict: { expected_revision: "1", actual_revision: "2" } }, 409);
      }
      throw new Error(`unexpected request ${path}`);
    }));
    const view = await mountWorkbench(`/projects/${projectId}?skill=assist`);
    await view.wrapper.get(".assist-proposal .primary-button").trigger("click");
    await flush();
    expect(view.wrapper.text()).toContain("服务端当前版本是 2");
    expect(view.wrapper.text()).toContain("EXPIRED");
    view.unmount();
  });

  it("消息响应丢失后只用原 command_id 和原载荷重试", async () => {
    activateRelayConnection({ baseUrl, workspaceId, bearerToken: "test-token" });
    const attempts: Record<string, unknown>[] = [];
    let messages: unknown[] = [];
    vi.stubGlobal("fetch", vi.fn(async (input: string, init?: RequestInit) => {
      const url = new URL(String(input)); const path = url.pathname;
      if (path === `${prefix}/projects/${projectId}`) return response({ id: projectId, title: "测试项目",
        project_type: "GENERAL", revision: "1", state_revision: "1", archived_at: null });
      if (path === `${prefix}/assist-sessions`) return response({ items: [session()] });
      if (path === `${prefix}/assist-sessions/${sessionId}/messages` && init?.method !== "POST") {
        return response({ items: messages });
      }
      if (path === `${prefix}/assist-sessions/${sessionId}/messages` && init?.method === "POST") {
        const body = JSON.parse(String(init.body)) as Record<string, unknown>;
        attempts.push(body);
        if (attempts.length === 1) throw new Error("connection closed");
        messages = [message("66666666-6666-4666-8666-666666666666", "1", "USER", "COMPLETED", "保留原文")];
        return response({ command_id: body.command_id, committed_at: "2026-09-26T00:00:00Z",
          result: { session_id: sessionId, user_message_id: "66666666-6666-4666-8666-666666666666",
            assistant_message_id: "77777777-7777-4777-8777-777777777777" } }, 202);
      }
      if (path === `${prefix}/assist-proposals`) return response({ items: [] });
      throw new Error(`unexpected request ${path}`);
    }));
    const view = await mountWorkbench(`/projects/${projectId}?skill=assist`);
    await view.wrapper.get('[data-testid="assist-draft"]').setValue("保留原文");
    await view.wrapper.get('[data-testid="assist-send"]').trigger("click");
    await flush();
    expect(view.wrapper.text()).toContain("命令结果待核对");
    await view.wrapper.get(".assist-pending .secondary-button:last-child").trigger("click");
    await flush();
    expect(attempts).toHaveLength(2);
    expect(attempts[1]).toEqual(attempts[0]);
    expect(view.wrapper.text()).toContain("保留原文");
    view.unmount();
  });
});
