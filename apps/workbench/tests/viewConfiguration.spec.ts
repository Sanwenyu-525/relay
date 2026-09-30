import { afterEach, describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { RelayApiClient } from "../src/api/relayClient";
import ViewConfigurationPanel from "../src/components/ViewConfigurationPanel";
import { activateRelayConnection, resetRelayConnectionForTest } from "../src/lib/relayConnection";
import { flush, mountReact, mountWorkbench } from "./mountApp";

const baseUrl = "http://127.0.0.1:8787";
const workspaceId = "11111111-1111-4111-8111-111111111111";
const projectId = "22222222-2222-4222-8222-222222222222";
const root = `${baseUrl}/api/v1/workspaces/${workspaceId}`;
const viewPath = `/projects/${projectId}/view-configuration`;
const created = "2026-09-26T00:00:00.000Z";
type Kind = "general" | "thesis" | "development";
let unmount: (() => void) | null = null;

afterEach(() => {
  unmount?.(); unmount = null;
  resetRelayConnectionForTest();
  sessionStorage.clear();
  vi.unstubAllGlobals();
});

function response(status: number, body: unknown): Response {
  return { ok: status >= 200 && status < 300, status, json: async () => body } as Response;
}
function config(kind: Kind, revision: string) {
  const pages = kind === "general" ? ["state", "tasks", "artifacts", "reviews"] :
    kind === "thesis" ? ["state", "knowledge", "tasks", "artifacts", "reviews"] :
      ["state", "tasks", "runs", "connections", "reviews"];
  return { project_id: projectId, revision, kind, template_version: "1",
    template_sha256: "a".repeat(64), pages: pages.map((page_id, position) =>
      ({ page_id, visible: true, position })), updated_at: created };
}
function receipt(commandId: string, result: ReturnType<typeof config>) {
  return { command_id: commandId, command_type: "SetViewConfiguration", committed_at: created, result };
}
function client() {
  return new RelayApiClient({ baseUrl, workspaceId, bearerToken: "test-bearer-token-0123456789abcdef" });
}

describe("项目 ViewConfiguration 前端", () => {
  it("仅有 ViewConfiguration 而 Project 事实未确认时不允许新写入", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input) === `${root}${viewPath}` && (init?.method ?? "GET") === "GET")
        return response(200, config("general", "1"));
      throw new Error("Unexpected write");
    }); vi.stubGlobal("fetch", fetchMock);
    const mounted = await mountReact(createElement(ViewConfigurationPanel, { client: client(), projectId }));
    unmount = mounted.unmount;
    await flush();
    await mounted.wrapper.get('[data-testid="view-kind-select"]').setValue("thesis");
    expect(mounted.wrapper.get('[data-testid="view-archive-reason"]').text()).toContain("尚未确认");
    expect(mounted.wrapper.get('[data-testid="view-save-default"]').attributes("disabled")).toBeDefined();
    expect(fetchMock.mock.calls.filter(([, init]) => init?.method === "POST")).toHaveLength(0);
  });
  it("项目设置显示服务端模板顺序，并用独立修订显式保存默认 kind", async () => {
    let saved = config("general", "1");
    const posts: Record<string, unknown>[] = [];
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input).slice(root.length);
      if (path !== viewPath) throw new Error(`Unexpected ${path}`);
      if ((init?.method ?? "GET") === "GET") return response(200, saved);
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      posts.push(body);
      saved = config("thesis", "2");
      return response(200, receipt(String(body.command_id), saved));
    }));
    const mounted = await mountReact(createElement(ViewConfigurationPanel, { client: client(), projectId, projectArchivedAt: null }));
    unmount = mounted.unmount;
    await flush();
    expect(mounted.wrapper.text()).toContain("当前默认：通用 · 配置修订 v1");
    expect(mounted.wrapper.text()).toContain("服务端内置模板 v1");
    expect(mounted.wrapper.findAll(".view-configuration-pages li").map((row) => row.text()))
      .toEqual([expect.stringContaining("state"), expect.stringContaining("tasks"),
        expect.stringContaining("artifacts"), expect.stringContaining("reviews")]);
    await mounted.wrapper.get('[data-testid="view-kind-select"]').setValue("thesis");
    await mounted.wrapper.get('[data-testid="view-save-default"]').trigger("click");
    await flush();
    expect(posts).toHaveLength(1);
    expect(posts[0]).toEqual({ command_id: expect.any(String), expected_revision: "1", kind: "thesis" });
    expect(mounted.wrapper.text()).toContain("默认工作台已保存为论文");
    expect(mounted.wrapper.text()).toContain("当前默认：论文 · 配置修订 v2");
    expect(mounted.wrapper.findAll(".view-configuration-pages li").map((row) => row.text())[1]).toContain("knowledge");
  });

  it("409 后核对原回执，保留目标与原 ID；重新确认才使用新修订和新 ID", async () => {
    let saved = config("general", "1");
    const posts: Record<string, unknown>[] = [];
    const receipts: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input).slice(root.length);
      if (path === viewPath && (init?.method ?? "GET") === "GET") return response(200, saved);
      if (path.startsWith("/commands/")) {
        receipts.push(path.slice("/commands/".length));
        return response(404, { code: "COMMAND_NOT_FOUND", detail: "not found" });
      }
      if (path === viewPath && init?.method === "POST") {
        const body = JSON.parse(String(init.body)) as Record<string, unknown>;
        posts.push(body);
        if (posts.length === 1) {
          saved = config("thesis", "2");
          return response(409, { code: "REVISION_CONFLICT", detail: "stale",
            conflict: { expected_revision: "1", actual_revision: "2" } });
        }
        saved = config("development", "3");
        return response(200, receipt(String(body.command_id), saved));
      }
      throw new Error(`Unexpected ${path}`);
    }));
    const mounted = await mountReact(createElement(ViewConfigurationPanel, { client: client(), projectId, projectArchivedAt: null }));
    unmount = mounted.unmount;
    await flush();
    await mounted.wrapper.get('[data-testid="view-kind-select"]').setValue("development");
    await mounted.wrapper.get('[data-testid="view-save-default"]').trigger("click");
    await flush();
    expect(posts).toHaveLength(1);
    expect(receipts).toEqual([posts[0].command_id]);
    expect(mounted.wrapper.get('[data-testid="view-pending"]').text()).toContain(`原 command_id：${posts[0].command_id}`);
    expect(mounted.wrapper.get('[data-testid="view-pending"]').text()).toContain("原修订 v1 · 目标：开发");
    expect(mounted.wrapper.text()).toContain("当前默认：论文 · 配置修订 v2");
    await mounted.wrapper.findAll("button").find((button) => button.text() === "按当前修订重新确认")!.trigger("click");
    await mounted.wrapper.get('[data-testid="view-save-default"]').trigger("click");
    await flush();
    expect(posts).toHaveLength(2);
    expect(posts[1]).toMatchObject({ expected_revision: "2", kind: "development" });
    expect(posts[1].command_id).not.toBe(posts[0].command_id);
    expect(mounted.wrapper.text()).toContain("当前默认：开发 · 配置修订 v3");
  });

  it("响应丢失后查不到回执，重载仍保留原命令并原样重试", async () => {
    let saved = config("general", "1");
    let attempts = 0;
    const posts: Record<string, unknown>[] = [];
    const receipts: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input).slice(root.length);
      if (path === viewPath && (init?.method ?? "GET") === "GET") return response(200, saved);
      if (path.startsWith("/commands/")) {
        receipts.push(path.slice("/commands/".length));
        return response(404, { code: "COMMAND_NOT_FOUND", detail: "not found" });
      }
      if (path === viewPath && init?.method === "POST") {
        const body = JSON.parse(String(init.body)) as Record<string, unknown>;
        posts.push(body); attempts++;
        if (attempts === 1) throw new TypeError("connection closed");
        saved = config("thesis", "2");
        return response(200, receipt(String(body.command_id), saved));
      }
      throw new Error(`Unexpected ${path}`);
    }));
    const activeClient = client();
    let mounted = await mountReact(createElement(ViewConfigurationPanel, { client: activeClient, projectId, projectArchivedAt: null }));
    unmount = mounted.unmount;
    await flush();
    await mounted.wrapper.get('[data-testid="view-kind-select"]').setValue("thesis");
    await mounted.wrapper.get('[data-testid="view-save-default"]').trigger("click");
    await flush();
    expect(posts).toHaveLength(1);
    expect(receipts).toEqual([posts[0].command_id]);
    expect(mounted.wrapper.get('[data-testid="view-pending"]').text()).toContain("用原 ID 和内容重试");
    mounted.unmount(); unmount = null;
    mounted = await mountReact(createElement(ViewConfigurationPanel, { client: activeClient, projectId,
      projectArchivedAt: created }));
    unmount = mounted.unmount;
    await flush();
    expect(mounted.wrapper.get('[data-testid="view-archive-reason"]').text()).toContain("已归档");
    expect(mounted.wrapper.get('[data-testid="view-save-default"]').attributes("disabled")).toBeDefined();
    expect(receipts).toEqual([posts[0].command_id, posts[0].command_id]);
    expect(mounted.wrapper.get('[data-testid="view-pending"]').text()).toContain(`原 command_id：${posts[0].command_id}`);
    await mounted.wrapper.findAll("button").find((button) => button.text() === "用原 ID 和内容重试")!.trigger("click");
    await flush();
    expect(posts).toHaveLength(2);
    expect(posts[1]).toEqual(posts[0]);
    expect(mounted.wrapper.text()).toContain("当前默认：论文 · 配置修订 v2");
    expect(mounted.wrapper.find('[data-testid="view-pending"]').exists()).toBe(false);
    expect(sessionStorage.length).toBe(0);
  });

  it("项目工作台入口读取保存的 kind；浏览其他 kind 不提交命令", async () => {
    activateRelayConnection({ baseUrl, workspaceId, bearerToken: "test-bearer-token-0123456789abcdef" });
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input).slice(root.length);
      expect(init?.method ?? "GET").toBe("GET");
      if (path === viewPath) return response(200, config("thesis", "4"));
      if (path === `/projects/${projectId}`) return response(200, { id: projectId, title: "论文项目", project_type: "THESIS", revision: "1", state_revision: "1", archived_at: null });
      if (path === `/projects/${projectId}/state`) return response(200, { project_id: projectId, phase_key: "WRITING", revision: "1",
        next_action_task_id: null, selected_artifact_version_refs: [], completed_highlight_refs: [] });
      if (path === `/tasks?project_id=${projectId}`) return response(200, { items: [], next_cursor: null });
      if (path === `/knowledge?project_id=${projectId}`) return response(200, []);
      if (path === `/projects/${projectId}/connections`) return response(200, []);
      if (path === "/reviews?status=OPEN") return response(200, { items: [] });
      throw new Error(`Unexpected ${path}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    const mounted = await mountWorkbench(`/projects/${projectId}/workbench`);
    unmount = mounted.unmount;
    await flush();
    expect(mounted.router.currentRoute.value.path).toBe(`/projects/${projectId}/workbench/thesis`);
    expect(mounted.wrapper.text()).toContain("当前默认：论文 · 配置修订 v4");
    await mounted.router.push(`/projects/${projectId}/workbench/development`);
    await flush();
    expect(mounted.wrapper.text()).toContain("这只是临时浏览，尚未保存为默认视图");
    expect(fetchMock.mock.calls.every(([, init]) => (init?.method ?? "GET") === "GET")).toBe(true);
  });

  it("工作台配置默认收起，展开与收起保留已挂载配置和原待决命令", async () => {
    activateRelayConnection({ baseUrl, workspaceId, bearerToken: "test-bearer-token-0123456789abcdef" });
    const posts: Record<string, unknown>[] = [];
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input).slice(root.length);
      if (path === viewPath && init?.method === "POST") {
        posts.push(JSON.parse(String(init.body)) as Record<string, unknown>);
        throw new TypeError("connection closed");
      }
      if (path.startsWith("/commands/")) return response(404, { code: "COMMAND_NOT_FOUND", detail: "not found" });
      if (path === viewPath) return response(200, config("thesis", "4"));
      if (path === `/projects/${projectId}`) return response(200, { id: projectId, title: "通用工作台",
        project_type: "GENERAL", revision: "1", state_revision: "1", archived_at: null });
      if (path === `/projects/${projectId}/state`) return response(200, { project_id: projectId, phase_key: "PLANNING",
        revision: "1", next_action_task_id: null, selected_artifact_version_refs: [], completed_highlight_refs: [] });
      if (path === `/tasks?project_id=${projectId}`) return response(200, { items: [], next_cursor: null });
      throw new Error(`Unexpected ${path}`);
    }));
    const mounted = await mountWorkbench(`/projects/${projectId}/workbench/general`);
    unmount = mounted.unmount;
    await flush();
    const disclosure = mounted.wrapper.get('[data-testid="workbench-view-configuration"]');
    const panel = disclosure.get(".view-configuration-panel").element;
    expect((disclosure.element as HTMLDetailsElement).open).toBe(false);
    expect(disclosure.get("summary").text()).toBe("默认视图与页面配置");
    expect(disclosure.text()).toContain("当前默认：论文 · 配置修订 v4");
    expect(mounted.wrapper.get("#workbench-next").element?.closest("details")).toBeNull();
    await disclosure.get("summary").trigger("click");
    await disclosure.get('[data-testid="view-save-default"]').trigger("click");
    await flush();
    expect(posts).toHaveLength(1);
    expect(posts[0]).toMatchObject({ expected_revision: "4", kind: "general" });
    const pending = disclosure.get('[data-testid="view-pending"]').element;
    await disclosure.get("summary").trigger("click");
    await disclosure.get("summary").trigger("click");
    expect(disclosure.get(".view-configuration-panel").element).toBe(panel);
    expect(disclosure.get('[data-testid="view-pending"]').element).toBe(pending);
    expect(disclosure.get('[data-testid="view-pending"]').text()).toContain(`原 command_id：${posts[0].command_id}`);
    expect(disclosure.get('[data-testid="view-save-default"]').attributes("disabled")).toBeDefined();
    expect(posts).toHaveLength(1);
  });
});
