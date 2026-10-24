import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { createMemoryRouter, RouterProvider } from "react-router-dom";
import { afterEach, expect, it, vi } from "vitest";
import RecentWorkRail from "../src/components/RecentWorkRail";
import { RelayApiClient } from "../src/api/relayClient";
import { clearActiveConversation, bumpActiveConversationActivity, publishActiveConversation } from "../src/lib/activeConversation";

const workspaceId = "11111111-1111-4111-8111-111111111111";
const projectId = "22222222-2222-4222-8222-222222222222";
const id = (n: number) => `33333333-3333-4333-8333-${String(n).padStart(12, "0")}`;
const task = (n: number) => ({ id: id(n), title: `研究任务 ${n}`, project_id: projectId,
  status: "READY", mode: "ME", revision: "1", executor: { kind: "HUMAN", run_id: null },
  current_completion_id: null, waiting_reason: null, blocking_task_ids: [], unresolved_blocker_ids: [], allowed_actions: [],
  updated_at: `2026-10-01T00:${String(20 - n).padStart(2, "0")}:00Z` });
const json = (body: unknown, status = 200) => ({ ok: status < 400, status, json: async () => body }) as Response;
/** 带目录与最后消息时间的自由会话；`at` 即服务端 last_message_at，是这一列的排序键。 */
const directoryRow = (n: number, at: string, resource: number, root: string) => ({ id: id(n),
  workspace_id: workspaceId, project_id: null, task_id: null, title: `目录 ${root} 的讨论`,
  status: "ACTIVE", revision: "1", conversation_mode: "AGENT", assistant_profile_id: null,
  assistant_profile_revision: null, assistant_role: null, remember: true,
  created_at: "2026-10-01T00:00:00Z", last_message_at: at, updated_at: at,
  context: { project_goals: [], working_directory: { resource_id: id(resource), canonical_root: root } } });
/** 「工作区（目录）」段的组标题顺序：分组只是全局列序的子序列，组序即列序的投影。 */
const directoryGroupTitles = (container: HTMLElement) =>
  [...container.querySelectorAll('[data-testid="recent-work-directories"] .recent-work-group > summary .recent-work-group-title')].map((node) => node.textContent);
let cleanup: (() => void) | undefined;
afterEach(() => { cleanup?.(); cleanup = undefined; clearActiveConversation(); vi.unstubAllGlobals(); vi.useRealTimers(); window.localStorage.clear(); });

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

it("行内不再常驻时间；悬停摘要卡按本地日期简写，同组同名项保留时分与完整时间", async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date(2026, 0, 1, 12));
  const entries = [
    { title: "今天的讨论", at: new Date(2026, 0, 1, 10, 9), text: "10:09" },
    { title: "昨天的讨论", at: new Date(2025, 11, 31, 20, 8), text: "昨天" },
    { title: "同名讨论", at: new Date(2025, 11, 31, 18, 9), text: "昨天 18:09" },
    { title: "同名讨论", at: new Date(2025, 11, 31, 8, 18), text: "昨天 08:18" },
    { title: "历史讨论", at: new Date(2025, 9, 11, 14, 59), text: "2025年10月11日" }
  ];
  const { container } = await mount(200, entries.map((entry, index) => ({ id: id(30 + index),
    project_id: projectId, task_id: null, title: entry.title, status: "ACTIVE", revision: "1",
    created_at: entry.at.toISOString(), updated_at: entry.at.toISOString() })));
  for (const [index, entry] of entries.entries()) {
    const row = container.querySelector<HTMLButtonElement>(`[data-testid="recent-work-${id(30 + index)}"]`)!;
    // 2026-10-16 第五轮：时间移出行内，常驻几何里不再有它，只在悬停摘要卡里出现。
    expect(row.querySelector(".recent-work-time")).toBeNull();
    expect(row.querySelector("time")).toBeNull();
    await act(async () => { row.focus(); });
    const card = row.closest("li")!.querySelector<HTMLElement>(".recent-work-summary")!;
    expect(card.querySelector(".recent-work-summary-title")?.textContent).toBe(entry.title);
    expect(card.querySelector(".recent-work-summary-time")?.textContent?.trim()).toBe(entry.text);
    expect(card.querySelector("time")?.getAttribute("datetime")).toBe(entry.at.toISOString());
    expect(card.querySelector("time")?.getAttribute("title")).toBe(entry.at.toLocaleString("zh-CN"));
    await act(async () => { row.blur(); });
    expect(row.getAttribute("aria-label")).toContain("会话 · ");
    expect(row.querySelector(".recent-work-kind")?.tagName.toLowerCase()).toBe("svg");
  }
});

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
  expect(container.querySelector('[data-testid="recent-work-tasks"] .recent-work-group .recent-work-group-title')?.textContent).toBe("研究项目");
  expect(container.querySelector(".recent-work-group-count")?.textContent).toBe("8");
  await act(async () => { container.querySelector<HTMLButtonElement>('[data-testid="recent-work-more"]')!.click(); });
  expect(container.querySelectorAll(".recent-work-item")).toHaveLength(10);
  expect(container.querySelector('[data-testid="recent-work-more"]')).toBeNull();
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

