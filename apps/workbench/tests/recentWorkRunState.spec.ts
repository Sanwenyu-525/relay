import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { createMemoryRouter, RouterProvider } from "react-router-dom";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import RecentWorkRail from "../src/components/RecentWorkRail";
import { RelayApiClient } from "../src/api/relayClient";
import { bumpActiveConversationActivity, clearActiveConversation,
  publishActiveConversation } from "../src/lib/activeConversation";

/**
 * 左栏会话行的状态图标（2026-10-30，在 2026-10-28 运行指示上扩展）。
 *
 * 这里守的是**判定、文案与节拍**，不是像素：
 * 1. 八种状态各有自己的图形，全部来自服务端读时派生的 `list_state`——本地不拿发送按钮、
 *    `has_messages`、最后消息时刻猜一个状态；`null` 不是完成，而是「读不出来」，回退类型图标。
 * 2. 排队 → 运行 → 完成／失败／取消 的每一次翻转都跟着服务端走，终态当拍换图形。
 * 3. 切到别的会话后原会话继续显示运行；切回来也不因为「定向重读那一行」被清掉。
 * 4. 同一会话同时出现在目标组与目录组时，两处状态一致（同一份会话对象）。
 * 5. 旧服务端只有 `run_state` 时按它兜底；两个字段都没有时回退类型图标，不编状态。
 * 6. 读取失败保留上一次读到的状态：既不假装跑完，也不假装在跑。
 * 7. 没有在跑的时候一个请求都不多打——轮询只在在途期间存在。
 * 8. 未读、勾选、置顶是独立维度：同时成立时状态类与文案都还在，谁也不盖掉谁。
 * 9. 归档行在归档段里读成 ARCHIVED；空会话读成 NOT_STARTED，标签里只出现一次「未开始」。
 *
 * 三圆点的相位、完成态只播一次、行高与标题宽不变，都是 CSS 与布局事实，
 * 归 tests/browser/recentWorkRunState.spec.ts（jsdom 不做布局也不解析样式表）。
 */

const workspaceId = "11111111-1111-4111-8111-111111111111";
const goalId = "44444444-4444-4444-8444-444444444441";
const id = (n: number) => `55555555-5555-4555-8555-${String(n).padStart(12, "0")}`;

type RunState = "RUNNING" | "PENDING" | null;
type ListState = "RUNNING" | "PENDING" | "WAITING_APPROVAL" | "COMPLETED" | "FAILED"
  | "CANCELLED" | "NOT_STARTED" | "ARCHIVED" | null;

interface SessionRow {
  id: string;
  project_id: string | null;
  task_id: string | null;
  title: string;
  status: string;
  revision: string;
  pinned_at: string | null;
  unread_at: string | null;
  last_message_at: string | null;
  has_messages: boolean;
  run_state: RunState;
  list_state: ListState;
  created_at: string;
  updated_at: string;
  context?: { project_goals: readonly { goal_id: string; title: string }[];
    working_directory: null };
}

const inFlight = (state: ListState): RunState =>
  state === "RUNNING" || state === "PENDING" ? state : null;

/**
 * 一行会话。`list_state` 与 `run_state` 由同一个入参推出——服务端的 `run_state` 本来就是
 * `list_state` 的在途子集，夹具里也不该出现两者互相矛盾的组合。
 */
const session = (n: number, title: string, state: ListState,
  goals: readonly { goal_id: string; title: string }[] = [],
  extra: Partial<SessionRow> = {}): SessionRow => ({
  id: id(n), project_id: null, task_id: null, title, status: "ACTIVE", revision: "1",
  pinned_at: null, unread_at: null, last_message_at: `2026-10-2${n}T10:00:00Z`,
  has_messages: true, run_state: inFlight(state), list_state: state,
  created_at: `2026-10-2${n}T09:00:00Z`, updated_at: `2026-10-2${n}T10:00:00Z`,
  context: { project_goals: goals, working_directory: null },
  ...extra
});

const json = (body: unknown, status = 200) =>
  ({ ok: status < 400, status, json: async () => body }) as Response;

/** 假服务端：会话列表与单条读取都按同一份内存行返回，便于在用例中途翻状态。 */
function fakeServer(rows: SessionRow[]) {
  const state = { rows, listCalls: 0, singleCalls: 0, failing: false };
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
    const url = new URL(String(input));
    const path = url.pathname;
    if (path.endsWith("/assist-sessions")) {
      state.listCalls += 1;
      if (state.failing) return json({ code: "INTERNAL", message: "服务端暂时不可用" }, 503);
      const status = url.searchParams.get("status") ?? "ACTIVE";
      return json({ items: state.rows.filter((row) => status === "ALL" || row.status === status) });
    }
    const single = /\/assist-sessions\/([^/]+)$/u.exec(path);
    if (single !== null) {
      state.singleCalls += 1;
      const row = state.rows.find((item) => item.id === single[1]);
      return row === undefined ? json({ code: "RESOURCE_NOT_FOUND" }, 404) : json(row);
    }
    return json({ items: [], next_cursor: null });
  }));
  return state;
}

