import { mount } from "@vue/test-utils";
import { createMemoryHistory, createRouter } from "vue-router";
import { afterEach, describe, expect, it, vi } from "vitest";
import AssistView from "../src/views/AssistView.vue";
import { activateRelayConnection, resetRelayConnectionForTest, useFixtureData } from "../src/lib/relayConnection";
import { flush } from "./mountApp";

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
  const router = createRouter({ history: createMemoryHistory(), routes: [
    { path: "/projects/:id/assist", name: "project-assist", component: AssistView },
    { path: "/tasks/:id/assist", name: "task-assist", component: AssistView },
    { path: "/projects/:id/tasks", component: { template: "<div />" } },
    { path: "/tasks/:id", component: { template: "<div />" } }
  ] });
  await router.push(path);
  await router.isReady();
  const wrapper = mount(AssistView, { global: { plugins: [router] } });
  return { router, wrapper };
}

afterEach(() => {
  resetRelayConnectionForTest();
  vi.unstubAllGlobals();
});

describe("P12 Assist 目标固定", () => {
  it("切换 Project 到 Task 后迟到的旧目标响应不能落到新目标", async () => {
    activateRelayConnection({ baseUrl, workspaceId, bearerToken: "test-token" });
    let releaseProject: ((value: Response) => void) | null = null;
    vi.stubGlobal("fetch", vi.fn(async (input: string) => {
      const url = String(input);
      if (url === `${prefix}/projects/${projectId}`) {
        return new Promise<Response>((resolve) => { releaseProject = resolve; });
      }
      if (url === `${prefix}/tasks/${taskId}`) return response(task());
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
    vi.stubGlobal("fetch", vi.fn(async () => response(task())));
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
