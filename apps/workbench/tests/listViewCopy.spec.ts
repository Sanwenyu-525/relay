import { afterEach, describe, expect, it, vi } from "vitest";
import { activateRelayConnection, resetRelayConnectionForTest } from "../src/lib/relayConnection";
import { DomWrapper, flush, mountWorkbench } from "./mountApp";

const baseUrl = "http://127.0.0.1:8787";
const workspaceId = "11111111-1111-4111-8111-111111111111";
const projectId = "22222222-2222-4222-8222-222222222222";
const taskId = "33333333-3333-4333-8333-333333333333";
const tasksUrl = `${baseUrl}/api/v1/workspaces/${workspaceId}/tasks`;
const projectsUrl = `${baseUrl}/api/v1/workspaces/${workspaceId}/projects?status=active`;
const root = `${baseUrl}/api/v1/workspaces/${workspaceId}`;
const created = "2026-09-26T00:00:00Z";
let unmount: (() => void) | null = null;

afterEach(() => {
  unmount?.(); unmount = null;
  resetRelayConnectionForTest(); sessionStorage.clear(); vi.unstubAllGlobals();
});
function activate(): void {
  activateRelayConnection({ baseUrl, workspaceId, bearerToken: "test-bearer-token-0123456789abcdef" });
}
function response(status: number, body: unknown): Response {
  return { ok: status >= 200 && status < 300, status, json: async () => body } as Response;
}
function listItem(id = projectId): unknown {
  return { id, title: "待归档项目", project_type: "GENERAL", revision: "2", state_revision: "1",
    archived_at: null, archive_status: "ACTIVE", phase_key: "PLANNING",
    next_action_task_id: null, created_at: created, updated_at: created };
}
const portal = () => new DomWrapper(document.body);

describe("任务列表 live 文案与辅助入口", () => {
  it("加载态使用本机服务口径，不出现“真实”实现词", async () => {
    activate();
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      if (String(input).endsWith("/attention/interventions")) return response(200, { items: [] });
      if (String(input) === projectsUrl) return response(200, { items: [], next_cursor: null });
      // 任务列表请求挂起，页面停留在加载态。
      if (String(input) === `${tasksUrl}?scope=all`) return new Promise<Response>(() => {});
      throw new TypeError("offline");
    }));
    const mounted = await mountWorkbench("/tasks");
    unmount = mounted.unmount;
    expect(mounted.wrapper.text()).toContain("正在从本机服务读取");
    expect(mounted.wrapper.text()).not.toContain("正在读取真实");
  });

  it("按 ID 打开是折叠辅助入口，按钮为产品文案且路由语义不变", async () => {
    activate();
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      if (String(input).endsWith("/attention/interventions")) return response(200, { items: [] });
      if (String(input) === projectsUrl) return response(200, { items: [], next_cursor: null });
      if (String(input) === `${tasksUrl}?scope=all`) return response(200, { items: [], next_cursor: null });
      throw new TypeError("offline");
    }));
    const mounted = await mountWorkbench("/tasks");
    unmount = mounted.unmount;
    expect(mounted.wrapper.text()).toContain("按 ID 打开任务");
    expect(mounted.wrapper.text()).not.toContain("打开真实任务");
    expect(mounted.wrapper.get('[data-testid="tasks-live-open-task"]').text()).toBe("打开任务详情");
    await mounted.wrapper.get('input[name="live-task-id"]').setValue(taskId);
    await mounted.wrapper.get('[data-testid="tasks-live-open-task"]').trigger("click");
    await flush();
    expect(mounted.router.currentRoute.value.path).toBe(`/tasks/${taskId}`);
  });

  it("示例收件箱为空时使用收件箱空态，不冒充筛选无匹配", async () => {
    const mounted = await mountWorkbench("/tasks?fixture=empty&tab=inbox");
    unmount = mounted.unmount;
    const emptyState = mounted.wrapper.get('[data-testid="inbox-empty"]');
    expect(emptyState.text()).toContain("收件箱里没有任务");
    expect(mounted.wrapper.find('[data-testid="tasks-fixture-no-match"]').exists()).toBe(false);
    expect(mounted.wrapper.text()).not.toContain("当前筛选没有匹配的任务");
  });
});

describe("项目列表 live 计数与归档横幅", () => {
  it("范围页签只显示已加载范围的计数", async () => {
    activate();
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const path = String(input).slice(root.length);
      if (String(input).endsWith("/attention/interventions")) return response(200, { items: [] });
      // 左栏近期工作读 status=active；项目主区默认读 status=all。
      if (path === "/projects?status=active") return response(200, { items: [], next_cursor: null });
      if (path === "/projects?status=all") return response(200, { items: [listItem()], next_cursor: null });
      if (path === `${tasksUrl.slice(root.length)}?scope=all`) return response(200, { items: [], next_cursor: null });
      throw new Error(`Unexpected request ${path}`);
    }));
    const mounted = await mountWorkbench("/projects");
    unmount = mounted.unmount;
    // live 一次只加载一个范围：只有当前范围的页签带计数，其余不造数。
    expect(mounted.wrapper.get('[data-testid="projects-tab-all"]').text()).toContain("全部项目 (1)");
    expect(mounted.wrapper.get('[data-testid="projects-tab-active"]').text()).not.toContain("(");
    expect(mounted.wrapper.get('[data-testid="projects-tab-archived"]').text()).not.toContain("(");
  });

  it("归档成功横幅显示本设备可读时间，UUID 降为补充信息", async () => {
    activate();
    let archived = false;
    const posts: Record<string, unknown>[] = [];
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input).slice(root.length);
      if (String(input).endsWith("/attention/interventions")) return response(200, { items: [] });
      if (path === "/projects?status=active") return response(200, { items: [], next_cursor: null });
      if (path === "/projects?status=all") return response(200, {
        items: archived ? [] : [listItem()], next_cursor: null });
      if (path === `/projects/${projectId}`) return response(200, { id: projectId, title: "待归档项目",
        project_type: "GENERAL", revision: "2", state_revision: "1", archived_at: null });
      if (path === `/projects/${projectId}/archive` && init?.method === "POST") {
        posts.push(JSON.parse(String(init.body)) as Record<string, unknown>);
        archived = true;
        return response(200, { command_id: String(posts[0].command_id), committed_at: created,
          result: { project_id: projectId, revision: "3", archived_at: created, archive_status: "ARCHIVED" } });
      }
      throw new Error(`Unexpected request ${path}`);
    }));
    const mounted = await mountWorkbench("/projects");
    unmount = mounted.unmount;
    // 归档入口在详情抽屉里（点「⋯」打开，AppDialog 走 portal）。
    await mounted.wrapper.get(`[data-testid="project-card-more-${projectId}"]`).trigger("click"); await flush();
    await portal().get('[data-testid="project-archive"]').trigger("click"); await flush();
    await portal().get('[data-testid="project-archive-confirm"]').trigger("click"); await flush();
    const banner = mounted.wrapper.get('[data-testid="project-archive-success"]').text();
    // 设备显示时区默认 Asia/Shanghai：2026-09-26T00:00:00Z → 2026-09-26 08:00:00。
    expect(banner).toContain("2026-09-26 08:00:00");
    expect(banner).not.toContain("T00:00:00Z");
    expect(banner).toContain(projectId);
  });
});