let cleanup: (() => void) | undefined;

beforeEach(() => {
  window.localStorage.clear();
  document.documentElement.dataset.motion = "on";
});

afterEach(() => {
  cleanup?.(); cleanup = undefined;
  clearActiveConversation();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  window.localStorage.clear();
  // 「页面不可见」那条用 defineProperty 顶掉了 jsdom 的 getter，这里必须摘掉：
  // 留着会让本文件后续用例跑在一个假的可见性下（真实浏览器里没有这一层）。
  Reflect.deleteProperty(document, "visibilityState");
});

async function mount(options: { fakeTimers?: boolean } = {}) {
  const { fakeTimers = false } = options;
  if (fakeTimers) vi.useFakeTimers();
  const client = new RelayApiClient({ baseUrl: "http://127.0.0.1:8795", workspaceId,
    bearerToken: "test-only" });
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  cleanup = () => { act(() => root.unmount()); container.remove(); };
  /** 换一条连接（重连/切换 API）：左栏按新的 client 重读整列，与真实重连同一条路径。 */
  const reconnect = async (next: RelayApiClient) => {
    const router = createMemoryRouter(
      [{ path: "*", element: createElement(RecentWorkRail, { client: next, currentTaskId: null }) }],
      { initialEntries: ["/projects"] });
    await act(async () => {
      root.render(createElement(RouterProvider, { router }));
      if (fakeTimers) await vi.advanceTimersByTimeAsync(30);
      else await new Promise((resolve) => setTimeout(resolve, 20));
    });
  };
  await reconnect(client);
  return { container, reconnect };
}

/** 推进一拍轮询（默认 3s）。轮询里的 fetch 是微任务，`advanceTimersByTimeAsync` 会等它落定。 */
async function tick(ms = 3000) {
  await act(async () => { await vi.advanceTimersByTimeAsync(ms); });
}

const rowOf = (container: HTMLElement, sessionId: string, goal?: string) =>
  container.querySelector<HTMLElement>(`[data-testid="recent-work-${goal === undefined ? "" : `goal-${goal}-`}${sessionId}"]`)
    ?.closest<HTMLElement>(".recent-work-row") ?? null;

const markOf = (container: HTMLElement, sessionId: string, goal?: string) =>
  rowOf(container, sessionId, goal)
    ?.querySelector<SVGElement>('[data-testid="recent-work-state"]') ?? null;

const markState = (container: HTMLElement, sessionId: string, goal?: string) =>
  markOf(container, sessionId, goal)?.dataset.state ?? null;

const labelOf = (container: HTMLElement, sessionId: string, goal?: string) =>
  rowOf(container, sessionId, goal)?.querySelector(".recent-work-item")?.getAttribute("aria-label") ?? "";

/** 没有可判定状态时才回退到类型图标：还是那枚 MessageSquare，但不带 `data-state`。 */
const hasTypeIcon = (container: HTMLElement, sessionId: string) =>
  markOf(container, sessionId)?.dataset.state === undefined
  && rowOf(container, sessionId)?.querySelector(".lucide-message-square") !== null;

