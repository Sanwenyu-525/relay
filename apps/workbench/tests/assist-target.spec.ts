import { act, createElement, type ReactElement } from "react";
import { createMemoryRouter, RouterProvider } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import AssistView from "../src/views/AssistView";
import { activateRelayConnection, resetRelayConnectionForTest, useFixtureData } from "../src/lib/relayConnection";
import { flush, mountReact } from "./mountApp";

const baseUrl = "http://127.0.0.1:8787";
const workspaceId = "11111111-1111-4111-8111-111111111111";
const projectId = "22222222-2222-4222-8222-222222222222";
const taskId = "33333333-3333-4333-8333-333333333333";
const sessionId = "66666666-6666-4666-8666-666666666666";
const prefix = `${baseUrl}/api/v1/workspaces/${workspaceId}`;

function response(body: unknown): Response {
  return { ok: true, status: 200, json: async () => body } as Response;
}

function task() {
  return { id: taskId, project_id: projectId, title: "新任务目标", status: "READY", mode: "ME",
    revision: "3", executor: { kind: "HUMAN", run_id: null, ownership_epoch: "0" },
    current_completion_id: null, waiting_reason: null, blocking_task_ids: [], unresolved_blocker_ids: [],
    allowed_actions: [], acceptance: { acceptance_revision: "1", objective: "目标", source: "CREATE", criteria: [] },
    dependencies: [] };
}

async function mountedAssist(path: string) {
  const router = createMemoryRouter([
    { path: "/projects/:id/assist", element: createElement(AssistView) },
    { path: "/tasks/:id/assist", element: createElement(AssistView) },
    { path: "/projects/:id/tasks", element: createElement("div") },
    { path: "/tasks/:id", element: createElement("div") }
  ], { initialEntries: [path] });
  const mounted = await mountReact(createElement(RouterProvider, { router }));
  return { router: { push: async (next: string) => { await act(async () => { await router.navigate(next); }); } }, wrapper: Object.assign(mounted.wrapper, { unmount: mounted.unmount }) };
}

afterEach(() => {
  resetRelayConnectionForTest();
  vi.unstubAllGlobals();
});

/** 与协作页任务聊天视图一致：standalone 任务作用域，不延迟建会话（V43-06 的空态场景）。 */
async function mountedTaskAssist(props: Record<string, unknown> = {}) {
  const TaskAssist = AssistView as unknown as (p: Record<string, unknown>) => ReactElement;
  const router = createMemoryRouter([
    { path: "/tasks/:id/assist", element: createElement(TaskAssist, { standalone: true,
      targetKind: "TASK", targetId: taskId, ...props }) }
  ], { initialEntries: [`/tasks/${taskId}/assist`] });
  const mounted = await mountReact(createElement(RouterProvider, { router }));
  return { wrapper: Object.assign(mounted.wrapper, { unmount: mounted.unmount }) };
}

/** 与协作页文件夹入口一致：没有 target，只有工作空间级会话可谈。 */
async function mountedUnassignedAssist(props: Record<string, unknown> = {}) {
  // AssistView 的 props 全部可选且带默认值，TS 会把 createElement 落到 DOM 的
  // Attributes 重载上；这里显式标注组件类型，让 props 按实际传入检查。
  const Unassigned = AssistView as unknown as (p: Record<string, unknown>) => ReactElement;
  const router = createMemoryRouter([
    { path: "/agent", element: createElement(Unassigned, { standalone: true,
      deferSessionCreation: true, workspaceLevel: true, ...props }) }
  ], { initialEntries: ["/agent"] });
  const mounted = await mountReact(createElement(RouterProvider, { router }));
  return { wrapper: Object.assign(mounted.wrapper, { unmount: mounted.unmount }) };
}

