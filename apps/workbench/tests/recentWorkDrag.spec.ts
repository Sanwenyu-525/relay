import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { createMemoryRouter, RouterProvider } from "react-router-dom";
import { afterEach, expect, it, vi } from "vitest";
import RecentWorkRail from "../src/components/RecentWorkRail";
import { RelayApiClient } from "../src/api/relayClient";
import { clearActiveConversation } from "../src/lib/activeConversation";

/**
 * 会话行的拖拽改序（本机导航偏好，工作台 §28.1）。
 *
 * 守的六件事：
 * 1. **横线指哪儿就落在哪儿。** 落位线所在的那一格与松手后的实际位置必须出自同一次计算，
 *    不能画在一处、落到另一处。抓握期间手里那一行跟着指针平移，其余行一动不动。
 * 2. **改的是这一列的显示次序，事实仍归服务端。** 拖拽不向服务端发任何命令，只写本机偏好；
 *    落回原位那一次连存储都不写。
 * 3. **拖与点分得开。** 没超过抓握阈值就是普通单击，照旧打开会话。
 * 4. **归档区不参与手动排序**：那一列根本没有可拖的位置事实。
 * 5. **换位看得出来。** 只有真的换了位的行才播位移，位移量等于两次 rect 之差；
 *    刚落位的行留一档会自己消失的强调。关掉动效时这两段装饰都没有，但强调仍然给出。
 * 6. **自动序的口径和服务端一致。** 没排过位时按最后消息时间倒序，置顶压在它上面（0090 / 0111）。
 */

const workspaceId = "11111111-1111-4111-8111-111111111111";
const id = (n: number) => `33333333-3333-4333-8333-${String(n).padStart(12, "0")}`;
const ORDER_KEY = "relay.workbench.recentWorkSessionOrder";

/** jsdom 不做布局：这一列的行几何由下面两个 getter 现算（行高等宽，落在行间的缝里）。 */
const ROW_H = 32;
const ROW_GAP = 2;
const topOf = (index: number) => index * (ROW_H + ROW_GAP);
const midOf = (index: number) => topOf(index) + ROW_H / 2;

/** 行在这一列里的序号：offsetTop 与 getBoundingClientRect 共用同一个来源，两者不能各算一套。 */
function rowIndex(element: HTMLElement): number {
  const rows = [...(element.parentElement?.children ?? [])].filter((item) => item.hasAttribute("data-recent-row"));
  return rows.indexOf(element);
}

function stubRowLayout() {
  Object.defineProperty(HTMLElement.prototype, "offsetTop", { configurable: true,
    get(this: HTMLElement) {
      return this.hasAttribute("data-recent-row") ? rowIndex(this) * (ROW_H + ROW_GAP) : 0;
    } });
  Object.defineProperty(HTMLElement.prototype, "offsetHeight", { configurable: true,
    get(this: HTMLElement) { return this.hasAttribute("data-recent-row") ? ROW_H : 0; } });
  // 落位动画读的是 rect（FLIP 要的是视口坐标），所以这里也要给一个自洽的顶边。
  const realRect = HTMLElement.prototype.getBoundingClientRect;
  Object.defineProperty(HTMLElement.prototype, "getBoundingClientRect", { configurable: true,
    value(this: HTMLElement) {
      if (!this.hasAttribute("data-recent-row")) return realRect.call(this);
      const top = rowIndex(this) * (ROW_H + ROW_GAP);
      return { top, bottom: top + ROW_H, height: ROW_H, y: top, x: 0, left: 0, right: 0, width: 0,
        toJSON: () => ({}) } as DOMRect;
    } });
}

/** jsdom 没有 WAAPI：换成记录器，顺带证明组件只在真有实现时才播。 */
interface PlayedAnimation { key: string; from: string; duration: number | undefined; easing: string | undefined }

const played: PlayedAnimation[] = [];
// 换成「一个可写的 animate 槽」而不是 Element 上的方法声明：记录器返回的不是真 Animation，
// 借 DOM 的类型签名只会逼这段夹具去假装自己实现了 WAAPI。
const animateSlot = Element.prototype as unknown as { animate: unknown };
const realAnimate = animateSlot.animate;

function stubAnimate() {
  played.length = 0;
  animateSlot.animate = function (this: Element, keyframes: { transform: string }[],
    options?: { duration?: number; easing?: string }) {
    played.push({ key: (this as HTMLElement).dataset.recentRow ?? "", from: keyframes[0]!.transform,
      duration: options?.duration, easing: options?.easing });
    return {};
  };
}

