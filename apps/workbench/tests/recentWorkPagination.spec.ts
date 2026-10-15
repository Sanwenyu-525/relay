import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { createMemoryRouter, RouterProvider } from "react-router-dom";
import { afterEach, expect, it, vi } from "vitest";
import RecentWorkRail from "../src/components/RecentWorkRail";
import { RelayApiClient } from "../src/api/relayClient";
import { clearActiveConversation, publishActiveConversation } from "../src/lib/activeConversation";

const workspaceId = "11111111-1111-4111-8111-111111111111";
const projectId = "22222222-2222-4222-8222-222222222222";
const id = (n: number) => `33333333-3333-4333-8333-${String(n).padStart(12, "0")}`;
const task = (n: number) => ({ id: id(n), title: `研究任务 ${n}`, project_id: projectId,
  status: "READY", mode: "ME", revision: "1", executor: { kind: "HUMAN", run_id: null },
  current_completion_id: null, waiting_reason: null, blocking_task_ids: [], unresolved_blocker_ids: [], allowed_actions: [],
  updated_at: `2026-10-01T00:${String(20 - n).padStart(2, "0")}:00Z` });
const json = (body: unknown, status = 200) => ({ ok: status < 400, status, json: async () => body }) as Response;
let cleanup: (() => void) | undefined;
afterEach(() => { cleanup?.(); cleanup = undefined; clearActiveConversation(); vi.unstubAllGlobals(); window.localStorage.clear(); });

async function mount(secondStatus = 200, sessions: readonly unknown[] = [], sessionDetail?: Record<string, unknown>) {
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
    const url = new URL(String(input));
    if (url.pathname.endsWith("/projects")) return json({ items: [{ id: projectId, title: "研究项目",
      project_type: "GENERAL", revision: "1", state_revision: "1", archived_at: null,
      archive_status: "ACTIVE", phase_key: "GENERAL", next_action_task_id: null,
      created_at: "2026-10-01T00:00:00Z", updated_at: "2026-10-01T00:00:00Z" }], next_cursor: null });
    // 左栏自 2026-10-10 起把工作区级会话与任务并列（协作页 §3.1），因此它也会读这个端点。
    if (url.pathname.endsWith("/assist-sessions")) return json({ items: sessions });
    if (sessionDetail && url.pathname.endsWith(`/assist-sessions/${String(sessionDetail.id)}`)) return json(sessionDetail);
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

it("新会话读回近期工作并高亮，保留已加载的更早任务", async () => {
  const sessionId = "77777777-7777-4777-8777-777777777777";
  const { container } = await mount(200, [], { id: sessionId, project_id: null, task_id: null,
    title: "刚创建的讨论", status: "ACTIVE", revision: "0", conversation_mode: "AGENT",
    assistant_profile_id: null, assistant_profile_revision: null, assistant_role: null,
    remember: true, updated_at: "2026-10-13T00:00:00Z" });
  await act(async () => { container.querySelector<HTMLButtonElement>('[data-testid="recent-work-more"]')!.click(); });
  await act(async () => { publishActiveConversation({ taskId: null, sessionId }); });
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 20)); });
  expect(container.querySelectorAll(".recent-work-item")).toHaveLength(11);
  expect(container.querySelector(`[data-testid="recent-work-${id(10)}"]`)).not.toBeNull();
  const current = container.querySelector(`[data-testid="recent-work-${sessionId}"]`);
  expect(current?.textContent).toContain("刚创建的讨论");
  expect(current?.getAttribute("aria-current")).toBe("true");
});

it("更早页真实显示第9/10个任务，重复游标项不重复，分组内可定位任务", async () => {
  const { container, router } = await mount();
  expect(container.querySelectorAll(".recent-work-item")).toHaveLength(8);
  expect(container.querySelector(".recent-work-group-title")?.textContent).toBe("研究项目");
  expect(container.querySelector(".recent-work-group-count")?.textContent).toBe("8");
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

it("工作区级会话与任务同列：会话行带类型徽标，点进的是那条会话而不是某个任务", async () => {
  // 协作页 §3.1：左栏不再只列任务。会话行与任务行共用一个列表，但走的是 ?session=。
  const sessionId = "77777777-7777-4777-8777-777777777777";
  const { container, router } = await mount(200, [{ id: sessionId, workspace_id: workspaceId,
    project_id: null, task_id: null, title: "未归属的一段讨论", status: "ACTIVE", revision: "1",
    conversation_mode: "AGENT", assistant_profile_id: null, assistant_profile_revision: null,
    assistant_role: null, remember: true, created_at: "2026-10-01T00:00:00Z",
    updated_at: "2026-10-01T00:30:00Z" }]);
  expect(container.querySelectorAll(".recent-work-item")).toHaveLength(9);
  expect(container.textContent).toContain("已加载 9 项");
  // 未归属的会话落在「未归入项目」组；组标题已说明归属，行内不再重复项目名，
  // 只留「会话」徽标区分类型，完整「标题 · 项目」仍在可访问名称里。
  const groups = [...container.querySelectorAll(".recent-work-group-title")].map((node) => node.textContent);
  expect(groups).toEqual(["研究项目", "未归入项目"]);
  const row = container.querySelector<HTMLButtonElement>(`[data-testid="recent-work-${sessionId}"]`)!;
  expect(row.querySelector(".recent-work-kind")?.textContent).toBe("会话");
  expect(row.querySelector(".recent-work-title")?.textContent).toBe("未归属的一段讨论");
  expect(row.getAttribute("aria-label")).toContain("会话 · 未归属的一段讨论 · 未归入项目");
  // 组标题之外，行内不再重复写一遍项目名。
  expect(row.textContent).not.toContain("未归入项目");
  expect(row.querySelector(".recent-work-time")?.textContent).toBeTruthy();
  // 任务行不带会话徽标：类型差异不靠读文字区分。
  const taskRow = container.querySelector<HTMLButtonElement>(".recent-work-item:not(:has(.recent-work-kind))")!;
  expect(taskRow.querySelector(".recent-work-kind")).toBeNull();
  await act(async () => { row.click(); });
  expect(router.state.location.pathname).toBe("/agent");
  expect(new URLSearchParams(router.state.location.search).get("session")).toBe(sessionId);
  expect(new URLSearchParams(router.state.location.search).get("work")).toBeNull();
});

it("分组折叠状态记在本地偏好：收起后重挂载仍保持收起", async () => {
  const { container, router } = await mount();
  const group = container.querySelector<HTMLDetailsElement>(".recent-work-group")!;
  expect(group.open).toBe(true);
  // 用户点 summary 收起：details 自身切换 open，onToggle 把状态写进本地偏好。
  await act(async () => { group.open = false; group.dispatchEvent(new Event("toggle", { bubbles: true })); });
  expect(window.localStorage.getItem("relay.workbench.recentWorkCollapsedGroups")).toContain("22222222-2222-4222-8222-222222222222");
  expect(router.state.location.pathname).toBe("/projects");
});