describe("P12 Assist 目标固定", () => {
  it("切换 Project 到 Task 后迟到的旧目标响应不能落到新目标", async () => {
    activateRelayConnection({ baseUrl, workspaceId, bearerToken: "test-token" });
    let releaseProject: ((value: Response) => void) | null = null;
    let projectReads = 0;
    vi.stubGlobal("fetch", vi.fn(async (input: string) => {
      const url = String(input);
      if (url === `${prefix}/projects/${projectId}`) {
        projectReads++;
        return projectReads === 1 ? new Promise<Response>((resolve) => { releaseProject = resolve; })
          : response({ id: projectId, title: "当前项目", project_type: "GENERAL", revision: "1", state_revision: "1", archived_at: null });
      }
      if (url === `${prefix}/tasks/${taskId}`) return response(task());
      if (url.startsWith(`${prefix}/assist-sessions?include_context=true`)) return response({ items: [] });
      throw new Error(`unexpected request ${url}`);
    }));
    const { router, wrapper } = await mountedAssist(`/projects/${projectId}/assist`);
    await flush(20);
    expect(releaseProject).not.toBeNull();
    await router.push(`/tasks/${taskId}/assist`);
    await flush(20);
    expect(wrapper.get('[data-testid="assist-target"]').text()).toContain("新任务目标");
    releaseProject!(response({ id: projectId, title: "旧项目目标", project_type: "GENERAL",
      revision: "1", state_revision: "1", archived_at: null }));
    await flush(20);
    expect(wrapper.text()).not.toContain("旧项目目标");
    expect(wrapper.text()).toContain("新任务目标");
    wrapper.unmount();
  });

  it("断开 live 时立即清除已读取目标，不展示伪会话", async () => {
    activateRelayConnection({ baseUrl, workspaceId, bearerToken: "test-token" });
    vi.stubGlobal("fetch", vi.fn(async (input: string) =>
      String(input) === `${prefix}/tasks/${taskId}` ? response(task()) :
      String(input) === `${prefix}/projects/${projectId}` ? response({ id: projectId, title: "当前项目", project_type: "GENERAL", revision: "1", state_revision: "1", archived_at: null }) : response({ items: [] })));
    const { wrapper } = await mountedAssist(`/tasks/${taskId}/assist`);
    await flush(20);
    expect(wrapper.text()).toContain("新任务目标");
    useFixtureData();
    await flush(20);
    expect(wrapper.get('[data-testid="assist-fixture-gap"]').text()).toContain("示例模式没有真实会话");
    expect(wrapper.text()).not.toContain("新任务目标");
    wrapper.unmount();
  });
});