it("目录行带「＋」：只在有真实路径的分组出现，点击以该目录打开新对话且不发命令", async () => {
  const directory = "D:/thesis/docs";
  const sessions = [
    { id: id(30), project_id: projectId, task_id: null, title: "有目录的讨论", status: "ACTIVE", revision: "1",
      updated_at: "2026-10-16T00:00:00Z", context: { project_goals: [],
        working_directory: { resource_id: id(41), canonical_root: directory } } },
    { id: id(31), project_id: null, task_id: null, title: "未绑定目录的讨论", status: "ACTIVE", revision: "1",
      updated_at: "2026-10-15T00:00:00Z", context: { project_goals: [], working_directory: null } }
  ];
  const { container, router } = await mount(200, sessions);
  const button = container.querySelector<HTMLButtonElement>(`[data-testid="recent-work-new-in-${id(41)}"]`)!;
  expect(button).not.toBeNull();
  // 没有路径的两组（未绑定目录／目录待核对）没有可打开的目录，不长这颗键。
  expect(container.querySelectorAll(".recent-work-group-new")).toHaveLength(1);
  // summary 的后代不许是可交互内容：「＋」只能当它的兄弟，否则整行折叠与按钮点击会互相吞。
  expect(container.querySelector(".recent-work-group > summary .recent-work-group-new")).toBeNull();
  await act(async () => { button.click(); });
  const query = new URLSearchParams(router.state.location.search);
  expect(router.state.location.pathname).toBe("/agent");
  // 与栏头「新对话」同一语义：只带一次性种子，不提前建空会话。
  expect(query.get("new")).toBeTruthy();
  expect(query.get("dir")).toBe(directory);
  expect(vi.mocked(fetch).mock.calls.some(([, init]) => init?.method === "POST")).toBe(false);
});