interface Row {
  readonly id: string;
  project_id: string | null;
  task_id: string | null;
  title: string;
  status: string;
  revision: string;
  pinned_at: string | null;
  /** 0111：最后一条消息落库或生成结算的时刻；null = 这段会话还没有消息。 */
  last_message_at: string | null;
  created_at: string;
  updated_at: string;
}

const row = (n: number, title: string, status = "ACTIVE",
  lastMessageAt: string | null = null): Row => ({
  id: id(n), project_id: null, task_id: null, title, status, revision: "1", pinned_at: null,
  last_message_at: lastMessageAt,
  created_at: `2026-10-0${n}T10:00:00Z`, updated_at: `2026-10-0${n}T10:00:00Z`
});

const json = (body: unknown, status = 200) =>
  ({ ok: status < 400, status, json: async () => body }) as Response;

/**
 * 服务端顺序：置顶优先，其余按最后消息时间倒序，还没说过话的回落创建时间
 * （与 listSessions 的 order by 一致）。三条未置顶、都没说过话的会话因此读回来是 3、2、1。
 * `posts` 收所有写命令，用来证明拖拽没发命令。
 */
function fakeServer(rows: Row[]) {
  const posts: Record<string, unknown>[] = [];
  const find = (sessionId: string) => rows.find((item) => item.id === sessionId);
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    const path = url.pathname;
    const command = /\/assist-sessions\/([^/]+)\/(title|pin|archive|reopen)$/u.exec(path);
    if (init?.method === "POST" && command !== null) {
      const [, sessionId, action] = command;
      const body = JSON.parse(String(init.body)) as Record<string, unknown>;
      posts.push({ action, ...body });
      const target = find(sessionId);
      if (target === undefined) return json({ code: "RESOURCE_NOT_FOUND" }, 404);
      const committed = { command_id: String(body.command_id), committed_at: "2026-10-17T09:00:00Z" };
      if (action === "pin") {
        target.pinned_at = body.pinned === true ? "2026-10-17T08:00:00.000Z" : null;
        target.revision = String(Number(target.revision) + 1);
        return json({ ...committed, result: { session_id: target.id, pinned: body.pinned,
          pinned_at: target.pinned_at, revision: target.revision, updated_at: target.updated_at } });
      }
      target.status = action === "archive" ? "ARCHIVED" : "ACTIVE";
      target.revision = String(Number(target.revision) + 1);
      return json({ ...committed, result: { session_id: target.id, status: target.status,
        revision: target.revision, updated_at: target.updated_at } });
    }
    if (path.endsWith("/assist-sessions")) {
      const status = url.searchParams.get("status") ?? "ACTIVE";
      const visible = rows.filter((item) => status === "ALL" || item.status === status);
      const activity = (item: Row) => item.last_message_at ?? item.created_at;
      return json({ items: [...visible].sort((a, b) => {
        if ((a.pinned_at === null) !== (b.pinned_at === null)) return a.pinned_at === null ? 1 : -1;
        return activity(b).localeCompare(activity(a));
      }) });
    }
    const single = /\/assist-sessions\/([^/]+)$/u.exec(path);
    if (single !== null) {
      const target = find(single[1]);
      return target === undefined ? json({ code: "RESOURCE_NOT_FOUND" }, 404) : json(target);
    }
    return json({ items: [], next_cursor: null });
  }));
  return { posts };
}

let cleanup: (() => void) | undefined;
afterEach(() => {
  cleanup?.(); cleanup = undefined; clearActiveConversation();
  animateSlot.animate = realAnimate;
  vi.unstubAllGlobals(); window.localStorage.clear();
});

async function mount() {
  stubRowLayout();
  const client = new RelayApiClient({ baseUrl: "http://127.0.0.1:8794", workspaceId,
    bearerToken: "test-only" });
  const router = createMemoryRouter(
    [{ path: "*", element: createElement(RecentWorkRail, { client, currentTaskId: null }) }],
    { initialEntries: ["/projects"] });
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  cleanup = () => { act(() => root.unmount()); container.remove(); };
  await act(async () => { root.render(createElement(RouterProvider, { router })); });
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 20)); });
  return { container, router };
}

/** 只有「目标」与「工作区（目录）」这两类会话列带可拖标记；本夹具没有目标关联，故唯一一列。 */
const list = (container: HTMLElement) => container.querySelector<HTMLElement>("ul[data-reorder-list]")!;
const orderOf = (container: HTMLElement) =>
  [...list(container).querySelectorAll<HTMLElement>("[data-recent-row]")].map((item) => item.dataset.recentRow);
