import { afterEach, describe, expect, it, vi } from "vitest";
import { activateRelayConnection, resetRelayConnectionForTest } from "../src/lib/relayConnection";
import { DomWrapper, dialogText, flush, mountWorkbench } from "./mountApp";

const workspaceId = "11111111-1111-4111-8111-111111111111";
const projectA = "22222222-2222-4222-8222-222222222222";
const projectB = "33333333-3333-4333-8333-333333333333";
const taskB = "44444444-4444-4444-8444-444444444444";
const sessionA = "55555555-5555-4555-8555-555555555555";
const sessionB = "66666666-6666-4666-8666-666666666666";
const sessionNew = "77777777-7777-4777-8777-777777777777";
const sessionSameProject = "88888888-8888-4888-8888-888888888888";
const prefix = `/api/v1/workspaces/${workspaceId}`;

function response(body: unknown, status = 200): Response {
  return { ok: status < 400, status, json: async () => body } as Response;
}

function session(id: string, projectId: string, taskId: string | null, title: string) {
  return { id, workspace_id: workspaceId, project_id: projectId, task_id: taskId,
    title, status: "ACTIVE", revision: "1", updated_at: id === sessionA ? "2026-09-29T10:00:00Z" : "2026-09-29T09:00:00Z" };
}

function project(id: string, title: string) {
  return { id, title, project_type: "GENERAL", revision: "1", state_revision: "1", archived_at: null };
}

function task() {
  return { id: taskB, project_id: projectB, title: "任务 B", status: "READY", mode: "ME", revision: "1",
    executor: { kind: "HUMAN", run_id: null, ownership_epoch: "0" }, current_completion_id: null,
    waiting_reason: null, blocking_task_ids: [], unresolved_blocker_ids: [], allowed_actions: [],
    acceptance: { acceptance_revision: "1", objective: "目标", source: "CREATE", criteria: [] }, dependencies: [] };
}

afterEach(() => { resetRelayConnectionForTest(); vi.unstubAllGlobals(); });