it("目录入口与任务入口分开：会话行仍打开原会话身份", async () => {
  // 协作页 §3.1：左栏不再只列任务。会话行与任务行共用一个列表，但走的是 ?session=。
  const sessionId = "77777777-7777-4777-8777-777777777777";
  const { container, router } = await mount(200, [{ id: sessionId, workspace_id: workspaceId,
    project_id: null, task_id: null, title: "未归属的一段讨论", status: "ACTIVE", revision: "1",
    conversation_mode: "AGENT", assistant_profile_id: null, assistant_profile_revision: null,
    assistant_role: null, remember: true, created_at: "2026-10-01T00:00:00Z",
    updated_at: "2026-10-01T00:30:00Z" }]);
  expect(container.querySelectorAll(".recent-work-item")).toHaveLength(9);
  // 会话按目录分组；旧响应没有目录依据时显示待核对，任务仍按项目组织。
  // 行内不重复项目名，完整归属保留在可访问名称中。
  const groups = [...container.querySelectorAll(".recent-work-group > summary .recent-work-group-title")].map((node) => node.textContent);
  expect(groups).toEqual(["目录待核对", "研究项目"]);
  const row = container.querySelector<HTMLButtonElement>(`[data-testid="recent-work-${sessionId}"]`)!;
  expect(row.querySelector("svg.recent-work-kind")?.getAttribute("aria-hidden")).toBe("true");
  expect(row.querySelector(".recent-work-title")?.textContent).toBe("未归属的一段讨论");
  expect(row.getAttribute("aria-label")).toContain("会话 · 未归属的一段讨论 · 未归入项目");
  // 组标题之外，行内不再重复写一遍项目名。
  expect(row.textContent).not.toContain("未归入项目");
  // 行内不再常驻时间（2026-10-16 第五轮）：时刻与归属只在悬停摘要卡里出现。
  expect(row.querySelector(".recent-work-time")).toBeNull();
  await act(async () => { row.focus(); });
  const summary = row.closest("li")!.querySelector<HTMLElement>(".recent-work-summary")!;
  expect(summary.querySelector(".recent-work-summary-time")?.textContent).toBeTruthy();
  // 摘要卡的第二行是归属：会话取目录末段，没有目录依据时如实说明，不拿项目名冒充。
  expect(summary.querySelector(".recent-work-summary-scope")?.textContent).toContain("目录待核对");
  await act(async () => { row.blur(); });
  expect(row.closest("li")!.querySelector(".recent-work-summary")).toBeNull();
  // 任务行不带会话徽标：类型差异不靠读文字区分。
  const taskRow = container.querySelector<HTMLButtonElement>(".recent-work-item:not(:has(.recent-work-kind))")!;
  expect(taskRow.querySelector(".recent-work-kind")).toBeNull();
  await act(async () => { row.click(); });
  expect(router.state.location.pathname).toBe("/agent");
  expect(new URLSearchParams(router.state.location.search).get("session")).toBe(sessionId);
  expect(new URLSearchParams(router.state.location.search).get("work")).toBeNull();
});

it("同一 Goal 汇集两个目录的会话，两种入口都指向原会话，不把项目当作目标", async () => {
  const goalId = "88888888-8888-4888-8888-888888888888";
  const sessions = [30, 31].map((n) => ({ id: id(n), project_id: n === 30 ? projectId : id(20),
    task_id: null, title: `跨目录讨论 ${n}`, status: "ACTIVE", revision: "1",
    updated_at: "2026-10-16T00:00:00Z", working_resource_id: id(n + 10),
    context: { project_goals: [{ goal_id: goalId, title: "完成毕业论文" }],
      working_directory: { resource_id: id(n + 10), canonical_root: n === 30 ? "D:/thesis/docs" : "D:/experiment/code" } } }));
  const { container, router } = await mount(200, sessions);
  const goals = container.querySelector('[data-testid="recent-work-goals"]')!;
  const directories = container.querySelector('[data-testid="recent-work-directories"]')!;
  expect(goals.querySelectorAll(".recent-work-group")).toHaveLength(1);
  expect(goals.querySelector(".recent-work-group > summary")?.getAttribute("title")).toBe("完成毕业论文");
  expect(goals.querySelectorAll(".recent-work-item")).toHaveLength(2);
  expect(directories.querySelectorAll(".recent-work-group")).toHaveLength(2);
  expect(directories.textContent).toContain("docs");
  expect(directories.textContent).toContain("code");
  await act(async () => { goals.querySelector<HTMLButtonElement>(`[data-testid="recent-work-goal-${goalId}-${id(31)}"]`)!.click(); });
  expect(new URLSearchParams(router.state.location.search).get("session")).toBe(id(31));
  expect(new URLSearchParams(router.state.location.search).get("goal")).toBe(goalId);
  expect(new URLSearchParams(router.state.location.search).get("work")).toBeNull();
  expect(vi.mocked(fetch).mock.calls.some(([, init]) => init?.method === "POST")).toBe(false);
});

it("真实空关联、目录未绑定与目录依据缺失分别显示", async () => {
  const entries = [
    { id: id(30), context: { project_goals: [], working_directory: null } },
    { id: id(31), working_resource_id: id(41), context: { project_goals: [],
      working_directory: { resource_id: id(41), canonical_root: null } } }
  ].map((entry) => ({ project_id: null, task_id: null, title: "自由讨论", status: "ACTIVE",
    revision: "1", updated_at: "2026-10-16T00:00:00Z", ...entry }));
  const { container } = await mount(200, entries);
  expect(container.querySelector('[data-testid="recent-work-goals"]')?.textContent).toContain("暂无关联目标");
  expect(container.querySelector('[data-testid="recent-work-directories"]')?.textContent).toContain("未绑定目录");
  expect(container.querySelector('[data-testid="recent-work-directories"]')?.textContent).toContain("目录待核对");
});