it("八种状态各画各的图形：状态类、可访问名称与悬停提示都跟着服务端走", async () => {
  fakeServer([
    session(1, "正在写的讨论", "RUNNING"),
    session(2, "排队中的讨论", "PENDING"),
    session(3, "等你确认的讨论", "WAITING_APPROVAL"),
    session(4, "已经写完的讨论", "COMPLETED"),
    session(5, "失败的一轮", "FAILED"),
    session(6, "被取消的一轮", "CANCELLED"),
    session(7, "还没开始的讨论", "NOT_STARTED", [], { has_messages: false, last_message_at: null })
  ]);
  const { container } = await mount();

  const expected: readonly [number, string, string, string][] = [
    [1, "RUNNING", "running", "正在生成"],
    [2, "PENDING", "pending", "排队中"],
    [3, "WAITING_APPROVAL", "waiting-approval", "等待确认提案"],
    [4, "COMPLETED", "completed", "已完成"],
    [5, "FAILED", "failed", "生成失败"],
    [6, "CANCELLED", "cancelled", "已取消"],
    [7, "NOT_STARTED", "not-started", "未开始"]
  ];
  for (const [n, state, className, note] of expected) {
    expect(markState(container, id(n))).toBe(state);
    expect(markOf(container, id(n))?.classList.contains(`recent-work-kind--${className}`)).toBe(true);
    // 文案只写一次：行标签里出现状态词，图标里带同一句话的悬停提示。
    expect(labelOf(container, id(n))).toContain(note);
    expect(markOf(container, id(n))?.querySelector("title")?.textContent ?? "").not.toBe("");
  }

  // 三种终态与两种在途的图形两两不同：不靠颜色、也不靠「有没有在动」区分。
  const shapes = [1, 2, 3, 4, 5, 6, 7].map((n) => markOf(container, id(n))?.innerHTML ?? "");
  expect(new Set(shapes).size).toBe(shapes.length);

  // 空会话只有一次「未开始」：图标与标签各说一次，不重复成「未开始 · 未开始」。
  expect(labelOf(container, id(7)).match(/未开始/gu)).toHaveLength(1);
});

it("排队 → 运行 → 完成：每一次翻转都跟服务端走，终态当拍换图形", async () => {
  const server = fakeServer([session(1, "一条正在跑的讨论", "PENDING")]);
  const { container } = await mount({ fakeTimers: true });
  expect(markState(container, id(1))).toBe("PENDING");

  // 排队 → 运行：Worker 认领之后服务端读到 RUNNING。
  server.rows[0]!.list_state = "RUNNING";
  server.rows[0]!.run_state = "RUNNING";
  await tick();
  expect(markState(container, id(1))).toBe("RUNNING");

  // 运行 → 完成：服务端结算后给出最后一轮的终态，图形当拍换成圆勾。
  server.rows[0]!.list_state = "COMPLETED";
  server.rows[0]!.run_state = null;
  await tick();
  expect(markState(container, id(1))).toBe("COMPLETED");
  expect(labelOf(container, id(1))).toContain("已完成");
});

it("运行 → 失败、运行 → 取消同样当拍收敛；下一轮由消息落地信号重新点亮，不靠轮询自己发现", async () => {
  const failed = fakeServer([session(1, "一条会失败的讨论", "RUNNING")]);
  const first = await mount({ fakeTimers: true });
  await act(async () => { publishActiveConversation({ taskId: null, sessionId: id(1) }); });
  expect(markState(first.container, id(1))).toBe("RUNNING");

  failed.rows[0]!.list_state = "FAILED";
  failed.rows[0]!.run_state = null;
  await tick();
  expect(markState(first.container, id(1))).toBe("FAILED");
  expect(labelOf(first.container, id(1))).toContain("生成失败");

  // 下一轮开始时，左栏不是靠轮询自己发现的——没有在跑就不轮询。
  // 真实链路是这一轮的用户消息落库 → 协作页递 `activityEpoch` → 左栏定向重读这一行。
  failed.rows[0]!.list_state = "RUNNING";
  failed.rows[0]!.run_state = "RUNNING";
  const quiet = failed.listCalls;
  await tick(9000);
  expect(markState(first.container, id(1))).toBe("FAILED");
  expect(failed.listCalls).toBe(quiet);

  await act(async () => { bumpActiveConversationActivity(id(1)); });
  expect(markState(first.container, id(1))).toBe("RUNNING");

  // 取消同样是终态：斜线圆当拍替换掉三个点。
  failed.rows[0]!.list_state = "CANCELLED";
  failed.rows[0]!.run_state = null;
  await tick();
  expect(markState(first.container, id(1))).toBe("CANCELLED");
});

it("一列里多条会话同时运行、一条排队、一条已完成：各画各的，互不串", async () => {
  const server = fakeServer([
    session(1, "第一条在跑", "RUNNING"),
    session(2, "第二条在跑", "RUNNING"),
    session(3, "这条在排队", "PENDING"),
    session(4, "这条早跑完了", "COMPLETED")
  ]);
  const { container } = await mount({ fakeTimers: true });

  expect([1, 2, 3, 4].map((n) => markState(container, id(n))))
    .toEqual(["RUNNING", "RUNNING", "PENDING", "COMPLETED"]);

  // 只有第一条结算：其余三条原样，不能因为一次读取把整列刷成同一态。
  server.rows[0]!.list_state = "COMPLETED";
  server.rows[0]!.run_state = null;
  await tick();
  expect([1, 2, 3, 4].map((n) => markState(container, id(n))))
    .toEqual(["COMPLETED", "RUNNING", "PENDING", "COMPLETED"]);
});

