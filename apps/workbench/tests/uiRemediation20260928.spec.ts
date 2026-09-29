import { afterEach, describe, expect, it, vi } from "vitest";
import { activateRelayConnection, resetRelayConnectionForTest } from "../src/lib/relayConnection";
import { flush, mountWorkbench } from "./mountApp";

const baseUrl = "http://127.0.0.1:8787";
const workspaceId = "11111111-1111-4111-8111-111111111111";
const base = `${baseUrl}/api/v1/workspaces/${workspaceId}`;
let unmount: (() => void) | null = null;

function response(status: number, body: unknown): Response {
  return { ok: status >= 200 && status < 300, status, json: async () => body } as Response;
}

function task(id: string, title: string, projectId: string | null = null) {
  return { id, project_id: projectId, title, status: "READY", mode: "ME", executor: "HUMAN",
    revision: "1", waiting_reason: null, blocked_reason: null,
    created_at: "2026-09-28T00:00:00.000Z", updated_at: "2026-09-28T00:00:00.000Z" };
}

function activate(): void {
  activateRelayConnection({ baseUrl, workspaceId, bearerToken: "test-token" });
}

afterEach(() => {
  unmount?.(); unmount = null;
  resetRelayConnectionForTest();
  vi.unstubAllGlobals();
});

describe("整改 2026-09-28 UI 共享问题", () => {
  it("任务列表使用紧凑标题与筛选区，搜索框不残留行内双框补丁", async () => {
    activate();
    vi.stubGlobal("fetch", vi.fn(async (input: string) => {
      const url = String(input);
      if (url.endsWith("/attention/interventions")) return response(200, { items: [] });
      if (url === `${base}/tasks?scope=all`) return response(200, {
        items: [task("11111111-1111-4111-8111-111111111111", "首屏应可见的任务")], next_cursor: null });
      throw new Error(`unexpected ${url}`);
    }));
    const mounted = await mountWorkbench("/tasks");
    unmount = mounted.unmount;
    const header = mounted.wrapper.get(".list-header");
    expect(header.attributes("class")).toContain("list-header--compact");
    const toolbar = mounted.wrapper.get(".list-toolbar");
    expect(toolbar.attributes("class")).toContain("list-toolbar--compact");
    const search = mounted.wrapper.get('input[name="task-search"]');
    expect(search.attributes("style")).toBeUndefined();
    expect(search.element?.closest(".search-field")).not.toBeNull();
  });

  it("知识页标签为中文，新建按钮不带英文枚举前缀", async () => {
    activate();
    vi.stubGlobal("fetch", vi.fn(async (input: string) => {
      const url = String(input);
      if (url === `${base}/knowledge`) return response(200, []);
      throw new Error(`unexpected ${url}`);
    }));
    const mounted = await mountWorkbench("/knowledge");
    unmount = mounted.unmount;
    expect(mounted.wrapper.get('[data-testid="knowledge-tab-KNOWLEDGE"]').text()).toBe("资料");
    expect(mounted.wrapper.get('[data-testid="knowledge-tab-MEMORY"]').text()).toBe("记忆");
    expect(mounted.wrapper.get('[data-testid="knowledge-tab-DECISION"]').text()).toBe("决定");
    expect(mounted.wrapper.get('[data-testid="knowledge-tab-RULE"]').text()).toBe("规则");
    expect(mounted.wrapper.text()).not.toContain("Knowledge 资料");
    const create = mounted.wrapper.get('[data-testid="knowledge-create"]');
    expect(create.text()).toBe("新建");
    expect(create.attributes("class")).toContain("secondary-button");
    await create.trigger("click");
    await flush();
    expect(mounted.wrapper.get('[data-testid="knowledge-form"] h2').text()).toBe("新建资料");
  });
});
