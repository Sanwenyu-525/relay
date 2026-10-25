import { act, createElement } from "react";
import { describe, expect, it, vi } from "vitest";
import { RelayApiError, type RelayApiClient, type RelayTaskSummary } from "../src/api/relayClient";
import { useProjectTaskPages } from "../src/lib/useProjectTaskPages";
import { flush, mountReact } from "./mountApp";

function task(id: string) { return { id } as RelayTaskSummary; }
function harness(client: RelayApiClient, projectId = "p1", scope = "w1") {
  function Harness() {
    const page = useProjectTaskPages(client, projectId, true, scope, 50);
    return createElement("section", null,
      createElement("output", { "data-testid": "items" }, page.items.map((item) => item.id).join(",")),
      createElement("output", { "data-testid": "cursor" }, page.nextCursor ?? "END"),
      createElement("output", { "data-testid": "error" }, page.error ?? ""),
      createElement("button", { type: "button", onClick: page.loadMore }, "加载更多"),
      createElement("button", { type: "button", onClick: page.retry }, "重试"));
  }
  return createElement(Harness);
}
function button(name: string) {
  return Array.from(document.querySelectorAll("button")).find((item) => item.textContent === name)!;
}
function client(read: (projectId: string, cursor: string | null) => Promise<unknown>, workspaceId = "w1") {
  const mock = { workspaceId, baseUrl: "http://relay.test",
    getProjectTasksPage: vi.fn((projectId: string, cursor: string | null) => read(projectId, cursor)) }
  return mock as unknown as RelayApiClient;
}

describe("项目任务游标页 Hook", () => {
  it("按用户请求逐页加载 120 项并按任务 ID 去重", async () => {
    const read = vi.fn(async (_projectId: string, cursor: string | null) => {
      if (cursor === null) return { items: Array.from({ length: 50 }, (_, index) => task(`t${index}`)), nextCursor: "c1" };
      if (cursor === "c1") return { items: Array.from({ length: 50 }, (_, index) => task(`t${index + 49}`)), nextCursor: "c2" };
      return { items: Array.from({ length: 22 }, (_, index) => task(`t${index + 98}`)), nextCursor: null };
    });
    const view = await mountReact(harness(client(read)));
    try {
      await flush();
      expect(view.wrapper.get('[data-testid="items"]').text()).toContain("t0");
      await act(async () => { button("加载更多").click(); }); await flush();
      await act(async () => { button("加载更多").click(); }); await flush();
      const ids = view.wrapper.get('[data-testid="items"]').text().split(",");
      expect(ids).toHaveLength(120);
      expect(new Set(ids).size).toBe(120);
      expect(ids.at(-1)).toBe("t119");
      expect(read.mock.calls.map((call) => call[1])).toEqual([null, "c1", "c2"]);
    } finally { view.unmount(); }
  });

  it("续页临时失败保留已加载结果和原游标，重试仍请求同一游标", async () => {
    let fail = true;
    const read = vi.fn(async (_projectId: string, cursor: string | null) => {
      if (cursor === null) return { items: [task("t1")], nextCursor: "same-cursor" };
      if (fail) { fail = false; throw new Error("temporary network failure"); }
      return { items: [task("t2")], nextCursor: null };
    });
    const view = await mountReact(harness(client(read)));
    try {
      await flush();
      await act(async () => { button("加载更多").click(); }); await flush();
      expect(view.wrapper.get('[data-testid="items"]').text()).toBe("t1");
      expect(view.wrapper.get('[data-testid="cursor"]').text()).toBe("same-cursor");
      expect(view.wrapper.get('[data-testid="error"]').text()).toContain("temporary network failure");
      await act(async () => { button("重试").click(); }); await flush();
      expect(read.mock.calls.map((call) => call[1])).toEqual([null, "same-cursor", "same-cursor"]);
      expect(view.wrapper.get('[data-testid="items"]').text()).toBe("t1,t2");
      expect(view.wrapper.get('[data-testid="cursor"]').text()).toBe("END");
    } finally { view.unmount(); }
  });

  it.each([401, 403, 404])("续页收到 %i 时清除之前已读的任务", async (status) => {
    const read = vi.fn(async (_projectId: string, cursor: string | null) => {
      if (cursor === null) return { items: [task("private-task")], nextCursor: "c1" };
      throw new RelayApiError({ status, code: "FORBIDDEN", detail: "access removed", retryable: false,
        retryAction: null, fieldErrors: [], expectedRevision: null, actualRevision: null });
    });
    const view = await mountReact(harness(client(read)));
    try {
      await flush();
      expect(view.wrapper.get('[data-testid="items"]').text()).toBe("private-task");
      await act(async () => { button("加载更多").click(); }); await flush();
      expect(view.wrapper.get('[data-testid="items"]').text()).toBe("");
      expect(view.wrapper.get('[data-testid="cursor"]').text()).toBe("END");
      expect(view.wrapper.get('[data-testid="error"]').text()).toContain("access removed");
    } finally { view.unmount(); }
  });

  it("切换项目后丢弃旧项目迟到的页响应", async () => {
    let resolveOld: ((value: unknown) => void) | undefined;
    const oldClient = client(() => new Promise((resolve) => { resolveOld = resolve; }));
    const newClient = client(async () => ({ items: [task("new-project-task")], nextCursor: null }));
    const view = await mountReact(harness(oldClient, "old-project"));
    try {
      await view.rerender(harness(newClient, "new-project")); await flush();
      expect(view.wrapper.get('[data-testid="items"]').text()).toBe("new-project-task");
      await act(async () => { resolveOld?.({ items: [task("late-old-task")], nextCursor: null }); }); await flush();
      expect(view.wrapper.get('[data-testid="items"]').text()).toBe("new-project-task");
    } finally { view.unmount(); }
  });

  it("切换连接和 Workspace 后丢弃同一项目的旧连接迟到响应", async () => {
    let resolveOld: ((value: unknown) => void) | undefined;
    const oldClient = client(() => new Promise((resolve) => { resolveOld = resolve; }), "w1");
    const newClient = client(async () => ({ items: [task("new-workspace-task")], nextCursor: null }), "w2");
    const view = await mountReact(harness(oldClient, "same-project", "connection-1"));
    try {
      await view.rerender(harness(newClient, "same-project", "connection-2")); await flush();
      expect(view.wrapper.get('[data-testid="items"]').text()).toBe("new-workspace-task");
      await act(async () => { resolveOld?.({ items: [task("late-old-workspace-task")], nextCursor: null }); }); await flush();
      expect(view.wrapper.get('[data-testid="items"]').text()).toBe("new-workspace-task");
    } finally { view.unmount(); }
  });
});