it("切到别的会话，原会话仍在执行时继续显示；切回来也不会被这次重读清掉", async () => {
  const server = fakeServer([session(1, "后台还在跑的讨论", "RUNNING"),
    session(2, "正在看的讨论", "COMPLETED")]);
  const { container } = await mount({ fakeTimers: true });
  expect(markState(container, id(1))).toBe("RUNNING");

  // 切到第二条：左栏只会定向重读这一条，原会话的运行态来自随后那一拍轮询。
  await act(async () => { publishActiveConversation({ taskId: null, sessionId: id(2) }); });
  expect(server.singleCalls).toBeGreaterThan(0);
  await tick();
  expect(markState(container, id(1))).toBe("RUNNING");

  // 原会话在后台结束：切走之后仍然能及时收到终态。
  server.rows[0]!.list_state = "FAILED";
  server.rows[0]!.run_state = null;
  await tick();
  expect(markState(container, id(1))).toBe("FAILED");

  // 再切回来：单条读取带同一枚状态，不会因为「重读了这一行」把图标清掉。
  server.rows[0]!.list_state = "RUNNING";
  server.rows[0]!.run_state = "RUNNING";
  await tick();
  await act(async () => { publishActiveConversation({ taskId: null, sessionId: id(1) }); });
  expect(markState(container, id(1))).toBe("RUNNING");
});

it("同一会话同时出现在目标组与目录组时，两处状态一致", async () => {
  const goal = { goal_id: goalId, title: "把左栏读顺" };
  const server = fakeServer([session(1, "带目标的讨论", "RUNNING", [goal])]);
  const { container } = await mount({ fakeTimers: true });

  // 两处都渲染出来了，且都读到同一枚状态（同一份会话对象，不是两份副本）。
  expect(rowOf(container, id(1))).not.toBeNull();
  expect(rowOf(container, id(1), goalId)).not.toBeNull();
  expect(markState(container, id(1))).toBe("RUNNING");
  expect(markState(container, id(1), goalId)).toBe("RUNNING");

  server.rows[0]!.list_state = "COMPLETED";
  server.rows[0]!.run_state = null;
  await tick();
  expect(markState(container, id(1))).toBe("COMPLETED");
  expect(markState(container, id(1), goalId)).toBe("COMPLETED");
});

it("读取失败保留上一次读到的状态，不伪造完成也不伪造在跑", async () => {
  const server = fakeServer([session(1, "跑到一半的讨论", "RUNNING")]);
  const { container } = await mount({ fakeTimers: true });
  expect(markState(container, id(1))).toBe("RUNNING");

  // 轮询读失败：这一行仍是「正在生成」——服务端没说结束，界面就不替它说结束。
  server.failing = true;
  await tick();
  expect(markState(container, id(1))).toBe("RUNNING");
  // 失败之后按退避继续尝试，不会因为一次 503 就停止观察。
  const callsAfterFailure = server.listCalls;
  await tick(6000);
  expect(server.listCalls).toBeGreaterThan(callsAfterFailure);

  // 恢复读取并给出终态：下一拍就收敛。
  server.failing = false;
  server.rows[0]!.list_state = "COMPLETED";
  server.rows[0]!.run_state = null;
  await tick(30_000);
  expect(markState(container, id(1))).toBe("COMPLETED");
});

it("没有在跑的时候一个请求都不多打；页面不可见时也不打", async () => {
  const idle = fakeServer([session(1, "安静的讨论", "COMPLETED")]);
  const { container } = await mount({ fakeTimers: true });
  const afterLoad = idle.listCalls;
  await tick(30_000);
  expect(markState(container, id(1))).toBe("COMPLETED");
  expect(idle.listCalls).toBe(afterLoad);

  cleanup?.(); cleanup = undefined;
  vi.useRealTimers();
  vi.unstubAllGlobals();

  // 有在途时才轮询；页面在后台只留计时、不发请求，切回可见那一拍立刻补一次。
  const busy = fakeServer([session(1, "跑着的讨论", "RUNNING")]);
  const mounted = await mount({ fakeTimers: true });
  const beforeHidden = busy.listCalls;
  Object.defineProperty(document, "visibilityState", { configurable: true, get: () => "hidden" });
  await tick(3000);
  expect(busy.listCalls).toBe(beforeHidden);
  Object.defineProperty(document, "visibilityState", { configurable: true, get: () => "visible" });
  await act(async () => { document.dispatchEvent(new Event("visibilitychange"));
    await vi.advanceTimersByTimeAsync(10); });
  expect(busy.listCalls).toBeGreaterThan(beforeHidden);
  expect(markState(mounted.container, id(1))).toBe("RUNNING");
});