it("切换会话不重排工作区分组：列序由服务端口径决定，不随当前选中项乱跳（2026-10-23 用户截图指认）", async () => {
  // 两个目录各一段讨论：beta 的最后消息更新，按服务端口径 beta 组排在 alpha 组之前。
  const alpha = directoryRow(30, "2026-10-10T00:00:00Z", 41, "D:/work/alpha");
  const beta = directoryRow(31, "2026-10-16T00:00:00Z", 42, "D:/work/beta");
  const { container } = await mount(200, [beta, alpha], alpha);
  expect(directoryGroupTitles(container)).toEqual(["beta", "alpha"]);
  // 切到较早的那段（alpha）：定向重读只为核对当前会话事实，旧实现把当前会话插到列首，
  // alpha 组于是跳到最前——分组位置随选中项乱换。列序只由服务端口径决定，切会话不改序。
  await act(async () => { publishActiveConversation({ taskId: null, sessionId: id(30) }); });
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 20)); });
  expect(directoryGroupTitles(container)).toEqual(["beta", "alpha"]);
  // 当前会话仍高亮、仍能在左栏找到（重读的本来目的不受影响）。
  expect(container.querySelector(`[data-testid="recent-work-${id(30)}"]`)?.getAttribute("aria-current")).toBe("true");
});

it("消息落地即收敛：当前会话递活动计数后立即上浮，不等整列重读（2026-10-23 用户选定「立即发生」）", async () => {
  const alpha = directoryRow(30, "2026-10-10T00:00:00Z", 41, "D:/work/alpha");
  const beta = directoryRow(31, "2026-10-16T00:00:00Z", 42, "D:/work/beta");
  // 服务端单会话详情可变：消息落地后 last_message_at 前进（insertMessage／settleGeneration）。
  const detail = { ...alpha };
  const { container } = await mount(200, [beta, alpha], detail);
  await act(async () => { publishActiveConversation({ taskId: null, sessionId: id(30) }); });
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 20)); });
  expect(directoryGroupTitles(container)).toEqual(["beta", "alpha"]);
  // 在 alpha 里落地一条消息：服务端推进 last_message_at，会话视图观察到权威投影落地，
  // 递一个活动计数。左栏只定向重读这一行就地上浮——没有重挂载、没有重读整列。
  detail.last_message_at = "2026-10-20T00:00:00Z";
  detail.updated_at = "2026-10-20T00:00:00Z";
  await act(async () => { bumpActiveConversationActivity(id(30)); });
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 20)); });
  expect(directoryGroupTitles(container)).toEqual(["alpha", "beta"]);
  expect(container.querySelector(`[data-testid="recent-work-${id(30)}"]`)?.getAttribute("aria-current")).toBe("true");
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