describe("工作空间级会话", () => {
  it("没有项目与目录时仍渲染首条输入区，不停在目标占位", async () => {
    activateRelayConnection({ baseUrl, workspaceId, bearerToken: "test-token" });
    const posts: { path: string; body: Record<string, unknown> }[] = [];
    vi.stubGlobal("fetch", vi.fn(async (input: string, init?: RequestInit) => {
      const url = String(input);
      if (init?.method === "POST") {
        const body = JSON.parse(String(init.body ?? "{}")) as Record<string, unknown>;
        posts.push({ path: new URL(url).pathname, body });
        if (new URL(url).pathname.endsWith("/assist-sessions")) return {
          ok: true, status: 201, json: async () => ({ command_id: body.command_id,
            committed_at: "2026-10-05T00:00:00Z",
            result: { session_id: sessionId, workspace_id: workspaceId, project_id: null,
              task_id: null, title: "先聊聊这个目录", status: "ACTIVE", revision: "1",
              created_at: "2026-10-05T00:00:00Z", updated_at: "2026-10-05T00:00:00Z" } }) } as Response;
        throw new Error(`unexpected POST ${url}`);
      }
      if (url.startsWith(`${prefix}/assist-sessions`)) return response({ items: [] });
      throw new Error(`unexpected request ${url}`);
    }));
    const { wrapper } = await mountedUnassignedAssist();
    await flush(20);
    expect(wrapper.text()).not.toContain("正在核对对话目标与会话");
    expect(wrapper.get('[data-testid="assist-first-draft"]').exists()).toBe(true);
    // 标题只能来自这条消息本身：没有 target，也就没有 target.title。
    await wrapper.get('[data-testid="assist-first-draft"]').setValue("先聊聊这个目录要怎么改");
    await flush(20);
    await wrapper.get('[data-testid="assist-first-send"]').trigger("click");
    await flush(20);
    const create = posts.find((post) => post.path.endsWith("/assist-sessions"));
    expect(create?.body.project_id).toBeNull();
    expect(create?.body.title).toBe("先聊聊这个目录要怎么改");
    wrapper.unmount();
  });

  it("草稿为空时点新建会话不会因 target 为空而抛错，标题不为空", async () => {
    activateRelayConnection({ baseUrl, workspaceId, bearerToken: "test-token" });
    const posts: { path: string; body: Record<string, unknown> }[] = [];
    vi.stubGlobal("fetch", vi.fn(async (input: string, init?: RequestInit) => {
      const url = String(input);
      if (init?.method === "POST") {
        const body = JSON.parse(String(init.body ?? "{}")) as Record<string, unknown>;
        posts.push({ path: new URL(url).pathname, body });
        if (new URL(url).pathname.endsWith("/assist-sessions")) return {
          ok: true, status: 201, json: async () => ({ command_id: body.command_id,
            committed_at: "2026-10-05T00:00:00Z",
            result: { session_id: sessionId, workspace_id: workspaceId, project_id: null,
              task_id: null, title: "新讨论", status: "ACTIVE", revision: "1",
              created_at: "2026-10-05T00:00:00Z", updated_at: "2026-10-05T00:00:00Z" } }) } as Response;
        throw new Error(`unexpected POST ${url}`);
      }
      if (url.startsWith(`${prefix}/assist-sessions`)) return response({ items: [] });
      throw new Error(`unexpected request ${url}`);
    }));
    // deferSessionCreation=false 才会渲染会话栏，那条「新建会话」按钮直连 createSession()，
    // 绕过 sendFirst 的空内容早退 —— 草稿为空时 target.title 真的会被取到。
    const { wrapper } = await mountedUnassignedAssist({ deferSessionCreation: false,
      preferredSessionId: null });
    await flush(20);
    await wrapper.get('[data-testid="assist-new-session"]').trigger("click");
    await flush(20);
    const create = posts.find((post) => post.path.endsWith("/assist-sessions"));
    // CHECK (title <> '') 会拒绝空标题：命令必须发得出去，且带得出非空标题。
    expect(create?.body.title).toBe("新讨论");
    expect(create?.body.project_id).toBeNull();
    wrapper.unmount();
  });

  it("首条消息先选项目资料：点击即成为本次候选，发送时随首条消息冻结", async () => {
    activateRelayConnection({ baseUrl, workspaceId, bearerToken: "test-token" });
    const posts: { path: string; body: Record<string, unknown> }[] = [];
    const pathPrefix = `/api/v1/workspaces/${workspaceId}`;
    let created = false;
    vi.stubGlobal("fetch", vi.fn(async (input: string, init?: RequestInit) => {
      const url = String(input);
      const path = new URL(url).pathname;
      if (init?.method === "POST") {
        const body = JSON.parse(String(init.body ?? "{}")) as Record<string, unknown>;
        posts.push({ path, body });
        if (path.endsWith("/assist-sessions")) {
          created = true;
          return { ok: true, status: 201, json: async () => ({ command_id: body.command_id,
            committed_at: "2026-10-05T00:00:00Z",
            result: { session_id: sessionId, workspace_id: workspaceId, project_id: projectId,
              task_id: taskId, title: "关于新任务目标", status: "ACTIVE", revision: "1",
              created_at: "2026-10-05T00:00:00Z", updated_at: "2026-10-05T00:00:00Z" } }) } as Response;
        }
        if (path.endsWith("/messages")) {
          return { ok: true, status: 202, json: async () => ({ command_id: body.command_id,
            committed_at: "2026-10-05T00:00:00Z",
            result: { session_id: sessionId, user_message_id: "u-1", assistant_message_id: "a-1" } }) } as Response;
        }
        throw new Error(`unexpected POST ${url}`);
      }
      if (path === `${pathPrefix}/tasks/${taskId}`) { return response(task()); }
      if (path === `${pathPrefix}/projects/${projectId}`) return response({ id: projectId,
        title: "当前项目", project_type: "GENERAL", revision: "1", state_revision: "1", archived_at: null });
      if (path === `${pathPrefix}/knowledge`
        && new URL(url).searchParams.get("project_id") === projectId) return response([{ id: "k-1",
        project_id: projectId, title: "需求说明", status: "ACTIVE", revision: "1",
        current_version: "3", created_at: "2026-10-01T00:00:00Z",
        updated_at: "2026-10-01T00:00:00Z" }]);
      if (path === `${prefix}/assist-sessions/${sessionId}/messages`) return response({ items: [] });
      if (path === `${pathPrefix}/assist-sessions/${sessionId}`) return response({ id: sessionId,
        workspace_id: workspaceId, project_id: projectId, task_id: taskId,
        title: "关于新任务目标", status: "ACTIVE", revision: "1",
        created_at: "2026-10-05T00:00:00Z", updated_at: "2026-10-05T00:00:00Z" });
      if (path.startsWith(`${pathPrefix}/assist-sessions`)) return response({ items: created
        ? [{ id: sessionId, workspace_id: workspaceId, project_id: projectId, task_id: taskId,
          title: "关于新任务目标", status: "ACTIVE", revision: "1",
          created_at: "2026-10-05T00:00:00Z", updated_at: "2026-10-05T00:00:00Z" }] : [] });
      if (path.endsWith("/model-port")) return response({ provider: "fake", configured: false,
        model: null, base_url: null, max_call_tokens: null });
      if (path.includes("/model-port/")) return response({ current_config_fingerprint: null,
        last: null, matches_current_config: false, worker_startup_validation: "NOT_CONFIGURED" });
      if (path.endsWith("/chat-commands")) return response({ items: [] });
      return response({ items: [] });
    }));
    const { wrapper } = await mountedTaskAssist();
    try {
      await flush(80);
      // 首条消息没有会话级资料浮层，但「+」里的资料一级不再禁用。
      expect(wrapper.get('[data-testid="assist-attach-sources"]').attributes("disabled")).toBeUndefined();
      await wrapper.get('[data-testid="assist-attach"]').trigger("click"); await flush();
      await wrapper.get('[data-testid="assist-attach-sources"]').trigger("click"); await flush(20);
      await wrapper.get('[data-testid="assist-attach-project-0"]').trigger("click"); await flush();
      await wrapper.get('[data-testid="assist-first-draft"]').setValue("把这份资料带上");
      await flush();
      await wrapper.get('[data-testid="assist-first-send"]').trigger("click");
      await flush(80);
      const sent = posts.find((post) => post.path.endsWith("/messages"));
      expect(sent?.body).toMatchObject({ source_refs: [
        { kind: "KNOWLEDGE", root_id: "k-1", version: "3" }] });
    } finally { wrapper.unmount(); window.localStorage.clear(); }
  });

  // V43-06 反例：无会话的既有任务切到聊天视图，过去停在「开始讨论/选择会话/新建会话」
  // 的三选一停顿页，没有输入卡。空态必须直接给出首条输入路径，发送时才建会话；
  // 打开页面（只读）不得创建任何会话。
  it("无会话的任务切聊天视图直接给首条输入，发送才创建会话", async () => {
    activateRelayConnection({ baseUrl, workspaceId, bearerToken: "test-token" });
    const posts: { path: string; body: Record<string, unknown> }[] = [];
    let created = false;
    vi.stubGlobal("fetch", vi.fn(async (input: string, init?: RequestInit) => {
      const url = String(input);
      const path = url;
      if (init?.method === "POST") {
        const body = JSON.parse(String(init.body ?? "{}")) as Record<string, unknown>;
        posts.push({ path, body });
        if (path.endsWith("/assist-sessions")) {
          created = true;
          return { ok: true, status: 201, json: async () => ({ command_id: body.command_id,
            committed_at: "2026-10-05T00:00:00Z",
            result: { session_id: sessionId, workspace_id: workspaceId,
              project_id: body.project_id, task_id: body.task_id,
              title: "关于新任务目标", status: "ACTIVE", revision: "1",
              created_at: "2026-10-05T00:00:00Z", updated_at: "2026-10-05T00:00:00Z" } }) } as Response;
        }
        if (path.endsWith("/messages")) {
          return { ok: true, status: 202, json: async () => ({ command_id: body.command_id,
            committed_at: "2026-10-05T00:00:00Z",
            result: { session_id: sessionId, user_message_id: "u-1", assistant_message_id: "a-1" } }) } as Response;
        }
        throw new Error(`unexpected POST ${url}`);
      }
      if (path === `${prefix}/tasks/${taskId}`) return response(task());
      if (path === `${prefix}/projects/${projectId}`) return response({ id: projectId,
        title: "当前项目", project_type: "GENERAL", revision: "1", state_revision: "1", archived_at: null });
      if (path === `${prefix}/assist-sessions/${sessionId}/messages`) return response({ items: [] });
      if (path === `${prefix}/assist-sessions/${sessionId}`) return response({ id: sessionId,
        workspace_id: workspaceId, project_id: projectId, task_id: taskId,
        title: "关于新任务目标", status: "ACTIVE", revision: "1",
        created_at: "2026-10-05T00:00:00Z", updated_at: "2026-10-05T00:00:00Z" });
      if (path.startsWith(`${prefix}/assist-sessions`)) return response({ items: created
        ? [{ id: sessionId, workspace_id: workspaceId, project_id: projectId, task_id: taskId,
          title: "关于新任务目标", status: "ACTIVE", revision: "1",
          created_at: "2026-10-05T00:00:00Z", updated_at: "2026-10-05T00:00:00Z" }] : [] });
      // 会话面板的周边只读依赖：宽松兜底，避免把焦点测试绑在面板实现上。
      if (path.endsWith("/model-port")) return response({ provider: "fake", configured: false,
        model: null, base_url: null, max_call_tokens: null });
      if (path.includes("/model-port/")) return response({ current_config_fingerprint: null,
        last: null, matches_current_config: false, worker_startup_validation: "NOT_CONFIGURED" });
      if (path.endsWith("/chat-commands")) return response({ items: [] });
      return response({ items: [] });
    }));
    const { wrapper } = await mountedTaskAssist();
    await flush(30);
    // 旧的停顿页文案不再出现；主入口唯一且是输入卡。
    expect(wrapper.text()).not.toContain("目标已选。可以新建会话");
    expect(wrapper.get('[data-testid="assist-first-draft"]').exists()).toBe(true);
    // 只读打开不发任何写命令。
    expect(posts).toHaveLength(0);
    await wrapper.get('[data-testid="assist-first-draft"]').setValue("先讨论这个任务");
    await wrapper.get('[data-testid="assist-first-send"]').trigger("click");
    await flush(60);
    const create = posts.find((post) => post.path.endsWith("/assist-sessions"));
    expect(create?.body.task_id).toBe(taskId);
    expect(create?.body.project_id).toBe(projectId);
    expect(posts.filter((post) => post.path.endsWith("/messages"))).toHaveLength(1);
    expect(posts.filter((post) => post.path.endsWith("/assist-sessions"))).toHaveLength(1);
    wrapper.unmount();
  });
});
