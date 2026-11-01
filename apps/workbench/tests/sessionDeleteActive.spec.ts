import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { createMemoryRouter, RouterProvider } from "react-router-dom";
import { afterEach, expect, it, vi } from "vitest";
import RecentWorkRail from "../src/components/RecentWorkRail";
import { RelayApiClient } from "../src/api/relayClient";
import { bumpActiveConversationContext, clearActiveConversation, publishActiveConversation } from "../src/lib/activeConversation";

/**
 * 删除会话与「当前在看的那一条」之间的身份对齐（UI-SESSION-DELETE-ACTIVE，2026-11-01）。
 *
 * 四件被守护的事，都不在「行有没有消失」这一层：
 * 1. **身份只认确切 sessionId。** 判断删的是谁、摘哪一行、要不要收尾，都不许退化成标题比较
 *    ——同一作用域里两条同名讨论是正常状态（分叉就会产生同名），不是极端输入。
 * 2. **删别的会话，当前会话一切不动。** 路由、侧栏 `aria-current` 与
 *    `recent-work-item--active` 必须原样保留。
 * 3. **确认删掉的正是当前那一条时，收尾只走现有的「新对话」路由意图。** 左栏不登记第二份
 *    「已删除」状态，也不自己清高亮：协作页是会话身份的唯一 Owner，跳过去之后由它重新发布。
 * 4. **迟到的旧读取不能翻案。** 服务端确认删除之后，一份在删除之前发出的会话读数落地时，
 *    既不能把已删的行带回列表，也不能把它带回勾选集。
 */

const workspaceId = "11111111-1111-4111-8111-111111111111";
const id = (n: number) => `33333333-3333-4333-8333-${String(n).padStart(12, "0")}`;

interface Row {
  readonly id: string;
  project_id: string | null;
  task_id: string | null;
  title: string;
  status: string;
  revision: string;
  pinned_at: string | null;
  unread_at: string | null;
  created_at: string;
  updated_at: string;
  last_message_at: string | null;
  has_messages: boolean;
}

const row = (n: number, title: string, at: string): Row => ({
  id: id(n), project_id: null, task_id: null, title, status: "ACTIVE", revision: "1",
  pinned_at: null, unread_at: null,
  created_at: `2026-10-0${n}T${at}:00Z`, updated_at: `2026-10-0${n}T${at}:00Z`,
  last_message_at: `2026-10-0${n}T${at}:00Z`, has_messages: true
});

const json = (body: unknown, status = 200) =>
  ({ ok: status < 400, status, json: async () => body }) as Response;

interface Fake {
  /** 服务端真实收到过哪些删除命令（按确切会话身份记一次）。 */
  readonly deletedTargets: string[];
  readonly rows: Row[];
  /** 让下一次删除命令卡在途中。 */
  holdDelete(sessionId: string, gate: Promise<void>): void;
  /** 让下一条单条会话读取卡在途中：制造「重读在途 → 删除先完成」这一拍。 */
  holdSingleRead(sessionId: string, gate: Promise<void>): void;
  /** 让下一次整列读取卡在途中：制造「整列读在途 → 删除先完成」这一拍。 */
  holdListRead(gate: Promise<void>): void;
}