const buttonOf = (container: HTMLElement, sessionId: string) =>
  container.querySelector<HTMLElement>(`[data-testid="recent-work-${sessionId}"]`)!;
const pointer = (type: string, clientY: number) =>
  new MouseEvent(type, { bubbles: true, cancelable: true, clientY, button: 0 });

/** 从第 `from` 行的中线按下、移到第 `to` 行的中线；返回松手动作，便于先核对落位线再放行。 */
async function dragRow(container: HTMLElement, sessionId: string, from: number, to: number) {
  const button = buttonOf(container, sessionId);
  await act(async () => { button.dispatchEvent(pointer("pointerdown", midOf(from))); });
  await act(async () => { window.dispatchEvent(pointer("pointermove", midOf(from) + 6)); });
  await act(async () => { window.dispatchEvent(pointer("pointermove", midOf(to))); });
  return { release: async () => { await act(async () => {
    // 真实浏览器就在这一拍里补发 click：与拖拽落位同时发出，才测得出「行被搬走 ≠ 打开会话」。
    window.dispatchEvent(pointer("pointerup", midOf(to)));
    button.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
  }); } };
}

it("拖拽时画出一条落位横线，松手后行就落在横线指的那一格", async () => {
  const { posts } = fakeServer([row(1, "最早的讨论"), row(2, "中间的讨论"), row(3, "最新的讨论")]);
  const { container, router } = await mount();
  expect(orderOf(container)).toEqual([`session:${id(3)}`, `session:${id(2)}`, `session:${id(1)}`]);

  const drag = await dragRow(container, id(3), 0, 2);
  const line = container.querySelector<HTMLElement>('[data-testid="recent-work-drop-line"]');
  // 横线落在第 3 行的上沿——即第 2 行与第 3 行之间那道缝；它是绝对定位，不占网格轨道。
  expect(line).not.toBeNull();
  expect(line?.parentElement).toBe(list(container));
  expect(line?.style.insetBlockStart || line?.style.top).toBe(`${topOf(2)}px`);
  // 指针走到哪儿，被抓的那一行就跟到哪儿：位移正好等于指针相对起手点走的那段（68px）。
  // 带着走只写在 transform 上，不碰布局——行的次序与落点数学仍是起手时量到的那一套。
  const held = container.querySelector<HTMLElement>(`[data-recent-row="session:${id(3)}"]`)!;
  expect(held.classList.contains("recent-work-row--dragging")).toBe(true);
  expect(held.style.transform).toBe(`translateY(${midOf(2) - midOf(0)}px)`);
  expect([...list(container).querySelectorAll<HTMLElement>("[data-recent-row]")]
    .filter((item) => item !== held).map((item) => item.style.transform)).toEqual(["", ""]);

  await drag.release();
  // 落点与横线同一条缝：新序是 2、3、1。
  expect(orderOf(container)).toEqual([`session:${id(2)}`, `session:${id(3)}`, `session:${id(1)}`]);
  // 松手即撤抓握态：不留内联位移，落位动画才有干净的起点。
  expect(held.style.transform).toBe("");
  expect(held.classList.contains("recent-work-row--dragging")).toBe(false);
  expect(container.querySelector('[data-testid="recent-work-drop-line"]')).toBeNull();
  expect(JSON.parse(window.localStorage.getItem(ORDER_KEY) ?? "null")).toMatchObject({
    version: 1, sessions: [id(2), id(3), id(1)] });
  // 位置是本机偏好：这一趟没有向服务端发任何命令。
  expect(posts).toEqual([]);
  // 松手补发的那次 click 不打开讨论：人刚拖完，还停在左栏。
  expect(router.state.location.search).not.toContain("session=");
});