describe("独立 Agent 聊天", () => {
  it("从侧栏进入，示例模式明确没有真实会话或回复", async () => {
    const view = await mountWorkbench("/projects");
    await view.wrapper.get('nav[aria-label="主导航"] a[href="/agent"]').trigger("click");
    await flush();
    expect(view.router.currentRoute.value.path).toBe("/agent");
    expect(view.wrapper.get(".breadcrumbs").text()).toContain("Agent 聊天");
    expect(view.wrapper.get('[data-testid="agent-fixture-gap"]').text()).toContain("示例模式没有真实会话");
    expect(view.wrapper.find('[data-testid="assist-draft"]').exists()).toBe(false);
    view.unmount();
  });

  it("全空间会话核对归属后显示输入；切目标隔离旧消息，并沿原 Assist 命令新建任务会话", async () => {
    activateRelayConnection({ baseUrl: "http://127.0.0.1:8787", workspaceId, bearerToken: "test-token" });
    const first = session(sessionA, projectA, null, "项目 A 讨论");
    const second = session(sessionB, projectB, taskB, "任务 B 讨论");
    const sameProject = session(sessionSameProject, projectA, null, "项目 A 第二个会话");
    const created = session(sessionNew, projectB, taskB, "关于任务 B");
    let releaseOld: ((value: Response) => void) | null = null;
    let createdOnServer = false;
    let createBody: Record<string, unknown> | null = null;
    const fetchMock = vi.fn(async (input: string, init?: RequestInit) => {
      const url = new URL(String(input));
      const path = url.pathname;
      if (path === `${prefix}/assist-sessions` && init?.method === "POST") {
        createBody = JSON.parse(String(init.body)) as Record<string, unknown>;
        createdOnServer = true;
        return response({ command_id: createBody.command_id, committed_at: "2026-09-29T10:00:00Z",
          result: { ...created, session_id: sessionNew } }, 201);
      }
      if (path === `${prefix}/assist-sessions`) {
        const items = createdOnServer ? [first, second, sameProject, created] : [first, second, sameProject];
        return response({ items: url.searchParams.has("project_id")
          ? items.filter((item) => item.project_id === url.searchParams.get("project_id") && item.task_id === null)
          : url.searchParams.has("task_id")
            ? items.filter((item) => item.task_id === url.searchParams.get("task_id")) : items });
      }
      if (path === `${prefix}/assist-sessions/${sessionA}`) return response(first);
      if (path === `${prefix}/assist-sessions/${sessionB}`) return response(second);
      if (path === `${prefix}/assist-sessions/${sessionSameProject}`) return response(sameProject);
      if (path === `${prefix}/assist-sessions/${sessionNew}`) return response(created);
      if (path === `${prefix}/projects/${projectA}`) return response(project(projectA, "项目 A"));
      if (path === `${prefix}/projects/${projectB}`) return response(project(projectB, "项目 B"));
      if (path === `${prefix}/tasks/${taskB}`) return response(task());
      if (path === `${prefix}/projects`) return response({ items: [], next_cursor: null });
      if (path === `${prefix}/tasks`) return response({ items: [task()], next_cursor: null });
      if (path === `${prefix}/assist-sessions/${sessionA}/messages`) {
        return new Promise<Response>((resolve) => { releaseOld = resolve; });
      }
      if (path === `${prefix}/assist-sessions/${sessionB}/messages` ||
          path === `${prefix}/assist-sessions/${sessionSameProject}/messages` ||
          path === `${prefix}/assist-sessions/${sessionNew}/messages`) return response({ items: [] });
      if (path === `${prefix}/assist-proposals` || path === `${prefix}/skill-definitions`) return response({ items: [] });
      throw new Error(`unexpected request ${path}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    const view = await mountWorkbench("/agent");
    expect(view.wrapper.get('[data-testid="agent-chat-page"]').text()).toContain("项目 A 讨论");
    expect(view.wrapper.get('[data-testid="assist-target"]').text()).toContain("项目 A");
    expect(releaseOld).not.toBeNull();
    await view.wrapper.get('[data-testid="assist-draft"]').setValue("旧会话草稿");

    await view.wrapper.get(`[data-testid="agent-session-${sessionSameProject}"]`).trigger("click");
    await flush();
    expect(dialogText()).toContain("未发送的内容");
    expect((view.wrapper.get('[data-testid="assist-draft"]').element as HTMLTextAreaElement).value).toBe("旧会话草稿");
    await new DomWrapper(Array.from(document.querySelectorAll('[role="dialog"] button')).find((item) => item.textContent?.includes("留在当前会话")) ?? null).trigger("click");
    await view.wrapper.get(`[data-testid="agent-session-${sessionSameProject}"]`).trigger("click");
    await new DomWrapper(document.querySelector('[data-testid="agent-discard-draft"]')).trigger("click");
    await flush();
    expect(view.wrapper.get('[data-testid="assist-session"]').text()).toContain(sessionSameProject);
    expect((view.wrapper.get('[data-testid="assist-draft"]').element as HTMLTextAreaElement).value).toBe("");
    releaseOld!(response({ items: [{ id: "99999999-9999-4999-8999-999999999999",
      session_id: sessionA, seq: "1", role: "USER", status: "COMPLETED", intent: "DISCUSS",
      content: "旧项目内容", error_code: null, sources: [], usage: { input_tokens: null, output_tokens: null },
      cancel_requested: false }] }));
    await flush();
    expect(view.wrapper.text()).not.toContain("旧项目内容");

    await view.wrapper.get(`[data-testid="agent-session-${sessionB}"]`).trigger("click");
    await flush();
    expect(view.wrapper.get('[data-testid="assist-target"]').text()).toContain("任务 B");
    expect(view.wrapper.get('[data-testid="assist-draft"]').exists()).toBe(true);

    await view.wrapper.get('[data-testid="agent-new"]').trigger("click");
    await view.wrapper.get('[data-testid="agent-target-kind"]').setValue("TASK");
    await flush();
    await view.wrapper.get('[data-testid="agent-target-id"]').setValue(taskB);
    await view.wrapper.get('[data-testid="agent-open-target"]').trigger("click");
    await flush();
    await view.wrapper.get('[data-testid="assist-new-session"]').trigger("click");
    await flush();
    expect(createBody).toMatchObject({ project_id: projectB, task_id: taskB, title: "关于任务 B" });
    expect(view.wrapper.get('[data-testid="assist-session"]').text()).toContain(sessionNew);
    expect(view.wrapper.get(`[data-testid="agent-session-${sessionNew}"]`).exists()).toBe(true);
    view.unmount();
  });

  it("从新会话选择已有会话的目标时不自动打开旧会话，创建后才显示输入", async () => {
    activateRelayConnection({ baseUrl: "http://127.0.0.1:8787", workspaceId, bearerToken: "test-token" });
    const existing = session(sessionB, projectB, taskB, "旧任务会话");
    const created = session(sessionNew, projectB, taskB, "关于任务 B");
    let createdOnServer = false;
    let createBody: Record<string, unknown> | null = null;
    const fetchMock = vi.fn(async (input: string, init?: RequestInit) => {
      const url = new URL(String(input)); const path = url.pathname;
      if (path === `${prefix}/assist-sessions` && init?.method === "POST") {
        createBody = JSON.parse(String(init.body)) as Record<string, unknown>;
        createdOnServer = true;
        return response({ command_id: createBody.command_id, committed_at: "2026-09-29T10:00:00Z",
          result: { ...created, session_id: sessionNew } }, 201);
      }
      if (path === `${prefix}/assist-sessions`) return response({ items: createdOnServer ? [existing, created] : [existing] });
      if (path === `${prefix}/assist-sessions/${sessionB}`) return response(existing);
      if (path === `${prefix}/tasks/${taskB}`) return response(task());
      if (path === `${prefix}/projects/${projectB}`) return response(project(projectB, "项目 B"));
      if (path === `${prefix}/projects`) return response({ items: [], next_cursor: null });
      if (path === `${prefix}/tasks`) return response({ items: [task()], next_cursor: null });
      if (path === `${prefix}/assist-sessions/${sessionB}/messages`) return response({ items: [{
        id: "99999999-9999-4999-8999-999999999999", session_id: sessionB, seq: "1", role: "USER",
        status: "COMPLETED", intent: "DISCUSS", content: "旧会话正文", error_code: null,
        sources: [], usage: { input_tokens: null, output_tokens: null }, cancel_requested: false
      }] });
      if (path === `${prefix}/assist-sessions/${sessionNew}/messages` ||
          path === `${prefix}/assist-proposals` || path === `${prefix}/skill-definitions`)
        return response({ items: [] });
      throw new Error(`unexpected request ${path}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    const view = await mountWorkbench("/agent");
    expect(view.wrapper.get('[data-testid="assist-session"]').text()).toContain("旧会话正文");

    await view.wrapper.get('[data-testid="agent-new"]').trigger("click");
    await view.wrapper.get('[data-testid="agent-target-kind"]').setValue("TASK");
    await flush();
    await view.wrapper.get('[data-testid="agent-target-id"]').setValue(taskB);
    await view.wrapper.get('[data-testid="agent-open-target"]').trigger("click");
    await flush();
    expect(view.wrapper.find('[data-testid="assist-session-select"]').exists()).toBe(false);
    expect(view.wrapper.get('[data-testid="assist-new-session-prompt"]').text()).toContain("先点击“新建会话”");
    expect(view.wrapper.find('[data-testid="assist-session"]').exists()).toBe(false);
    expect(view.wrapper.find('[data-testid="assist-draft"]').exists()).toBe(false);
    expect(view.wrapper.text()).not.toContain("旧会话正文");
    expect(createBody).toBeNull();

    const refreshSessions = view.wrapper.findAll("button").find((item) => item.text().includes("刷新会话"));
    await refreshSessions?.trigger("click");
    await flush();
    expect(view.wrapper.find('[data-testid="assist-draft"]').exists()).toBe(false);

    await view.wrapper.get('[data-testid="assist-new-session"]').trigger("click");
    await flush();
    expect(createBody).toMatchObject({ project_id: projectB, task_id: taskB });
    expect(view.wrapper.get('[data-testid="assist-session"]').text()).toContain(sessionNew);
    expect(view.wrapper.get('[data-testid="assist-draft"]').exists()).toBe(true);
    view.unmount();
  });

  it("单会话归属与列表不一致时拒绝打开，避免显示旧目标", async () => {
    activateRelayConnection({ baseUrl: "http://127.0.0.1:8787", workspaceId, bearerToken: "test-token" });
    const listed = session(sessionA, projectA, null, "项目 A 讨论");
    vi.stubGlobal("fetch", vi.fn(async (input: string) => {
      const path = new URL(String(input)).pathname;
      if (path === `${prefix}/assist-sessions`) return response({ items: [listed] });
      if (path === `${prefix}/assist-sessions/${sessionA}`)
        return response({ ...listed, project_id: projectB });
      throw new Error(`unexpected request ${path}`);
    }));
    const view = await mountWorkbench("/agent");
    expect(view.wrapper.text()).toContain("会话归属已变化");
    expect(view.wrapper.find('[data-testid="assist-draft"]').exists()).toBe(false);
    view.unmount();
  });
});