function fakeServer(rows: Row[], options: {
  /** 被别的对象引用：业务拒绝，行与当前会话都不许动。 */
  deleteBlockedIds?: readonly string[];
  /** 服务端 500 且始终查不到回执：只能停在待核实。 */
  deleteServerErrorIds?: readonly string[];
  /**
   * 命令与服务端回执都已提交（行已没），但响应丢了；且删除时那一次自动核对还查不到回执，
   * 只有用户点「核对回执」的第二次查才拿到。
   */
  deleteResponseLostIds?: readonly string[];
} = {}): Fake {
  const deletedTargets: string[] = [];
  const receipts = new Map<string, Record<string, unknown>>();
  const receiptReads = new Map<string, number>();
  const receiptBlindOnce = new Set<string>();
  const deleteHolds = new Map<string, Promise<void>>();
  const singleHolds = new Map<string, Promise<void>>();
  let listHold: Promise<void> | null = null;
  const find = (sessionId: string) => rows.find((item) => item.id === sessionId);

  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    const path = url.pathname;
    const deletion = /\/assist-sessions\/([^/]+)\/delete$/u.exec(path);
    if (init?.method === "POST" && deletion !== null) {
      const target = find(String(deletion[1]));
      const body = JSON.parse(String(init.body)) as Record<string, unknown>;
      deletedTargets.push(String(deletion[1]));
      if (target === undefined) return json({ code: "RESOURCE_NOT_FOUND", detail: "gone" }, 404);
      const hold = deleteHolds.get(target.id);
      if (hold !== undefined) { deleteHolds.delete(target.id); await hold; }
      if ((options.deleteBlockedIds ?? []).includes(target.id)) {
        return json({ code: "SESSION_DELETE_BLOCKED", detail: "referenced",
          conflict: { blocking_reasons: ["LEARNING_RECORDS"] } }, 409);
      }
      if ((options.deleteServerErrorIds ?? []).includes(target.id)) {
        return json({ code: "INTERNAL_ERROR", detail: "请求未能完成。",
          request_id: "req-delete-500" }, 500);
      }
      rows.splice(rows.indexOf(target), 1);
      const commandId = String(body.command_id);
      receipts.set(commandId, { session_id: target.id, revision: target.revision,
        deleted_messages: 1, deleted_attachments: 0, deleted_at: "2026-11-01T08:00:00.000Z" });
      if ((options.deleteResponseLostIds ?? []).includes(target.id)) {
        receiptBlindOnce.add(commandId);
        return json({ code: "INTERNAL_ERROR", detail: "请求未能完成。",
          request_id: "req-delete-lost" }, 500);
      }
      return json({ command_id: commandId, committed_at: "2026-11-01T08:00:00Z",
        result: receipts.get(commandId) });
    }
    if (path.endsWith("/assist-sessions")) {
      const status = url.searchParams.get("status") ?? "ACTIVE";
      // 快照在**请求到达那一拍**就取好，再进挂起器：真实世界里迟到的那一发拿到的是删除之前
      // 的那一份，不能在释放时才现读——那样等于替被测代码把竞态抹平。
      const snapshot = json({ items: rows.filter((item) => status === "ALL" || item.status === status) });
      const held = listHold;
      if (held !== null) { listHold = null; await held; }
      return snapshot;
    }
    const single = /\/assist-sessions\/([^/]+)$/u.exec(path);
    if (single !== null) {
      const sessionId = String(single[1]);
      const target = find(sessionId);
      const snapshot = target === undefined
        ? json({ code: "RESOURCE_NOT_FOUND", detail: "gone" }, 404) : json(target);
      const hold = singleHolds.get(sessionId);
      if (hold !== undefined) { singleHolds.delete(sessionId); await hold; }
      return snapshot;
    }
    const receipt = /\/commands\/([^/]+)$/u.exec(path);
    if (receipt !== null) {
      const key = String(receipt[1]);
      const seen = (receiptReads.get(key) ?? 0) + 1;
      receiptReads.set(key, seen);
      const found = receipts.get(key);
      // 当场那一次核对撞上「事务尚未对外可见」；用户点「核对回执」的第二次查才拿到。
      if (found !== undefined && !(receiptBlindOnce.has(key) && seen === 1)) {
        return json({ command_id: key, command_type: "DeleteAssistSession",
          committed_at: "2026-11-01T08:00:00Z", result: found });
      }
      return json({ code: "COMMAND_NOT_FOUND", detail: "没有这条回执" }, 404);
    }
    // 任务分页留一枚续页游标：用例要靠它触发一次「整列重读」。
    if (path.endsWith("/tasks")) return json({ items: [], next_cursor: rows.length > 0 ? "cursor-2" : null });
    return json({ items: [], next_cursor: null });
  }));

  return {
    deletedTargets, rows,
    holdDelete: (sessionId, gate) => { deleteHolds.set(sessionId, gate); },
    holdSingleRead: (sessionId, gate) => { singleHolds.set(sessionId, gate); },
    holdListRead: (gate) => { listHold = gate; }
  };
}