it("重连后换的新连接读到终态时，图标立刻收敛，旧连接留下的轮询也不再继续", async () => {
  const first = fakeServer([session(1, "连上时还在跑的讨论", "RUNNING")]);
  const { container, reconnect } = await mount({ fakeTimers: true });
  expect(markState(container, id(1))).toBe("RUNNING");
  const firstCalls = first.listCalls;

  // 换一条连接：新服务端此刻已经结算（这一轮在断线期间跑完了）。
  const second = fakeServer([session(1, "连上时已经跑完的讨论", "FAILED")]);
  const client = new RelayApiClient({ baseUrl: "http://127.0.0.1:8796", workspaceId,
    bearerToken: "test-only-reconnected" });
  await reconnect(client);

  expect(markState(container, id(1))).toBe("FAILED");
  // 没有在途行就不该再有轮询：两条连接都不再被按节拍敲。
  const secondCalls = second.listCalls;
  await tick(30_000);
  expect(second.listCalls).toBe(secondCalls);
  expect(first.listCalls).toBe(firstCalls);
});

it("旧服务端没有 list_state：有 run_state 时按它兜底，两个字段都没有时回退类型图标", async () => {
  const server = fakeServer([session(1, "只有运行态的旧服务端", "RUNNING"),
    session(2, "什么状态都没有的旧服务端", null)]);
  // 模拟旧响应：字段整个不存在，而不是显式 null。
  for (const row of server.rows) {
    delete (row as { list_state?: ListState }).list_state;
  }
  const { container } = await mount({ fakeTimers: true });

  expect(markState(container, id(1))).toBe("RUNNING");
  // 读不出来的那一行不编状态：类型图标在，标签里没有任何状态词。
  expect(hasTypeIcon(container, id(2))).toBe(true);
  expect(labelOf(container, id(2))).not.toContain("已完成");
  expect(labelOf(container, id(2))).not.toContain("未开始");
  // 图标本该没有悬停提示：它没有在陈述任何状态。
  expect(markOf(container, id(2))?.querySelector("title")).toBeNull();
});

it("未读、勾选与置顶是独立维度：同时成立时状态图形与文案都不被覆盖", async () => {
  fakeServer([session(1, "一条失败且未读置顶的讨论", "FAILED", [], {
    unread_at: "2026-10-21T10:05:00Z", pinned_at: "2026-10-21T10:06:00Z" })]);
  const { container } = await mount({ fakeTimers: true });

  const row = rowOf(container, id(1))!;
  // 未读圆点与置顶徽标都在，状态类也还在——三个维度各自成立。
  expect(row.querySelector('[data-testid="recent-work-unread-dot"]')).not.toBeNull();
  expect(row.querySelector(".recent-work-pin")).not.toBeNull();
  expect(markOf(container, id(1))?.classList.contains("recent-work-kind--failed")).toBe(true);
  expect(labelOf(container, id(1))).toContain("生成失败");
  expect(labelOf(container, id(1))).toContain("未读");
  // 未读不再把状态色刷成中性档：样式表把提亮限定在「没有 data-state」的类型图标上。
  expect(markOf(container, id(1))?.getAttribute("data-state")).toBe("FAILED");

  // 勾选只改行的批量选择态，不碰状态。
  const checkbox = row.querySelector<HTMLInputElement>(".recent-work-select")!;
  await act(async () => { checkbox.click(); });
  expect(rowOf(container, id(1))?.getAttribute("data-selected")).toBe("true");
  expect(markState(container, id(1))).toBe("FAILED");
});

it("归档行读成 ARCHIVED：在归档段里画归档盒，不是完成对勾", async () => {
  const server = fakeServer([
    session(1, "留在活跃列表里的讨论", "COMPLETED"),
    session(2, "早就归档的讨论", "ARCHIVED", [], { status: "ARCHIVED" })
  ]);
  const { container } = await mount({ fakeTimers: true });
  const section = container.querySelector<HTMLDetailsElement>('[data-testid="recent-work-archived"]')!;
  expect(section).not.toBeNull();

  await act(async () => {
    section.open = true;
    section.dispatchEvent(new Event("toggle", { bubbles: true }));
    await vi.advanceTimersByTimeAsync(30);
  });

  // 归档段按需读取走的是同一条列表端点，状态由服务端同一套派生给出。
  expect(server.listCalls).toBeGreaterThan(1);
  expect(markState(container, id(2))).toBe("ARCHIVED");
  expect(labelOf(container, id(2))).toContain("已归档");
});
