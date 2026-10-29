import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { createMemoryRouter, RouterProvider } from "react-router-dom";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import RecentWorkRail from "../src/components/RecentWorkRail";
import { RelayApiClient } from "../src/api/relayClient";
import { bumpActiveConversationActivity, clearActiveConversation,
  publishActiveConversation } from "../src/lib/activeConversation";

/**
 * 左栏「这条会话正在生成回复」的运行指示（2026-10-28 用户指令）。
 *
 * 这里守的是**判定与节拍**，不是像素：
 * 1. 只有服务端读时派生的 `run_state` 能让这一行换成运行指示——`RUNNING` 转环、
 *    `PENDING` 点线环、`null` 回到普通类型图标。本地不拿发送按钮、`hasMessages`、
 *    最后消息时刻猜一个运行态。
 * 2. 排队 → 运行 → 完成／失败／取消 的每一次翻转都跟着服务端走，终态当拍就回图标。
 * 3. 切到别的会话后原会话继续转；切回来也不因为「定向重读那一行」被清掉。
 * 4. 同一会话同时出现在目标组与目录组时，两处状态一致（同一份会话对象）。
 * 5. 读取失败保留上一次读到的运行态：既不假装跑完，也不假装在跑。
 * 6. 没有在跑的时候一个请求都不多打——轮询只在在途期间存在。
 *
 * 环的旋转、悬停时复选框盖住这一格、行高与标题宽不变，都是 CSS 与布局事实，
 * 归 tests/browser/recentWorkRunState.spec.ts（jsdom 不做布局也不解析样式表）。
 */

const workspaceId = "11111111-1111-4111-8111-111111111111";
const goalId = "44444444-4444-4444-8444-444444444441";
const id = (n: number) => `55555555-5555-4555-8555-${String(n).padStart(12, "0")}`;

type RunState = "RUNNING" | "PENDING" | null;

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
  created_at: string;
  updated_at: string;
  context?: { project_goals: readonly { goal_id: string; title: string }[];
    working_directory: null };
}

