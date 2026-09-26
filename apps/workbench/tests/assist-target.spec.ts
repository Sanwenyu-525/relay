import { act, createElement } from "react";
import { createMemoryRouter, RouterProvider } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import AssistView from "../src/views/AssistView";
import { activateRelayConnection, resetRelayConnectionForTest, useFixtureData } from "../src/lib/relayConnection";
import { flush, mountReact } from "./mountApp";

const baseUrl = "http://127.0.0.1:8787";
const workspaceId = "11111111-1111-4111-8111-111111111111";
const projectId = "22222222-2222-4222-8222-222222222222";
const taskId = "33333333-3333-4333-8333-333333333333";
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
      if (url.startsWith(`${prefix}/assist-sessions?`)) return response({ items: [] });
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