let cleanup: (() => void) | undefined;
afterEach(() => {
  cleanup?.(); cleanup = undefined; clearActiveConversation();
  vi.unstubAllGlobals(); window.localStorage.clear();
});

async function mount(): Promise<{ container: HTMLElement; router: ReturnType<typeof createMemoryRouter> }> {
  const client = new RelayApiClient({ baseUrl: "http://127.0.0.1:8794", workspaceId,
    bearerToken: "test-only" });
  const router = createMemoryRouter(
    [{ path: "*", element: createElement(RecentWorkRail, { client, currentTaskId: null }) }],
    { initialEntries: ["/agent"] });
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  cleanup = () => { act(() => root.unmount()); container.remove(); };
  await act(async () => { root.render(createElement(RouterProvider, { router })); });
  await tick();
  return { container, router };
}

const tick = async (): Promise<void> => {
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 20)); });
};

const rowNode = (container: HTMLElement, sessionId: string) =>
  container.querySelector<HTMLElement>(`[data-testid="recent-work-${sessionId}"]`);
const selectNode = (container: HTMLElement, sessionId: string) =>
  container.querySelector<HTMLInputElement>(`[data-testid="recent-work-select-${sessionId}"]`);

/** 当前会话在侧栏的全部可见证据：`aria-current` 与 active class 必须同时成立。 */
function highlightOf(container: HTMLElement, sessionId: string): { current: string | null, active: boolean, present: boolean } {
  const node = rowNode(container, sessionId);
  return { current: node?.getAttribute("aria-current") ?? null,
    active: node?.classList.contains("recent-work-item--active") === true,
    present: node !== null };
}
const highlighted = { current: "true", active: true, present: true };

async function openMenu(container: HTMLElement, sessionId: string): Promise<void> {
  const trigger = container.querySelector<HTMLButtonElement>(`[data-testid="recent-work-menu-${sessionId}"]`);
  await act(async () => { trigger?.click(); });
}

async function clickAction(container: HTMLElement, sessionId: string, label: string): Promise<void> {
  const panel = container.querySelector<HTMLElement>(`[data-testid="recent-work-panel-${sessionId}"]`);
  const button = [...(panel?.querySelectorAll("button") ?? [])]
    .find((item) => (item.textContent ?? "").trim() === label);
  if (button === undefined) throw new Error(`面板里没有「${label}」`);
  await act(async () => { button.click(); });
  await tick();
}

/** 就地确认卡是 `position: fixed` 浮层，可能挂在 body 层，因此按全局 testid 找。 */
async function clickEverywhere(testId: string): Promise<boolean> {
  const button = document.querySelector<HTMLButtonElement>(`[data-testid="${testId}"]`);
  if (button === null) return false;
  await act(async () => { button.click(); });
  await tick();
  return true;
}

async function deleteOne(container: HTMLElement, sessionId: string): Promise<void> {
  await openMenu(container, sessionId);
  await clickAction(container, sessionId, "删除");
  await clickEverywhere(`session-delete-confirm-${sessionId}`);
}

async function toggleRow(container: HTMLElement, sessionId: string): Promise<void> {
  const box = selectNode(container, sessionId);
  if (box === null) throw new Error("这一行没有选择复选框");
  await act(async () => { box.click(); });
}

async function clickBar(container: HTMLElement, testId: string): Promise<void> {
  const button = container.querySelector<HTMLButtonElement>(`[data-testid="${testId}"]`);
  if (button === null) throw new Error(`批量条里没有 ${testId}`);
  await act(async () => { button.click(); });
  await tick();
}

const routeOf = (router: ReturnType<typeof createMemoryRouter>) =>
  `${router.state.location.pathname}${router.state.location.search}`;
const newKeyOf = (router: ReturnType<typeof createMemoryRouter>) =>
  new URLSearchParams(router.state.location.search).get("new");

it("删除其他会话：当前会话的侧栏高亮、active class 与路由一律不动", async () => {
  const fake = fakeServer([row(1, "正在看的讨论", "01"), row(2, "另一段讨论", "02")]);
  const { container, router } = await mount();
  act(() => { publishActiveConversation({ taskId: null, sessionId: id(1) }); });
  await tick();
  expect(highlightOf(container, id(1))).toEqual(highlighted);

  await deleteOne(container, id(2));

  expect(fake.deletedTargets).toEqual([id(2)]);
  expect(highlightOf(container, id(2)).present).toBe(false);
  expect(highlightOf(container, id(1))).toEqual(highlighted);
  expect(routeOf(router)).toBe("/agent");
});