const session = (n: number, title: string, runState: RunState,
  goals: readonly { goal_id: string; title: string }[] = []): SessionRow => ({
  id: id(n), project_id: null, task_id: null, title, status: "ACTIVE", revision: "1",
  pinned_at: null, unread_at: null, last_message_at: `2026-10-2${n}T10:00:00Z`,
  has_messages: true, run_state: runState,
  created_at: `2026-10-2${n}T09:00:00Z`, updated_at: `2026-10-2${n}T10:00:00Z`,
  context: { project_goals: goals, working_directory: null }
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
  rowOf(container, sessionId, goal)?.querySelector<SVGElement>('[data-testid="recent-work-run-state"]') ?? null;

const markState = (container: HTMLElement, sessionId: string, goal?: string) =>
  markOf(container, sessionId, goal)?.dataset.runState ?? null;

/** 普通类型图标：没有运行指示时消息方块在，且不带运行态标记。 */
const hasTypeIcon = (container: HTMLElement, sessionId: string) =>
  rowOf(container, sessionId)?.querySelector(".recent-work-kind:not([data-testid])") !== null
  && rowOf(container, sessionId)?.querySelector(".lucide-message-square") !== null;

it("只有服务端给出 run_state 的会话换运行指示：RUNNING 转环、PENDING 点线环、其余回类型图标", async () => {
  fakeServer([
    session(1, "正在写的讨论", "RUNNING"),
    session(2, "排队中的讨论", "PENDING"),
    session(3, "已经写完的讨论", null)
  ]);
  const { container } = await mount();

  expect(markState(container, id(1))).toBe("RUNNING");
  expect(markOf(container, id(1))?.classList.contains("recent-work-kind--running")).toBe(true);
  expect(markState(container, id(2))).toBe("PENDING");
  expect(markOf(container, id(2))?.classList.contains("recent-work-kind--pending")).toBe(true);
  // 终态那一行没有运行指示，只有原来的类型图标。
  expect(markOf(container, id(3))).toBeNull();
  expect(hasTypeIcon(container, id(3))).toBe(true);

  // 两种状态的图形不一样：弧 vs 点线。不靠颜色，也不靠「有没有在转」。
  const running = markOf(container, id(1))?.querySelector("circle")?.getAttribute("stroke-dasharray");
  const pending = markOf(container, id(2))?.querySelector("circle")?.getAttribute("stroke-dasharray");
  expect(running).toBeTruthy();
  expect(pending).toBeTruthy();
  expect(running).not.toBe(pending);

  // 状态同时进可访问名称：读屏与键盘用户读到的是同一件事，不只看到一枚转着的环。
  expect(rowOf(container, id(1))?.querySelector(".recent-work-item")?.getAttribute("aria-label"))
    .toContain("正在生成");
  expect(rowOf(container, id(2))?.querySelector(".recent-work-item")?.getAttribute("aria-label"))
    .toContain("排队中");
  expect(rowOf(container, id(3))?.querySelector(".recent-work-item")?.getAttribute("aria-label"))
    .not.toContain("生成");
});

it("排队 → 运行 → 完成：每一次翻转都跟服务端走，终态当拍回到类型图标", async () => {
  const server = fakeServer([session(1, "一条正在跑的讨论", "PENDING")]);
  const { container } = await mount({ fakeTimers: true });
  expect(markState(container, id(1))).toBe("PENDING");

  // 排队 → 运行：Worker 认领之后服务端读到 RUNNING。
  server.rows[0]!.run_state = "RUNNING";
  await tick();
  expect(markState(container, id(1))).toBe("RUNNING");

  // 运行 → 完成：服务端结算后没有在途行，运行指示当拍消失，不留残影。
  server.rows[0]!.run_state = null;
  await tick();
  expect(markOf(container, id(1))).toBeNull();
  expect(hasTypeIcon(container, id(1))).toBe(true);
});

it("失败与取消同样当拍收敛；下一轮由消息落地信号重新点亮，不靠轮询自己发现", async () => {
  const server = fakeServer([session(1, "一条会失败的讨论", "RUNNING")]);
  const { container } = await mount({ fakeTimers: true });
  await act(async () => { publishActiveConversation({ taskId: null, sessionId: id(1) }); });
  expect(markState(container, id(1))).toBe("RUNNING");

  // 结算成 FAILED：投影里没有在途行，环消失。
  server.rows[0]!.run_state = null;
  await tick();
  expect(markOf(container, id(1))).toBeNull();

  // 下一轮开始时，左栏不是靠轮询自己发现的——没有在跑就不轮询。
  // 真实链路是这一轮的用户消息落库 → 协作页递 `activityEpoch` → 左栏定向重读这一行。
  server.rows[0]!.run_state = "RUNNING";
  const quiet = server.listCalls;
  await tick(9000);
  expect(markOf(container, id(1))).toBeNull();
  expect(server.listCalls).toBe(quiet);

  await act(async () => { bumpActiveConversationActivity(id(1)); });
  expect(markState(container, id(1))).toBe("RUNNING");

  // 结算成 CANCELLED：同样是终态，环当拍消失。
  server.rows[0]!.run_state = null;
  await tick();
  expect(markOf(container, id(1))).toBeNull();
});

it("切到别的会话，原会话仍在执行时继续显示；切回来也不会被这次重读清掉", async () => {
  const server = fakeServer([session(1, "后台还在跑的讨论", "RUNNING"),
    session(2, "正在看的讨论", null)]);
  const { container } = await mount({ fakeTimers: true });
  expect(markState(container, id(1))).toBe("RUNNING");

  // 切到第二条：左栏只会定向重读这一条，原会话的运行态来自随后那一拍轮询。
  await act(async () => { publishActiveConversation({ taskId: null, sessionId: id(2) }); });
  expect(server.singleCalls).toBeGreaterThan(0);
  await tick();
  expect(markState(container, id(1))).toBe("RUNNING");

  // 原会话在后台结束：切走之后仍然能及时收到终态。
  server.rows[0]!.run_state = null;
  await tick();
  expect(markOf(container, id(1))).toBeNull();

  // 再切回来：单条读取带同一枚 run_state，不会因为「重读了这一行」把环清掉。
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

  server.rows[0]!.run_state = null;
  await tick();
  expect(markOf(container, id(1))).toBeNull();
  expect(markOf(container, id(1), goalId)).toBeNull();
});

it("读取失败保留上一次读到的运行态，不伪造完成也不伪造在跑", async () => {
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
  server.rows[0]!.run_state = null;
  await tick(30_000);
  expect(markOf(container, id(1))).toBeNull();
});

it("没有在跑的时候一个请求都不多打；页面不可见时也不打", async () => {
  const idle = fakeServer([session(1, "安静的讨论", null)]);
  const { container } = await mount({ fakeTimers: true });
  const afterLoad = idle.listCalls;
  await tick(30_000);
  expect(container.querySelector('[data-testid="recent-work-run-state"]')).toBeNull();
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

it("重连后换的新连接读到终态时，环立刻消失，旧连接留下的轮询也不再继续", async () => {
  const first = fakeServer([session(1, "连上时还在跑的讨论", "RUNNING")]);
  const { container, reconnect } = await mount({ fakeTimers: true });
  expect(markState(container, id(1))).toBe("RUNNING");
  const firstCalls = first.listCalls;

  // 换一条连接：新服务端此刻已经没有在途行（这一轮在断线期间跑完了）。
  const second = fakeServer([session(1, "连上时已经跑完的讨论", null)]);
  const client = new RelayApiClient({ baseUrl: "http://127.0.0.1:8796", workspaceId,
    bearerToken: "test-only-reconnected" });
  await reconnect(client);

  expect(markOf(container, id(1))).toBeNull();
  expect(hasTypeIcon(container, id(1))).toBe(true);
  // 没有在途行就不该再有轮询：两条连接都不再被按节拍敲。
  const secondCalls = second.listCalls;
  await tick(30_000);
  expect(second.listCalls).toBe(secondCalls);
  expect(first.listCalls).toBe(firstCalls);
});

it("重连后重新挂载：服务端已无在途行时，行不再带运行指示", async () => {
  fakeServer([session(1, "连上时已经跑完", null)]);
  const { container } = await mount({ fakeTimers: true });
  expect(markOf(container, id(1))).toBeNull();
  expect(hasTypeIcon(container, id(1))).toBe(true);
});