it("落回原来那一格不写存储；没超过抓握阈值的单击仍照常打开会话", async () => {
  const { posts } = fakeServer([row(1, "最早的讨论"), row(2, "中间的讨论"), row(3, "最新的讨论")]);
  const { container, router } = await mount();

  // 只挪 2px：仍是「点一下」，不该进入拖拽，也不该吞掉随后打开会话的那次点击。
  const button = buttonOf(container, id(3));
  await act(async () => { button.dispatchEvent(pointer("pointerdown", midOf(0))); });
  await act(async () => { window.dispatchEvent(pointer("pointermove", midOf(0) + 2)); });
  expect(container.querySelector('[data-testid="recent-work-drop-line"]')).toBeNull();
  await act(async () => { window.dispatchEvent(pointer("pointerup", midOf(0) + 2)); });
  await act(async () => { button.click(); });
  expect(router.state.location.search).toContain(`session=${id(3)}`);
  expect(posts).toEqual([]);

  // 真的拖了、又放回原来那一格（第 2 行上方）：次序没变，存储也不写。
  // 往下走 30px 还没跨过第 2 行的中线，落点仍是原格——但手里确实带着这一行走了这 30px。
  const again = buttonOf(container, id(3));
  await act(async () => { again.dispatchEvent(pointer("pointerdown", midOf(0))); });
  await act(async () => { window.dispatchEvent(pointer("pointermove", midOf(0) + 30)); });
  const held = container.querySelector<HTMLElement>(`[data-recent-row="session:${id(3)}"]`)!;
  expect(held.style.transform).toBe("translateY(30px)");
  await act(async () => { window.dispatchEvent(pointer("pointerup", midOf(0) + 30)); });
  // 放回原格也要把手里的位移收掉：留着它，下一拍读到的几何就都不是布局位置了。
  expect(held.style.transform).toBe("");
  expect(orderOf(container)).toEqual([`session:${id(3)}`, `session:${id(2)}`, `session:${id(1)}`]);
  expect(window.localStorage.getItem(ORDER_KEY)).toBeNull();
});

it("整列重读仍认拖出来的次序；此后置顶只改标记，不再把行抢回最前", async () => {
  const rows = [row(1, "最早的讨论"), row(2, "中间的讨论"), row(3, "最新的讨论")];
  const { posts } = fakeServer(rows);
  const first = await mount();
  const drag = await dragRow(first.container, id(3), 0, 2);
  await drag.release();

  // 重新挂载＝刷新左栏：次序从本机偏好读回，不再依赖服务端那一套排序键。
  cleanup?.(); cleanup = undefined;
  const again = await mount();
  expect(orderOf(again.container)).toEqual([`session:${id(2)}`, `session:${id(3)}`, `session:${id(1)}`]);

  await act(async () => {
    again.container.querySelector<HTMLElement>(`[data-testid="recent-work-menu-${id(3)}"]`)!.click(); });
  await act(async () => {
    [...again.container.querySelectorAll<HTMLElement>(`[data-testid="recent-work-panel-${id(3)}"] button`)]
      .find((button) => (button.textContent ?? "").trim() === "置顶")!.click(); });
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 20)); });

  // 置顶照旧写成服务端事实并发出命令（这一条是本用例唯一的一次写）。
  expect(posts.map((post) => post.action)).toEqual(["pin"]);
  expect(rows.find((item) => item.id === id(3))?.pinned_at).not.toBeNull();
  expect(again.container.querySelector(`[data-testid="recent-work-${id(3)}"] .recent-work-pin`)).not.toBeNull();
  // 人已排过的位不再被排序键顶掉：位置与置顶分开读，各自只有一个来源。
  expect(orderOf(again.container)).toEqual([`session:${id(2)}`, `session:${id(3)}`, `session:${id(1)}`]);
});

it("最后消息时间决定未置顶那一段的上下：刚说过话的旧会话排到没开口的新会话前面", async () => {
  // 活动序（0111）：3 号刚才说完、1 号上午说过一句、2 号是这轮里最新建的但还没开口。
  // 按创建时间应是 3、2、1；按最后消息时间应是 3、1、2——2 号不因这一列为空而沉到底。
  fakeServer([row(1, "上午说过一句", "ACTIVE", "2026-10-18T01:00:00Z"),
    row(2, "刚建的还没说话"), row(3, "刚才说完", "ACTIVE", "2026-10-18T02:00:00Z")]);
  const { container } = await mount();
  expect(orderOf(container)).toEqual([`session:${id(3)}`, `session:${id(1)}`, `session:${id(2)}`]);
});

it("置顶压在活动序上面：那一档只由 pinned_at 决定，最后消息时间不抢位", async () => {
  const pinned = row(2, "置顶但说过话");
  pinned.pinned_at = "2026-10-17T08:00:00.000Z";
  pinned.last_message_at = "2026-10-16T09:00:00Z";
  fakeServer([row(1, "更早的讨论"), pinned,
    row(3, "刚才说完", "ACTIVE", "2026-10-18T02:00:00Z")]);
  const { container } = await mount();
  expect(orderOf(container)).toEqual([`session:${id(2)}`, `session:${id(3)}`, `session:${id(1)}`]);
});