it("同名不同 ID：只按确切 sessionId 摘行，被删的同名行不顶掉当前会话的高亮", async () => {
  const fake = fakeServer([row(1, "同一标题", "01"), row(2, "同一标题", "02")]);
  const { container } = await mount();
  act(() => { publishActiveConversation({ taskId: null, sessionId: id(2) }); });
  await tick();
  expect(highlightOf(container, id(2))).toEqual(highlighted);

  await deleteOne(container, id(1));

  expect(fake.deletedTargets).toEqual([id(1)]);
  expect(highlightOf(container, id(1)).present).toBe(false);
  expect(highlightOf(container, id(2))).toEqual(highlighted);
  expect(container.querySelectorAll(".recent-work-item--active")).toHaveLength(1);
});

it("确认删掉的正是当前会话：沿既有「新对话」路由意图收尾，侧栏不再留着那一条", async () => {
  const fake = fakeServer([row(1, "正在看的讨论", "01"), row(2, "另一段讨论", "02")]);
  const { container, router } = await mount();
  act(() => { publishActiveConversation({ taskId: null, sessionId: id(1) }); });
  await tick();

  await deleteOne(container, id(1));

  expect(fake.deletedTargets).toEqual([id(1)]);
  expect(highlightOf(container, id(1)).present).toBe(false);
  expect(newKeyOf(router)).not.toBeNull();
  // 另一段没被牵连：它还在，但不是当前会话。
  expect(rowNode(container, id(2))).not.toBeNull();
});

it("批量删除部分成功：删掉的别的会话不碰高亮，被挡住的那条原样留着", async () => {
  const fake = fakeServer(
    [row(1, "正在看的讨论", "01"), row(2, "可以删掉的讨论", "02"), row(3, "被引用的讨论", "03")],
    { deleteBlockedIds: [id(3)] });
  const { container, router } = await mount();
  act(() => { publishActiveConversation({ taskId: null, sessionId: id(1) }); });
  await tick();

  await toggleRow(container, id(2));
  await toggleRow(container, id(3));
  await clickBar(container, "recent-work-batch-delete");
  await clickBar(container, "recent-work-batch-delete-confirm");

  expect(fake.deletedTargets).toEqual([id(2), id(3)]);
  expect(rowNode(container, id(2))).toBeNull();
  expect(rowNode(container, id(3))).not.toBeNull();
  expect(highlightOf(container, id(1))).toEqual(highlighted);
  expect(routeOf(router)).toBe("/agent");
});

it("批量删除里含当前会话：确认之后一次跳转，且只按确切身份判定", async () => {
  const fake = fakeServer([row(1, "正在看的讨论", "01"), row(2, "另一段讨论", "02")]);
  const { container, router } = await mount();
  act(() => { publishActiveConversation({ taskId: null, sessionId: id(1) }); });
  await tick();

  await toggleRow(container, id(2));
  await toggleRow(container, id(1));
  await clickBar(container, "recent-work-batch-delete");
  await clickBar(container, "recent-work-batch-delete-confirm");

  expect(fake.deletedTargets).toEqual([id(2), id(1)]);
  expect(rowNode(container, id(1))).toBeNull();
  expect(rowNode(container, id(2))).toBeNull();
  expect(newKeyOf(router)).not.toBeNull();
});

it("blocked 不误清当前会话：业务拒绝之后行、高亮与路由一律不动", async () => {
  const fake = fakeServer([row(1, "正在看的讨论", "01"), row(2, "被引用的讨论", "02")],
    { deleteBlockedIds: [id(2)] });
  const { container, router } = await mount();
  act(() => { publishActiveConversation({ taskId: null, sessionId: id(1) }); });
  await tick();

  await deleteOne(container, id(2));

  expect(fake.deletedTargets).toEqual([id(2)]);
  expect(rowNode(container, id(2))).not.toBeNull();
  expect(highlightOf(container, id(1))).toEqual(highlighted);
  expect(routeOf(router)).toBe("/agent");
});

