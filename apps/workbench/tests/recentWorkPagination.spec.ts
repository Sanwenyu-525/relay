import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { createMemoryRouter, RouterProvider } from "react-router-dom";
import { afterEach, expect, it, vi } from "vitest";
import RecentWorkRail from "../src/components/RecentWorkRail";
import { RelayApiClient } from "../src/api/relayClient";

const workspaceId = "11111111-1111-4111-8111-111111111111";
const projectId = "22222222-2222-4222-8222-222222222222";
const id = (n: number) => `33333333-3333-4333-8333-${String(n).padStart(12, "0")}`;
const task = (n: number) => ({ id: id(n), title: `研究任务 ${n}`, project_id: projectId,
  status: "READY", mode: "ME", revision: "1", executor: { kind: "HUMAN", run_id: null },
  current_completion_id: null, waiting_reason: null, blocking_task_ids: [], unresolved_blocker_ids: [], allowed_actions: [],
  updated_at: `2026-10-01T00:${String(20 - n).padStart(2, "0")}:00Z` });
const json = (body: unknown, status = 200) => ({ ok: status < 400, status, json: async () => body }) as Response;
let cleanup: (() => void) | undefined;
afterEach(() => { cleanup?.(); cleanup = undefined; vi.unstubAllGlobals(); });

async function mount(secondStatus = 200) {
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
    const url = new URL(String(input));
    if (url.pathname.endsWith("/projects")) return json({ items: [{ id: projectId, title: "研究项目",
      project_type: "GENERAL", revision: "1", state_revision: "1", archived_at: null,
      archive_status: "ACTIVE", phase_key: "GENERAL", next_action_task_id: null,
      created_at: "2026-10-01T00:00:00Z", updated_at: "2026-10-01T00:00:00Z" }], next_cursor: null });
    if (url.searchParams.has("cursor")) return secondStatus === 200
      ? json({ items: [task(8), task(9), task(10)], next_cursor: null })
      : json({ code: "FORBIDDEN", message: "任务访问权已撤销" }, secondStatus);
    return json({ items: Array.from({ length: 8 }, (_, n) => task(n + 1)), next_cursor: "older-page" });
  }));
  const client = new RelayApiClient({ baseUrl: "http://127.0.0.1:8794", workspaceId, bearerToken: "test-only" });
  const router = createMemoryRouter([{ path: "*", element: createElement(RecentWorkRail, { client, currentTaskId: null }) }],
    { initialEntries: ["/projects"] });
  const container = document.createElement("div"); document.body.append(container);
  const root = createRoot(container);
  cleanup = () => { act(() => root.unmount()); container.remove(); };
  await act(async () => { root.render(createElement(RouterProvider, { router })); });
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 20)); });
  return { container, router };
}

it("更早页真实显示第9/10个任务，重复游标项不重复，分组内可定位任务", async () => {
  const { container, router } = await mount();
  expect(container.querySelectorAll(".recent-work-item")).toHaveLength(8);
  expect(container.querySelector(".recent-work-group > summary")?.textContent).toBe("研究项目");
  await act(async () => { container.querySelector<HTMLButtonElement>('[data-testid="recent-work-more"]')!.click(); });
  expect(container.querySelectorAll(".recent-work-item")).toHaveLength(10);
  expect(container.querySelector('[data-testid="recent-work-more"]')).toBeNull();
  expect(container.textContent).toContain("已加载 10 项");
  await act(async () => { container.querySelector<HTMLButtonElement>(`[data-testid="recent-work-${id(9)}"]`)!.click(); });
  expect(router.state.location.pathname).toBe("/agent");
  expect(new URLSearchParams(router.state.location.search).get("work")).toBe(id(9));
});

it("分页失权时清除已读任务，不能继续从旧列表进入", async () => {
  const { container } = await mount(403);
  await act(async () => { container.querySelector<HTMLButtonElement>('[data-testid="recent-work-more"]')!.click(); });
  expect(container.querySelectorAll(".recent-work-item")).toHaveLength(0);
  expect(container.querySelector('[data-testid="recent-work-error"]')?.textContent).toBeTruthy();
});