it("落位动画把移动过的行从旧位置滑到新位置，刚落下的那一行短促强调", async () => {
  fakeServer([row(1, "最早的讨论"), row(2, "中间的讨论"), row(3, "最新的讨论")]);
  const { container } = await mount();
  stubAnimate();

  const drag = await dragRow(container, id(3), 0, 2);
  await drag.release();

  // 3 与 2 互换了格子：各自从旧顶边滑回新顶边，没动的第 3 行不该被播一次。
  expect(played.map((item) => item.key).sort()).toEqual([`session:${id(2)}`, `session:${id(3)}`].sort());
  const moved = new Map(played.map((item) => [item.key, item]));
  // 行 3 从第 0 格（0px）落到第 1 格（34px）：起点应是 −34px 的反向位移。
  expect(moved.get(`session:${id(3)}`)?.from).toBe("translateY(-34px)");
  expect(moved.get(`session:${id(2)}`)?.from).toBe("translateY(34px)");
  expect(moved.get(`session:${id(3)}`)?.duration).toBe(180);
  expect(moved.get(`session:${id(3)}`)?.easing).toBe("cubic-bezier(0.2, 0, 0, 1)");

  // 刚落下的那一行带一次性强调；被换走的那一行不带。
  expect(container.querySelector(`[data-recent-row="session:${id(3)}"][data-recent-dropped="true"]`)).not.toBeNull();
  expect(container.querySelector(`[data-recent-row="session:${id(2)}"][data-recent-dropped]`)).toBeNull();

  // 连拖两次：前一次的标记由下一次落位收掉，不会留在旧行上。
  const back = await dragRow(container, id(1), 2, 0);
  await back.release();
  expect(orderOf(container)).toEqual([`session:${id(1)}`, `session:${id(2)}`, `session:${id(3)}`]);
  expect(container.querySelector(`[data-recent-row="session:${id(3)}"][data-recent-dropped]`)).toBeNull();
  expect(container.querySelector(`[data-recent-row="session:${id(1)}"][data-recent-dropped="true"]`)).not.toBeNull();

  // 强调只停一档 motion.duration.emphasis（1.2s），之后自己收干净。
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 1_300)); });
  expect(container.querySelector("[data-recent-dropped]")).toBeNull();
});

it("本机关掉动效后不滑位，但落位强调仍然给出静态回执", async () => {
  fakeServer([row(1, "最早的讨论"), row(2, "中间的讨论"), row(3, "最新的讨论")]);
  const { container } = await mount();
  stubAnimate();
  window.localStorage.setItem("relay.motion", "off");

  const drag = await dragRow(container, id(3), 0, 2);
  await drag.release();
  // 减少动态效果：位置照样换，只是不再滑。
  expect(orderOf(container)).toEqual([`session:${id(2)}`, `session:${id(3)}`, `session:${id(1)}`]);
  expect(played).toEqual([]);
  expect(container.querySelector(`[data-recent-row="session:${id(3)}"][data-recent-dropped="true"]`)).not.toBeNull();
});

it("归档区的会话列没有可拖入口：那一段不参与手动排序", async () => {
  fakeServer([row(1, "留下的讨论"), row(2, "归档的讨论", "ARCHIVED")]);
  const { container } = await mount();
  const archived = container.querySelector<HTMLElement>('[data-testid="recent-work-archived"]')!;
  await act(async () => { archived.setAttribute("open", "");
    archived.dispatchEvent(new Event("toggle", { bubbles: true })); });
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 20)); });

  const archivedList = archived.querySelector("ul");
  expect(archivedList).not.toBeNull();
  expect(archivedList!.hasAttribute("data-reorder-list")).toBe(false);
  // 从归档行起手不进拖拽：它所在的列没有可拖的位置事实。
  const target = archived.querySelector<HTMLElement>("[data-recent-row]")!;
  await act(async () => { target.dispatchEvent(pointer("pointerdown", midOf(0))); });
  await act(async () => { window.dispatchEvent(pointer("pointermove", midOf(0) + 20)); });
  expect(container.querySelector('[data-testid="recent-work-drop-line"]')).toBeNull();
  await act(async () => { window.dispatchEvent(pointer("pointerup", midOf(0) + 20)); });
  expect(window.localStorage.getItem(ORDER_KEY)).toBeNull();
});