it("结果未知不误清当前会话：核对不到就仍是一动不动，也不重发删除命令", async () => {
  const fake = fakeServer([row(1, "正在看的讨论", "01"), row(2, "另一段讨论", "02")],
    { deleteServerErrorIds: [id(2)] });
  const { container, router } = await mount();
  act(() => { publishActiveConversation({ taskId: null, sessionId: id(1) }); });
  await tick();

  await deleteOne(container, id(2));
  expect(rowNode(container, id(2))).not.toBeNull();
  expect(fake.deletedTargets).toEqual([id(2)]);

  expect(await clickEverywhere(`session-delete-recheck-${id(2)}`)).toBe(true);
  // 仍查不到回执：不改口、不重发、不收行、不跳转。
  expect(fake.deletedTargets).toEqual([id(2)]);
  expect(rowNode(container, id(2))).not.toBeNull();
  expect(highlightOf(container, id(1))).toEqual(highlighted);
  expect(routeOf(router)).toBe("/agent");
});

it("响应丢失但服务端已提交：当场查不到回执不提前跳走，核对到回执才确认删除当前会话", async () => {
  const fake = fakeServer([row(1, "正在看的讨论", "01")],
    { deleteResponseLostIds: [id(1)] });
  const { container, router } = await mount();
  act(() => { publishActiveConversation({ taskId: null, sessionId: id(1) }); });
  await tick();

  await deleteOne(container, id(1));
  // 当场查不到回执 → 仍是未知：界面不许提前判定已删，也不许把用户从这段讨论里跳走。
  expect(rowNode(container, id(1))).not.toBeNull();
  expect(newKeyOf(router)).toBeNull();

  expect(await clickEverywhere(`session-delete-recheck-${id(1)}`)).toBe(true);
  // 第二次按同一枚 command_id 核对到已提交：这才算确认删除。
  expect(fake.deletedTargets).toEqual([id(1)]);
  expect(rowNode(container, id(1))).toBeNull();
  expect(newKeyOf(router)).not.toBeNull();
});

it("慢响应竞态：删除之前发出的当前会话重读迟到，不能把已删的那一行带回列表", async () => {
  const fake = fakeServer([row(1, "正在看的讨论", "01")]);
  const { container, router } = await mount();
  act(() => { publishActiveConversation({ taskId: null, sessionId: id(1) }); });
  await tick();

  // 左栏正为「当前会话」重读那一条（作用域事实刚被确认），这一发读数卡在途中。
  let release: (() => void) | undefined;
  fake.holdSingleRead(id(1), new Promise<void>((resolve) => { release = resolve; }));
  act(() => { bumpActiveConversationContext(); });
  await tick();

  await deleteOne(container, id(1));
  expect(rowNode(container, id(1))).toBeNull();
  expect(newKeyOf(router)).not.toBeNull();

  act(() => { release?.(); });
  await tick();
  await tick();
  // 删除之前那一份读数落地：已确认删除的那一条不能借着重读回来。
  expect(rowNode(container, id(1))).toBeNull();
});

it("慢响应竞态：删除之前发出的整列读取迟到，不能把已删会话与它的勾选带回来", async () => {
  const fake = fakeServer([row(1, "正在看的讨论", "01"), row(2, "另一段讨论", "02")]);
  const { container, router } = await mount();
  act(() => { publishActiveConversation({ taskId: null, sessionId: id(1) }); });
  await tick();

  // 「更早的任务」那一次续页会顺带整列重读会话：让它卡在删除之前发出的那一拍上。
  let release: (() => void) | undefined;
  fake.holdListRead(new Promise<void>((resolve) => { release = resolve; }));
  await clickBar(container, "recent-work-more");

  await deleteOne(container, id(2));
  expect(rowNode(container, id(2))).toBeNull();

  act(() => { release?.(); });
  await tick();
  await tick();
  expect(rowNode(container, id(2))).toBeNull();
  expect(selectNode(container, id(2))).toBeNull();
  expect(highlightOf(container, id(1))).toEqual(highlighted);
  expect(routeOf(router)).toBe("/agent");
});