it("当前会话所在的工作区段仍可手动收起，换会话时才由定位重新展开", async () => {
  const sessionId = "77777777-7777-4777-8777-777777777777";
  const otherId = "77777777-7777-4777-8777-777777777778";
  const row = (idValue: string, directory: string) => ({ id: idValue, workspace_id: workspaceId,
    project_id: null, task_id: null, title: "当前讨论", status: "ACTIVE", revision: "1",
    conversation_mode: "AGENT", assistant_profile_id: null, assistant_profile_revision: null,
    assistant_role: null, remember: true, created_at: "2026-10-01T00:00:00Z",
    updated_at: "2026-10-01T00:30:00Z",
    context: { project_goals: [], working_directory: { resource_id: directory, canonical_root: `D:/work/${directory}` } } });
  const { container } = await mount(200, [row(sessionId, "41"), row(otherId, "42")], row(sessionId, "41"));
  await act(async () => { publishActiveConversation({ taskId: null, sessionId }); });
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 20)); });

  const section = container.querySelector<HTMLDetailsElement>('[data-testid="recent-work-directories"]')!;
  expect(section.open).toBe(true);
  // 缺陷本身：活动会话一定落在「工作区（目录）」里，旧的常驻强制展开会在 summary 收起的同一拍
  // 把 open 改回 true，这一段因此永远收不起来。折叠偏好必须赢过定位展开。
  await act(async () => { section.open = false; section.dispatchEvent(new Event("toggle", { bubbles: true })); });
  expect(section.open).toBe(false);
  expect(window.localStorage.getItem("relay.workbench.recentWorkCollapsedGroups")).toContain("directories");
  // 续页会再渲染一轮；收起不能靠这一轮被悄悄还原。
  await act(async () => { container.querySelector<HTMLButtonElement>('[data-testid="recent-work-more"]')!.click(); });
  expect(section.open).toBe(false);

  // 定位展开仍在：换到另一段会话时重新展开，否则人从别处进来会看不到自己在哪。
  await act(async () => { publishActiveConversation({ taskId: null, sessionId: otherId }); });
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 20)); });
  expect(section.open).toBe(true);
  expect(window.localStorage.getItem("relay.workbench.recentWorkCollapsedGroups")).not.toContain("directories");
});

it("近期工作栏支持方向键漫游：跨分组移动焦点，折叠段里的行被跳过", async () => {
  const sessionId = "77777777-7777-4777-8777-777777777777";
  const otherId = "77777777-7777-4777-8777-777777777778";
  const row = (idValue: string, directory: string) => ({ id: idValue, workspace_id: workspaceId,
    project_id: null, task_id: null, title: "当前讨论", status: "ACTIVE", revision: "1",
    conversation_mode: "AGENT", assistant_profile_id: null, assistant_profile_revision: null,
    assistant_role: null, remember: true, created_at: "2026-10-01T00:00:00Z",
    updated_at: "2026-10-01T00:30:00Z",
    context: { project_goals: [], working_directory: { resource_id: directory, canonical_root: `D:/work/${directory}` } } });
  // 两个不同目录的会话（两个分组）+ 首屏 8 条任务，段与组默认全部展开。
  const { container } = await mount(200, [row(sessionId, "alpha"), row(otherId, "beta")], row(sessionId, "alpha"));
  const rows = () => [...container.querySelectorAll<HTMLElement>(".recent-work-item")];
  const visibleRows = () => rows().filter((item) => item.closest("details:not([open])") === null);
  expect(rows()).toHaveLength(10);

  await act(async () => { rows()[0]!.focus(); });
  await act(async () => {
    rows()[0]!.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true, cancelable: true }));
  });
  // 跨分组也按可见顺序移动：落到第二条目录行（另一个目录分组）。
  expect(document.activeElement).toBe(rows()[1]);
  await act(async () => {
    rows()[1]!.dispatchEvent(new KeyboardEvent("keydown", { key: "End", bubbles: true, cancelable: true }));
  });
  expect(document.activeElement).toBe(rows().at(-1));
  // 末条向下回绕到首条：行序跨「目录 → 任务」两段，两端循环照旧成立。
  await act(async () => {
    rows().at(-1)!.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true, cancelable: true }));
  });
  expect(document.activeElement).toBe(rows()[0]);

  // 收起「工作区（目录）」段：其中两行不可聚焦，不再参与漫游。
  const section = container.querySelector<HTMLDetailsElement>('[data-testid="recent-work-directories"]')!;
  await act(async () => { section.open = false; section.dispatchEvent(new Event("toggle", { bubbles: true })); });
  expect(visibleRows()).toHaveLength(8);
  await act(async () => { visibleRows()[0]!.focus(); });
  await act(async () => {
    visibleRows()[0]!.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true, cancelable: true }));
  });
  expect(document.activeElement).toBe(visibleRows()[1]);
  // 回绕也只落在可见行里，不会钻进收起的目录段。
  await act(async () => { visibleRows().at(-1)!.focus(); });
  await act(async () => {
    visibleRows().at(-1)!.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true, cancelable: true }));
  });
  expect(document.activeElement).toBe(visibleRows()[0]);
});
