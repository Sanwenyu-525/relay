import { act, createElement, Fragment } from "react";
import { createRoot } from "react-dom/client";
import { createMemoryRouter, RouterProvider } from "react-router-dom";
import { afterEach, expect, it, vi } from "vitest";
import RecentWorkRail from "../src/components/RecentWorkRail";
import { FeedbackHost } from "../src/components/Feedback";
import { RelayApiClient } from "../src/api/relayClient";
import { clearActiveConversation } from "../src/lib/activeConversation";
import { feedbackEntries, removeFeedback } from "../src/lib/feedback";

/**
 * 近期工作栏里那条会话的 ⋯ 菜单（工作台 §28.9、命令契约 §10.86、迁移 0090/0104/0113）。
 *
 * 这里守护的不是「有没有按钮」，而是六条口径：
 * 1. **改动只走命令，显示只认服务端。** 每次成功都要重读那一条会话，行里出现的必须是
 *    读回来的标题/状态/置顶时刻，不是本地拼出来的乐观结果。
 * 2. **409 只重读，不重发。** 版本落后时最多一次命令、一次重读；用户再点才用**新的**
 *    command_id 和**新的**修订。换 ID 自动重试会绕过 CAS，把别人刚写的事实盖掉。
 * 3. **归档即隐藏发生在读侧。** 「已归档」那一段在用户真需要之前不发请求；把唯一一条
 *    讨论归档后，重开入口仍必须找得到。
 * 4. **⋯ 与行平级，面板是浮层。** 行本体是 `<button>`，按钮里不能套按钮；套进去点击会落到行上。
 *    2026-10-16 第五轮把两者收进 `.recent-work-row-head`（⋯ 的定位基准只剩行本身），
 *    面板改成 `position: fixed` 的浮层、落在行头之外——展开不再撑高这一行，⋯ 因此不会位移。
 * 5. **复制会话 ID 是纯客户端动作，未读走同一条 CAS。** 复制不发命令、不重读、不推进修订；
 *    未读与置顶同形，两个方向共用一个端点，行上的圆点只认重读回来的 unread_at。
 * 6. **分叉改的是「多了一条会话」，不是这一行（0113）。** 命令之后重读的是回执里那个新会话身份，
 *    源行不回头重读也不推进修订；标题编号（1）（2）由服务端算，界面只显示读回来的那一条。
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
}

const row = (n: number, title: string, at: string): Row => ({
  id: id(n), project_id: null, task_id: null, title, status: "ACTIVE", revision: "1",
  pinned_at: null, unread_at: null,
  created_at: `2026-10-0${n}T${at}:00Z`, updated_at: `2026-10-0${n}T${at}:00Z`
});

const json = (body: unknown, status = 200) =>
  ({ ok: status < 400, status, json: async () => body }) as Response;

/**
 * 假服务端里的编号规则，与服务端同一读法：末位已是「（n）」就加一，否则追加「（1）」。
 * 放在这里只为让「界面显示读回来的标题」这条断言有对象可读，不是客户端该算的东西。
 */
function nextForkTitle(title: string): string {
  const matched = /[（(](\d+)[）)]\s*$/u.exec(title);
  return `${matched === null ? title : title.slice(0, matched.index)}（${matched === null ? 1 : Number(matched[1]) + 1}）`;
}

/** 服务端顺序：置顶优先，其次创建时间倒序（与 listSessions 的 order by 一致）。 */
function serverOrder(rows: readonly Row[]): Row[] {
  return [...rows].sort((a, b) => {
    if ((a.pinned_at === null) !== (b.pinned_at === null)) return a.pinned_at === null ? 1 : -1;
    if (a.pinned_at !== null && b.pinned_at !== null) return b.pinned_at.localeCompare(a.pinned_at);
    return b.created_at.localeCompare(a.created_at);
  });
}

interface Fake {
  readonly posts: Record<string, unknown>[];
  readonly reads: string[];
  readonly rows: Row[];
}

/**
 * 一台可变的假服务端：命令真的改写行，重读真的读回改写后的行。
 * `conflictOnFirstCommand` 模拟另一个窗口抢先改过这条会话——第一次命令撞到 409，
 * 服务端同时把行推进一版，用来验证界面重读拿到的是新修订。
 * `pinReceiptCarriesForeignCommandId` 模拟响应丢失/错位这一类最危险的情况：命令确实到了
 * 服务端，但回执里的 command_id 不是我们发出去的那一枚，客户端必须判为「无法核对」。
 */
function fakeServer(rows: Row[], options: {
  conflictOnFirstCommand?: boolean; pinReceiptCarriesForeignCommandId?: boolean;
  /** 撤销用的重开撞 409：归档已生效，反向命令被别处抢先，界面只能将这条撤销升级成停留的提示。 */
  conflictOnReopen?: boolean;
  /** 归档命令到了服务端并真的改了行，回执却带着别的 command_id：本次是否生效未定，不能给撤销条。 */
  archiveReceiptCarriesForeignCommandId?: boolean;
  /** 删除被跨对象引用挡住：服务端按 409 SESSION_DELETE_BLOCKED 返回阻止项，行必须原样保留。 */
  deleteBlocked?: boolean;
  /** 只挡住这几条（批量删除的「部分成功」）：其余照常删除。 */
  deleteBlockedIds?: readonly string[];
  /** 删除命令真的删了行，回执却对不上那一枚 command_id：本次结果不明，确认键必须锁死。 */
  deleteReceiptCarriesForeignCommandId?: boolean } = {}): Fake {
  const posts: Record<string, unknown>[] = [];
  const reads: string[] = [];
  let conflicted = false;
  // 分叉出去几条子会话，决定假行拿哪一枚身份：子会话不在源数据里，由命令现场造。
  let forks = 0;
  const find = (sessionId: string) => rows.find((item) => item.id === sessionId);
  const bump = (target: Row) => {
    target.revision = String(Number(target.revision) + 1);
    target.updated_at = "2026-10-16T09:00:00Z";
  };

  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    const path = url.pathname;
    const command = /\/assist-sessions\/([^/]+)\/(title|pin|unread|archive|reopen|fork|delete)$/u.exec(path);
    if (init?.method === "POST" && command !== null) {
      const [, sessionId, action] = command;
      const body = JSON.parse(String(init.body)) as Record<string, unknown>;
      posts.push({ action, ...body });
      const target = find(String(sessionId));
      if (target === undefined) return json({ code: "RESOURCE_NOT_FOUND", detail: "gone" }, 404);
      if (options.conflictOnFirstCommand === true && !conflicted) {
        conflicted = true;
        // 服务端已有更新的事实：别人先把这条会话改了名。
        target.title = "另一个窗口改过的标题";
        bump(target);
        return json({ code: "REVISION_CONFLICT", detail: "会话已被更新",
          conflict: { expected_revision: String(body.expected_revision),
            actual_revision: target.revision } }, 409);
      }
      const committed = { command_id: String(body.command_id), committed_at: "2026-10-16T09:00:00Z" };
      if (action === "reopen" && options.conflictOnReopen === true) {
        // 归档已经生效，撤销这一发被别处抢先：反向命令失败不能只留一条就地错误，
        // 用户手上那个入口刚刚消失，必须升级成停留到用户处理的提示。
        bump(target);
        return json({ code: "REVISION_CONFLICT", detail: "会话已被更新",
          conflict: { expected_revision: String(body.expected_revision), actual_revision: target.revision } }, 409);
      }
      if (action === "delete") {
        if (options.deleteBlocked === true || (options.deleteBlockedIds ?? []).includes(target.id)) {
          // 行没动：被别的对象引用是业务拒绝，不是「本次结果不明」。
          return json({ code: "SESSION_DELETE_BLOCKED", detail: "referenced",
            conflict: { blocking_reasons: ["TASK_ACCEPTANCE_CITED", "LEARNING_RECORDS"] } }, 409);
        }
        rows.splice(rows.indexOf(target), 1);
        if (options.deleteReceiptCarriesForeignCommandId === true) {
          return json({ command_id: "00000000-0000-4000-8000-000000000000",
            committed_at: "2026-10-18T08:00:00Z", result: { session_id: target.id,
              revision: target.revision, deleted_messages: 2, deleted_attachments: 0,
              deleted_at: "2026-10-18T08:00:00.000Z" } });
        }
        return json({ ...committed, result: { session_id: target.id, revision: target.revision,
          deleted_messages: 2, deleted_attachments: 0,
          deleted_at: "2026-10-18T08:00:00.000Z" } });
      }
      if (action === "title") {
        target.title = String(body.title);
        bump(target);
        return json({ ...committed, result: { session_id: target.id, title: target.title,
          revision: target.revision, updated_at: target.updated_at } });
      }
      if (action === "pin") {
        if (options.pinReceiptCarriesForeignCommandId === true) {
          // 行没被这条命令改过，回执却带着别的 command_id 回来：这属于结果不明。
          return json({ command_id: "00000000-0000-4000-8000-000000000000",
            committed_at: "2026-10-16T09:00:00Z", result: { session_id: target.id, pinned: true,
              pinned_at: "2026-10-16T08:00:00.000Z", revision: "2", updated_at: "2026-10-16T09:00:00Z" } });
        }
        target.pinned_at = body.pinned === true ? "2026-10-16T08:00:00.000Z" : null;
        bump(target);
        return json({ ...committed, result: { session_id: target.id, pinned: body.pinned,
          pinned_at: target.pinned_at, revision: target.revision, updated_at: target.updated_at } });
      }
      if (action === "unread") {
        target.unread_at = body.unread === true ? "2026-10-17T02:30:00.000Z" : null;
        bump(target);
        return json({ ...committed, result: { session_id: target.id, unread: body.unread,
          unread_at: target.unread_at, revision: target.revision, updated_at: target.updated_at } });
      }
      if (action === "fork") {
        // 分叉新建一条子会话：源行一行都不改（不推进修订与更新时间），编号由「服务端」决定。
        // 客户端不拼（1）（2）——界面只显示读回来的那一条，编号对不对由 API 用例守。
        const title = nextForkTitle(target.title);
        const child: Row = { ...target, id: id(90 + forks), title,
          status: "ACTIVE", revision: "0", pinned_at: null, unread_at: null,
          created_at: "2026-10-16T10:00:00Z", updated_at: "2026-10-16T10:00:00Z" };
        forks += 1;
        rows.push(child);
        return json({ ...committed, result: { session_id: child.id, title: child.title,
          revision: child.revision, updated_at: child.updated_at, copied_messages: 3 } }, 201);
      }
      target.status = action === "archive" ? "ARCHIVED" : "ACTIVE";
      bump(target);
      if (action === "archive" && options.archiveReceiptCarriesForeignCommandId === true) {
        // 行确实被推进了，回执却对不上我们发出去的那一枚命令：客户端只能判「无法核对」，
        // 这条会话此刻到底是归档还是没归档都没确定，不能承诺撤回已产生的副作用。
        return json({ command_id: "00000000-0000-4000-8000-000000000000",
          committed_at: "2026-10-16T09:00:00Z", result: { session_id: target.id, status: target.status,
            revision: target.revision, updated_at: target.updated_at } });
      }
      return json({ ...committed, result: { session_id: target.id, status: target.status,
        revision: target.revision, updated_at: target.updated_at } });
    }
    if (path.endsWith("/assist-sessions")) {
      reads.push(`list:${url.searchParams.get("status") ?? "ACTIVE"}`);
      return json({ items: serverOrder(rows.filter((item) => {
        const status = url.searchParams.get("status") ?? "ACTIVE";
        return status === "ALL" || item.status === status;
      })) });
    }
    const single = /\/assist-sessions\/([^/]+)$/u.exec(path);
    if (single !== null) {
      const target = find(String(single[1]));
      if (target === undefined) return json({ code: "RESOURCE_NOT_FOUND", detail: "gone" }, 404);
      reads.push(`single:${target.id}`);
      return json(target);
    }
    if (path.endsWith("/projects")) return json({ items: [], next_cursor: null });
    return json({ items: [], next_cursor: null });
  }));

  return { posts, reads, rows };
}

let cleanup: (() => void) | undefined;
afterEach(() => {
  cleanup?.(); cleanup = undefined; clearActiveConversation();
  // 命令式撤销条不随组件卸载收走（这正是它能活过面板关闭的原因），而这几条用例共用同一枚
  // 会话 id：不清空 store，上一条的撤销条会被下一条的宿主重新渲染出来，断言就串了。
  act(() => { feedbackEntries().forEach((entry) => { removeFeedback(entry.id); }); });
  vi.unstubAllGlobals(); window.localStorage.clear();
});

async function mount(fake: Fake) {
  const client = new RelayApiClient({ baseUrl: "http://127.0.0.1:8794", workspaceId,
    bearerToken: "test-only" });
  const router = createMemoryRouter(
    [{ path: "*", element: createElement(RecentWorkRail, { client, currentTaskId: null }) }],
    { initialEntries: ["/projects"] });
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  cleanup = () => { act(() => root.unmount()); container.remove(); };
  // 真应用里这条栈由 AppShell 挂一次；这里只挂左栏，所以要自己补上宿主，
  // 否则撤销条只进了 store 却没渲染，断言会把「看不见」读成「没实现」。
  await act(async () => { root.render(createElement(Fragment, null,
    createElement(RouterProvider, { router }), createElement(FeedbackHost))); });
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 20)); });
  return { container, router, fake };
}

const menuOf = (container: HTMLElement, sessionId: string) =>
  container.querySelector<HTMLButtonElement>(`[data-testid="recent-work-menu-${sessionId}"]`);
const panelOf = (container: HTMLElement, sessionId: string) =>
  container.querySelector<HTMLElement>(`[data-testid="recent-work-panel-${sessionId}"]`);
const rowOf = (container: HTMLElement, sessionId: string) =>
  container.querySelector<HTMLElement>(`[data-testid="recent-work-${sessionId}"]`);
/**
 * 「归档即隐藏」要看的是它还在不在活跃那一段里：jsdom 折叠 `<details>` 不会把子节点从
 * DOM 里摘掉，所以按全局 testid 断言存在性会同时命中归档区，把断言写成假通过。
 * 2026-10-16 第七轮起归档段与三个活跃根区同处 recent-work-list 包装层（让根区相邻选择器
 * 覆盖「任务入口 ↔ 已归档」的间距），因此命中后还要再排除落在归档段里的那一份；
 * 归档段在文档序上位于三个活跃根区之后，活跃副本永远先被 querySelector 取到。
 */
const rowInActiveList = (container: HTMLElement, sessionId: string) => {
  const row = container.querySelector<HTMLElement>(`[data-testid="recent-work-list"] [data-testid="recent-work-${sessionId}"]`);
  return row !== null && row.closest('[data-testid="recent-work-archived"]') === null ? row : null;
};

async function openMenu(container: HTMLElement, sessionId: string): Promise<void> {
  const trigger = menuOf(container, sessionId);
  // 上一次失败可能把面板留在原地：这时点 ⋯ 是「收起」，先把面板关掉再展开。
  if (trigger?.getAttribute("aria-expanded") === "true") {
    const panel = panelOf(container, sessionId);
    await act(async () => { panel?.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })); });
  }
  await act(async () => { trigger?.click(); });
}

async function clickAction(container: HTMLElement, sessionId: string, label: string): Promise<void> {
  const button = [...(panelOf(container, sessionId)?.querySelectorAll("button") ?? [])]
    .find((item) => (item.textContent ?? "").trim() === label);
  if (button === undefined) throw new Error(`面板里没有「${label}」`);
  await act(async () => { button.click(); });
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 20)); });
}

function typeInto(input: HTMLInputElement, value: string): void {
  act(() => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

async function submitRename(container: HTMLElement, sessionId: string, value: string): Promise<void> {
  await openMenu(container, sessionId);
  await clickAction(container, sessionId, "重命名");
  const input = container.querySelector<HTMLInputElement>(`[data-testid="recent-work-rename-input-${sessionId}"]`);
  if (input === null) throw new Error("改名输入框没有出现");
  typeInto(input, value);
  const form = input.closest("form");
  if (form === null) throw new Error("改名输入框不在表单里");
  await act(async () => { form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })); });
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 20)); });
}

it("置顶把行提到最前并显示标记；改动来自重读，不来自本地拼装", async () => {
  const fake = fakeServer([row(1, "较早的讨论", "01"), row(2, "较晚的讨论", "02")]);
  const { container } = await mount(fake);
  // 未置顶时按创建时间倒序：后建的在前。
  expect([...container.querySelectorAll(".recent-work-item")].map((node) => node.getAttribute("data-testid")))
    .toEqual([`recent-work-${id(2)}`, `recent-work-${id(1)}`]);
  expect(container.querySelector(`[data-testid="recent-work-${id(1)}"] .recent-work-pin`)).toBeNull();

  await openMenu(container, id(1));
  await clickAction(container, id(1), "置顶");

  expect(fake.posts).toEqual([{ action: "pin", command_id: expect.any(String),
    expected_revision: "1", pinned: true }]);
  // 一次成功命令之后只重读这一条，不整列重读，也不把结果拼进本地状态。
  expect(fake.reads.filter((read) => read.startsWith("single:"))).toEqual([`single:${id(1)}`]);
  const rows = [...container.querySelectorAll(".recent-work-item")].map((node) => node.getAttribute("data-testid"));
  expect(rows).toEqual([`recent-work-${id(1)}`, `recent-work-${id(2)}`]);
  expect(container.querySelector(`[data-testid="recent-work-${id(1)}"] .recent-work-pin`)?.textContent)
    .toContain("置顶");

  await openMenu(container, id(1));
  await clickAction(container, id(1), "取消置顶");
  expect(fake.posts[1]).toMatchObject({ action: "pin", pinned: false });
  expect(container.querySelector(`[data-testid="recent-work-${id(1)}"] .recent-work-pin`)).toBeNull();
  // 取消置顶写回 NULL：不留「曾经置顶」的第三种状态。
  expect(fake.rows[0]?.pinned_at).toBeNull();
});

it("改名发的是去空白后的标题；空标题与未改动都不发请求", async () => {
  const fake = fakeServer([row(1, "旧的标题", "01")]);
  const { container } = await mount(fake);

  await submitRename(container, id(1), "  改过的标题  ");
  expect(fake.posts).toEqual([{ action: "title", command_id: expect.any(String),
    expected_revision: "1", title: "改过的标题" }]);
  expect(rowOf(container, id(1))?.querySelector(".recent-work-title")?.textContent).toBe("改过的标题");

  // 只有空白：本地就挡住，不给服务端一趟必然失败的命令。
  await submitRename(container, id(1), "   ");
  expect(fake.posts).toHaveLength(1);
  expect(panelOf(container, id(1))?.querySelector('[role="alert"]')?.textContent).toContain("标题不能为空");

  // 与当前标题相同：没什么可改的，不该推进服务端修订。
  await submitRename(container, id(1), "改过的标题");
  expect(fake.posts).toHaveLength(1);
  expect(panelOf(container, id(1))).toBeNull();

  await submitRename(container, id(1), "标".repeat(201));
  expect(fake.posts).toHaveLength(1);
  expect(panelOf(container, id(1))?.querySelector('[role="alert"]')?.textContent)
    .toContain("标题不能超过 200 个字符");
});

it("分叉：一次命令、读回的是新建的子会话，源行一行都没改（0113）", async () => {
  const fake = fakeServer([row(1, "要分叉的讨论", "01")]);
  const { container } = await mount(fake);
  const childId = id(90);

  await openMenu(container, id(1));
  await clickAction(container, id(1), "分叉这段讨论");

  // 只发一次命令，且带的是这一行当前的修订；回执是 201（新建资源），客户端照单核对。
  expect(fake.posts).toEqual([{ action: "fork", command_id: expect.any(String), expected_revision: "1" }]);
  // 源会话没被改：修订与更新时间都还是原样，界面也没有回头重读它。
  expect(fake.rows[0]?.revision).toBe("1");
  expect(fake.reads.filter((read) => read.startsWith("single:"))).toEqual([`single:${childId}`]);
  // 列里多出来的那一行是服务端给的那一条：标题里的（1）由服务端决定，界面不自己拼。
  expect(rowInActiveList(container, childId)).not.toBeNull();
  expect(rowOf(container, childId)?.querySelector(".recent-work-title")?.textContent).toBe("要分叉的讨论（1）");

  // 对分叉出来的那条再分一次：编号仍由服务端算（（1）→（2）），CAS 基线用它自己的修订 0。
  await openMenu(container, childId);
  await clickAction(container, childId, "分叉这段讨论");
  expect(fake.posts[1]).toMatchObject({ action: "fork", expected_revision: "0" });
  expect(fake.rows[1]?.title).toBe("要分叉的讨论（1）");
  expect(fake.rows[2]?.title).toBe("要分叉的讨论（2）");
});

it("归档即隐藏：行移出默认列表，「已归档」那一段按需才读，重开回到原处", async () => {
  const fake = fakeServer([row(1, "要被归档的讨论", "01"), row(2, "留下的讨论", "02")]);
  const { container } = await mount(fake);
  // 挂载时不预读归档列表：一个收起的分组不该先打一趟请求。
  expect(fake.reads).toEqual(["list:ACTIVE"]);

  await openMenu(container, id(1));
  await clickAction(container, id(1), "归档");
  expect(fake.posts).toEqual([{ action: "archive", command_id: expect.any(String),
    expected_revision: "1" }]);
  expect(fake.rows[0]?.status).toBe("ARCHIVED");
  expect(rowInActiveList(container, id(1))).toBeNull();
  // 归档后这一条从活跃列表消失，读侧过滤就是「归档即隐藏」的落点。
  expect(fake.reads).toContain("list:ARCHIVED");

  const archivedSection = container.querySelector<HTMLDetailsElement>('[data-testid="recent-work-archived"]')!;
  await act(async () => { archivedSection.open = true;
    archivedSection.dispatchEvent(new Event("toggle", { bubbles: true })); });
  expect(archivedSection.querySelector(`[data-testid="recent-work-${id(1)}"]`)).not.toBeNull();
  expect(archivedSection.querySelector(".recent-work-group-count")?.textContent).toBe("1");

  await openMenu(container, id(1));
  // 归档态只留两条：重命名/置顶/分叉都得先重开；删除与归档是两条通道，不因归档被挡住。
  expect([...(panelOf(container, id(1))?.querySelectorAll("button") ?? [])]
    .map((button) => (button.textContent ?? "").trim())).toEqual(["重开这段讨论", "删除"]);
  await clickAction(container, id(1), "重开这段讨论");
  expect(fake.posts[1]).toMatchObject({ action: "reopen", expected_revision: "2" });
  expect(rowInActiveList(container, id(1))).not.toBeNull();
  expect(fake.rows[0]?.status).toBe("ACTIVE");
});

it("归档给反悔窗口：撤销是一条新的重开命令，修订取归档回执而不是左栏那行", async () => {
  const fake = fakeServer([row(1, "要被归档的讨论", "01"), row(2, "留下的讨论", "02")]);
  const { container } = await mount(fake);
  await openMenu(container, id(1));
  await clickAction(container, id(1), "归档");
  expect(fake.posts).toHaveLength(1);
  expect(rowInActiveList(container, id(1))).toBeNull();

  // 面板已收起、那一行随之卸载，撤销条仍挂在 body 的那条栈里：命令式条目存在的理由。
  const testId = `session-archive-undo-${id(1)}`;
  expect(panelOf(container, id(1))).toBeNull();
  const card = document.querySelector<HTMLElement>(`[data-testid="${testId}"]`);
  expect(card?.closest(".feedback-stack")).not.toBeNull();
  expect(card?.textContent).toContain("已归档「要被归档的讨论」");

  const undo = card?.querySelector<HTMLButtonElement>("button");
  expect(undo?.textContent).toBe("撤销");
  await act(async () => { undo?.click(); });
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 20)); });

  // 撤销＝再发一条前向命令：新的 command_id + 归档回执推进后的修订，不是数据库回滚。
  expect(fake.posts[1]).toMatchObject({ action: "reopen", expected_revision: "2" });
  expect(fake.posts[1]?.command_id).not.toBe(fake.posts[0]?.command_id);
  expect(rowInActiveList(container, id(1))).not.toBeNull();
  expect(fake.rows[0]?.status).toBe("ACTIVE");
  expect(document.querySelector(`[data-testid="${testId}"]`)).toBeNull();
});

it("撤销被别处抢先：不补第三发命令，把这条撤销升级成停留到用户处理的提示", async () => {
  const fake = fakeServer([row(1, "抢跑的讨论", "01")], { conflictOnReopen: true });
  const { container } = await mount(fake);
  await openMenu(container, id(1));
  await clickAction(container, id(1), "归档");
  const testId = `session-archive-undo-${id(1)}`;
  const card = document.querySelector<HTMLElement>(`[data-testid="${testId}"]`);
  await act(async () => { card?.querySelector<HTMLButtonElement>("button")?.click(); });
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 20)); });

  // 关键红线：撤销失败后界面无权自动重试，只有一发归档 + 一发被拒的重开。
  expect(fake.posts.map((post) => post.action)).toEqual(["archive", "reopen"]);
  const notice = document.querySelector<HTMLElement>(`[data-testid="${testId}"]`);
  expect(notice?.getAttribute("data-variant")).toBe("notice");
  expect(notice?.getAttribute("role")).toBe("alert");
  expect(notice?.textContent).toContain("撤销没成功");
  // 这句话必须指向常驻入口：撤销条超时不等于这段讨论再也回不来。
  expect(notice?.textContent).toContain("已归档");
});

it("归档回执无法核对时不给撤销条：本次是否生效都没定，不能承诺撤回副作用", async () => {
  const fake = fakeServer([row(1, "回执对不上的讨论", "01")], { archiveReceiptCarriesForeignCommandId: true });
  const { container } = await mount(fake);
  await openMenu(container, id(1));
  await clickAction(container, id(1), "归档");
  expect(fake.posts).toHaveLength(1);
  expect(document.querySelector('[data-testid^="session-archive-undo-"]')).toBeNull();
  // 结果不明留在就地：面板不收起，这句话只有还在浮层里才读得到。
  expect(panelOf(container, id(1))?.querySelector('[role="alert"]')?.textContent).toContain("无法核对");
});

it("把唯一一条讨论归档后，重开入口仍在（不跟着空列表一起消失）", async () => {
  const fake = fakeServer([row(1, "唯一的讨论", "01")]);
  const { container } = await mount(fake);
  await openMenu(container, id(1));
  await clickAction(container, id(1), "归档");
  expect(container.querySelector('[data-testid="recent-work-empty"]')).not.toBeNull();
  expect(container.querySelector('[data-testid="recent-work-archived"]')).not.toBeNull();
  const archivedSection = container.querySelector<HTMLDetailsElement>('[data-testid="recent-work-archived"]')!;
  await act(async () => { archivedSection.open = true;
    archivedSection.dispatchEvent(new Event("toggle", { bubbles: true })); });
  expect(archivedSection.textContent).toContain("唯一的讨论");
});

it("409 只重读不重发：一次命令一次重读，再点才换新 command_id 与新修订", async () => {
  const fake = fakeServer([row(1, "被抢改的讨论", "01")], { conflictOnFirstCommand: true });
  const { container } = await mount(fake);

  await openMenu(container, id(1));
  await clickAction(container, id(1), "置顶");

  // 关键红线：失败后没有第二发命令，也没有换 ID 自动重试。
  expect(fake.posts).toHaveLength(1);
  expect(fake.reads.filter((read) => read.startsWith("single:"))).toEqual([`single:${id(1)}`]);
  // 冲突说明必须读得到：面板保持打开，收起就等于把失败藏起来。
  const alert = panelOf(container, id(1))?.querySelector('[role="alert"]');
  expect(alert?.textContent).toContain("这条会话刚被改过");
  expect(menuOf(container, id(1))?.getAttribute("aria-expanded")).toBe("true");
  // 行显示的是重读回来的服务端事实，不是本地那份旧标题。
  expect(rowOf(container, id(1))?.querySelector(".recent-work-title")?.textContent)
    .toBe("另一个窗口改过的标题");

  await clickAction(container, id(1), "置顶");
  expect(fake.posts).toHaveLength(2);
  expect(fake.posts[1]).toMatchObject({ action: "pin", pinned: true, expected_revision: "2" });
  expect(String(fake.posts[0]?.command_id)).not.toBe(String(fake.posts[1]?.command_id));
  expect(container.querySelector(`[data-testid="recent-work-${id(1)}"] .recent-work-pin`)).not.toBeNull();
});

it("回执对不上时按「结果不明」处理：不换 ID 重发，也不假装改动生效", async () => {
  const fake = fakeServer([row(1, "回执错位的讨论", "01")], { pinReceiptCarriesForeignCommandId: true });
  const { container } = await mount(fake);

  await openMenu(container, id(1));
  await clickAction(container, id(1), "置顶");

  // 只发了一次，也绝不再发第二次去赌它这次能对上。
  expect(fake.posts).toHaveLength(1);
  expect(fake.reads.filter((read) => read.startsWith("single:"))).toEqual([]);
  expect(fake.rows[0]?.pinned_at).toBeNull();
  expect(container.querySelector(`[data-testid="recent-work-${id(1)}"] .recent-work-pin`)).toBeNull();
  expect(panelOf(container, id(1))?.querySelector('[role="alert"]')?.textContent)
    .toContain("请求响应丢失或无法核对");
});

it("标记为未读与取消未读：一条命令、一次重读，行上的圆点跟随服务端事实", async () => {
  const fake = fakeServer([row(1, "有未读的讨论", "01")]);
  const { container } = await mount(fake);
  expect(container.querySelector('[data-testid="recent-work-unread-dot"]')).toBeNull();

  await openMenu(container, id(1));
  await clickAction(container, id(1), "标记为未读");
  expect(fake.posts).toEqual([{ action: "unread", command_id: expect.any(String),
    expected_revision: "1", unread: true }]);
  expect(fake.reads.filter((read) => read.startsWith("single:"))).toEqual([`single:${id(1)}`]);
  expect(fake.rows[0]?.unread_at).toBe("2026-10-17T02:30:00.000Z");
  // 圆点来自重读回来的 unread_at，不是本地乐观渲染。
  expect(container.querySelector('[data-testid="recent-work-unread-dot"]')).not.toBeNull();
  // 2026-10-19 用户指认「标记为未读之后没有 ui 上的变化、不够明显」：除了圆点，行本身也挂
  // --unread 一档（标题加粗由 CSS 承担）。只靠一枚 4px 的点在 12px 标题旁读不出状态变化。
  expect(container.querySelector(`[data-testid="recent-work-${id(1)}"]`)?.classList.contains("recent-work-item--unread"))
    .toBe(true);

  await openMenu(container, id(1));
  expect([...(panelOf(container, id(1))?.querySelectorAll("button") ?? [])]
    .map((button) => (button.textContent ?? "").trim())).toEqual(["置顶", "重命名", "取消未读", "分叉这段讨论", "复制会话 ID", "归档", "删除"]);
  await clickAction(container, id(1), "取消未读");
  expect(fake.posts[1]).toMatchObject({ action: "unread", unread: false, expected_revision: "2" });
  expect(fake.rows[0]?.unread_at).toBeNull();
  expect(container.querySelector('[data-testid="recent-work-unread-dot"]')).toBeNull();
  expect(container.querySelector(`[data-testid="recent-work-${id(1)}"]`)?.classList.contains("recent-work-item--unread"))
    .toBe(false);
});

it("复制会话 ID 是纯客户端动作：不发命令、不推进修订，复制后给出可见反馈", async () => {
  const writeText = vi.fn(async (_text: string) => undefined);
  const original = Object.getOwnPropertyDescriptor(window.navigator, "clipboard");
  Object.defineProperty(window.navigator, "clipboard", { configurable: true, value: { writeText } });
  try {
    const fake = fakeServer([row(1, "要复制身份的讨论", "01")]);
    const { container } = await mount(fake);
    await openMenu(container, id(1));
    await clickAction(container, id(1), "复制会话 ID");

    // 复制的是 URI 形式，不是裸 ID：粘出去仍读得出这是 Relay 的哪条会话。
    expect(writeText).toHaveBeenCalledWith(`relay://sessions/${id(1)}`);
    // 复制没有服务端事实：不发命令、不重读、不推进修订。
    expect(fake.posts).toEqual([]);
    expect(fake.reads.filter((read) => read.startsWith("single:"))).toEqual([]);
    expect(fake.rows[0]?.revision).toBe("1");
    // 反馈留在面板里：复制不是改动，不必收起浮层。
    expect(panelOf(container, id(1))).not.toBeNull();
    expect([...(panelOf(container, id(1))?.querySelectorAll("button") ?? [])]
      .map((button) => (button.textContent ?? "").trim())).toContain("已复制会话 ID");
  } finally {
    if (original === undefined) Reflect.deleteProperty(window.navigator, "clipboard");
    else Object.defineProperty(window.navigator, "clipboard", original);
  }
});

it("右键整行打开的就是 ⋯ 那个面板：锚点不变、不发命令，也不接管原生菜单", async () => {
  const fake = fakeServer([row(1, "右键唤起的讨论", "01")]);
  const { container } = await mount(fake);
  const rowButton = rowOf(container, id(1));
  if (rowButton === null) throw new Error("行按钮没有出现");

  const event = new MouseEvent("contextmenu", { bubbles: true, cancelable: true });
  await act(async () => { rowButton.dispatchEvent(event); });

  // 原生菜单让位：不 preventDefault 的话，WebView2 会在这一行上弹浏览器自带菜单。
  expect(event.defaultPrevented).toBe(true);
  expect(panelOf(container, id(1))).not.toBeNull();
  // 同一个面板、同一个锚点：⋯ 的展开态同步，因此它也显形，摆位几何只有一套。
  expect(menuOf(container, id(1))?.getAttribute("aria-expanded")).toBe("true");
  expect(fake.posts).toEqual([]);
});

it("动作按参考菜单分组成「图标 + 名称」：置顶／重命名／未读一组，分组细线之后复制身份、归档与删除收尾", async () => {
  const fake = fakeServer([row(1, "分组结构", "01")]);
  const { container } = await mount(fake);
  const sessionId = id(1);
  await openMenu(container, sessionId);
  const panel = panelOf(container, sessionId)!;

  // 顺序与分组：置顶／重命名／未读／分叉在前，分组细线之后复制身份、归档与删除收尾（参考菜单的两组读法）。
  expect([...panel.children].map((child) => child.getAttribute("role") === "separator"
    ? "separator" : (child.textContent ?? "").trim()))
    .toEqual(["置顶", "重命名", "标记为未读", "分叉这段讨论", "separator", "复制会话 ID", "归档", "删除"]);
  // 分组细线是 div 而不是 button：不吃焦点、不参与命令，只作视觉分隔。
  expect(panel.querySelector('[role="separator"]')?.tagName).toBe("DIV");
  // 七条动作各带一枚前缀图标；图标不进 textContent，因此单独核对存在性。
  expect([...panel.querySelectorAll("button")].map((button) => button.querySelector("svg") !== null))
    .toEqual([true, true, true, true, true, true, true]);
  // 带图标的按钮仍按整条命中：点击落在按钮本身上，命令照旧发出。
  await clickAction(container, sessionId, "置顶");
  expect(fake.posts).toEqual([{ action: "pin", command_id: expect.any(String),
    expected_revision: "1", pinned: true }]);
});

it("⋯ 与行按钮平级；Esc 收起面板并把焦点交回 ⋯", async () => {
  const fake = fakeServer([row(1, "结构与键盘", "01")]);
  const { container } = await mount(fake);
  const sessionId = id(1);
  const item = container.querySelector<HTMLButtonElement>(`[data-testid="recent-work-${sessionId}"]`)!;
  const trigger = menuOf(container, sessionId)!;
  // 按钮不能套按钮：触发器与行按钮平级（同属行头），否则点击会落进行本体。
  // 行头这一层同时把 ⋯ 的 50% 锚在行本身上——面板改成浮层后它不再跳到「行 + 面板」的中线。
  expect(item.querySelector(".recent-work-row-trigger")).toBeNull();
  expect(trigger.parentElement?.classList.contains("recent-work-row-head")).toBe(true);
  expect(trigger.parentElement?.querySelector(".recent-work-item")).toBe(item);
  expect(trigger.getAttribute("aria-expanded")).toBe("false");
  expect(trigger.getAttribute("aria-controls")).toBe(`recent-work-row-panel-${sessionId}`);
  expect(trigger.getAttribute("aria-label")).toContain("会话「结构与键盘」的操作");

  await openMenu(container, sessionId);
  expect(trigger.getAttribute("aria-expanded")).toBe("true");
  const panel = panelOf(container, sessionId)!;
  // 面板与行按钮是兄弟节点、且不在行按钮里：它是浮层（CSS 里 position: fixed，不进布局），
  // 展开既不撑高这一行，也改不动 ⋯ 的定位基准。像素级稳定性由浏览器用例核对。
  expect(item.querySelector(".recent-work-row-panel")).toBeNull();
  expect(panel.parentElement).toBe(trigger.parentElement);
  await act(async () => { trigger.focus(); });
  await act(async () => { panel.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })); });
  expect(panelOf(container, sessionId)).toBeNull();
  expect(trigger.getAttribute("aria-expanded")).toBe("false");
  expect(document.activeElement).toBe(trigger);
});

it("删除先确认：取消零命令；确认后行从活跃区消失，且不给撤销条", async () => {
  const fake = fakeServer([row(1, "要删掉的讨论", "01")]);
  const { container } = await mount(fake);
  const sessionId = id(1);
  const dialogCancel = () => document.querySelector<HTMLButtonElement>(
    `[data-testid="session-delete-cancel-${sessionId}"]`);

  await openMenu(container, sessionId);
  await clickAction(container, sessionId, "删除");
  // 2026-10-19 用户指令「改成简单弹窗」：确认是同一层浮层里的就地卡片，不是 AppDialog——
  // 没有遮罩层、没有第二套弹窗外壳，取消键就长在 ⋯ 面板里，标题与那句后果也都在这一层。
  expect(document.querySelector(".dialog-panel")).toBeNull();
  expect(document.querySelector(".dialog-backdrop")).toBeNull();
  expect(dialogCancel()?.closest('[data-testid="recent-work-panel-' + sessionId + '"]')).not.toBeNull();
  expect(panelOf(container, sessionId)?.querySelector(".recent-work-confirm-title")?.textContent)
    .toBe("删除这段讨论？");
  // 危险动作不从回车起手：初始焦点压在「取消」上，命令一条都没发。
  expect(document.activeElement).toBe(dialogCancel());
  expect(fake.posts).toEqual([]);

  await act(async () => { dialogCancel()!.click(); });
  expect(dialogCancel()).toBeNull();
  expect(fake.posts).toEqual([]);
  expect(rowInActiveList(container, sessionId)).not.toBeNull();

  await openMenu(container, sessionId);
  await clickAction(container, sessionId, "删除");
  await act(async () => {
    document.querySelector<HTMLButtonElement>(`[data-testid="session-delete-confirm-${sessionId}"]`)!.click();
  });
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 20)); });
  expect(fake.posts).toEqual([{ action: "delete", command_id: expect.any(String),
    expected_revision: "1" }]);
  expect(rowInActiveList(container, sessionId)).toBeNull();
  expect(fake.rows).toEqual([]);
  // 删除不可撤销：不像归档那样在浮层里留「撤销」；确认框也已经收起。
  expect(document.querySelector('[data-testid^="session-archive-undo-"]')).toBeNull();
  expect(document.querySelector(`[data-testid="session-delete-confirm-${sessionId}"]`)).toBeNull();
});

it("被其它对象引用时删除整条拒绝：阻止项留在确认框里，行不动、不发第二发", async () => {
  const fake = fakeServer([row(1, "被引用的讨论", "01")], { deleteBlocked: true });
  const { container } = await mount(fake);
  const sessionId = id(1);

  await openMenu(container, sessionId);
  await clickAction(container, sessionId, "删除");
  await act(async () => {
    document.querySelector<HTMLButtonElement>(`[data-testid="session-delete-confirm-${sessionId}"]`)!.click();
  });
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 20)); });

  expect(fake.posts).toHaveLength(1);
  expect(rowInActiveList(container, sessionId)).not.toBeNull();
  const alert = document.querySelector(`[data-testid="session-delete-confirm-${sessionId}"]`)
    ?.closest(".recent-work-row-panel")?.querySelector('[role="alert"]');
  // 阻止项按可读中文逐条列出，并指向仍然可用的归档通道。
  expect(alert?.textContent).toContain("被任务验收观察引用");
  expect(alert?.textContent).toContain("有学习记录");
  expect(alert?.textContent).toContain("归档");
  // 业务拒绝不是回执不明：确认键仍可再按（用户先回去归档），对话框不锁死。
  expect(document.querySelector<HTMLButtonElement>(`[data-testid="session-delete-confirm-${sessionId}"]`)?.disabled)
    .toBe(false);
});

it("删除回执对不上时确认键锁死：不换 command_id 重发", async () => {
  const fake = fakeServer([row(1, "回执不明", "01")], { deleteReceiptCarriesForeignCommandId: true });
  const { container } = await mount(fake);
  const sessionId = id(1);

  await openMenu(container, sessionId);
  await clickAction(container, sessionId, "删除");
  await act(async () => {
    document.querySelector<HTMLButtonElement>(`[data-testid="session-delete-confirm-${sessionId}"]`)!.click();
  });
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 20)); });

  expect(fake.posts).toHaveLength(1);
  const alert = document.querySelector(`[data-testid="session-delete-confirm-${sessionId}"]`)
    ?.closest(".recent-work-row-panel")?.querySelector('[role="alert"]');
  expect(alert?.textContent).toContain("是否生效尚未确定");
  // 本次是否删掉都未确定：确认键锁死，只能按原 command_id 查回执。
  expect(document.querySelector<HTMLButtonElement>(`[data-testid="session-delete-confirm-${sessionId}"]`)?.disabled)
    .toBe(true);
});

it("归档态的会话也能删除：只剩「重开」与「删除」两条，且删除仍先确认", async () => {
  const fake = fakeServer([row(1, "已归档的讨论", "01")]);
  const { container } = await mount(fake);
  const sessionId = id(1);
  // 归档段按需加载：先归档这一条，「已归档」那段才会读回它。
  await openMenu(container, sessionId);
  await clickAction(container, sessionId, "归档");
  const archivedSection = container.querySelector<HTMLDetailsElement>('[data-testid="recent-work-archived"]')!;
  await act(async () => { archivedSection.open = true;
    archivedSection.dispatchEvent(new Event("toggle", { bubbles: true })); });

  await openMenu(container, sessionId);
  const panel = panelOf(container, sessionId)!;
  expect([...panel.children].map((child) => child.getAttribute("role") === "separator"
    ? "separator" : (child.textContent ?? "").trim()))
    .toEqual(["重开这段讨论", "separator", "删除"]);
  await clickAction(container, sessionId, "删除");
  expect(document.querySelector(`[data-testid="session-delete-confirm-${sessionId}"]`)).not.toBeNull();
  expect(fake.posts.map((post) => post.action)).toEqual(["archive"]);
});

/* ---------------------------------------------------------------------------------------------
 * 会话行的批量选择复选框（2026-10-20 用户指令「给会话 item 加一个复选框，方便删除记录」）。
 *
 * 这里守四条口径，都是「删除不可撤销」这条业务事实的延伸：
 * 1. **选择只是选择。** 勾选不发命令、不动行；只有确认那一下才发删除。
 * 2. **一段一条命令。** 批量不是新端点：每段各取 command_id、各带读回来的修订，不假装原子。
 * 3. **部分成功要如实报。** 被引用阻止的那条留在列表里并留在选择集里，同一原因只写一次。
 * 4. **结果不明不重发。** 回执对不上就锁死确认键，勾选保留，只能由「取消」退出。
 * ------------------------------------------------------------------------------------------- */

const selectOf = (container: HTMLElement, sessionId: string) =>
  container.querySelector<HTMLInputElement>(`[data-testid="recent-work-select-${sessionId}"]`);
const barOf = (container: HTMLElement) =>
  container.querySelector<HTMLElement>('[data-testid="recent-work-selection"]');
const barText = (container: HTMLElement) => (barOf(container)?.textContent ?? "").replace(/\s+/gu, " ").trim();
const barButton = (container: HTMLElement, testId: string) =>
  container.querySelector<HTMLButtonElement>(`[data-testid="${testId}"]`);

async function toggleRow(container: HTMLElement, sessionId: string): Promise<void> {
  const box = selectOf(container, sessionId);
  if (box === null) throw new Error("这一行没有选择复选框");
  await act(async () => { box.click(); });
}

async function clickBar(container: HTMLElement, testId: string): Promise<void> {
  const button = barButton(container, testId);
  if (button === null) throw new Error(`批量条里没有 ${testId}`);
  await act(async () => { button.click(); });
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 20)); });
}

it("会话行带复选框：勾选只攒选择、不发命令；取消选择后批量条收起", async () => {
  const fake = fakeServer([row(1, "第一段", "01"), row(2, "第二段", "02")]);
  const { container } = await mount(fake);

  // 静止态没有批量条；复选框在 DOM 里，显形与否由 CSS 的悬停/聚焦规则决定。
  expect(barOf(container)).toBeNull();
  expect(selectOf(container, id(1))?.checked).toBe(false);

  await toggleRow(container, id(1));
  expect(barText(container)).toContain("已选 1 段讨论");
  await toggleRow(container, id(2));
  expect(barText(container)).toContain("已选 2 段讨论");
  // 选择是纯客户端状态：一条命令都不发，行也不动。
  expect(fake.posts).toEqual([]);
  expect(rowInActiveList(container, id(1))).not.toBeNull();
  expect(selectOf(container, id(2))?.checked).toBe(true);

  await clickBar(container, "recent-work-selection-clear");
  expect(barOf(container)).toBeNull();
  expect(selectOf(container, id(1))?.checked).toBe(false);
  expect(selectOf(container, id(2))?.checked).toBe(false);
  expect(fake.posts).toEqual([]);
});

it("批量删除逐段发命令、各带读回来的修订；成功后行消失、选择集清空", async () => {
  const fake = fakeServer([row(1, "要删的甲", "01"), row(2, "要删的乙", "02")]);
  const { container } = await mount(fake);
  await toggleRow(container, id(1));
  await toggleRow(container, id(2));

  await clickBar(container, "recent-work-batch-delete");
  // 第一步只是就地确认：命令一条都没发。
  expect(barText(container)).toContain("删除这 2 段讨论？");
  expect(barText(container)).toContain("永久移除");
  expect(fake.posts).toEqual([]);

  await clickBar(container, "recent-work-batch-delete-confirm");
  expect(fake.posts).toHaveLength(2);
  expect(fake.posts.map((post) => post.action)).toEqual(["delete", "delete"]);
  // 一段一条独立命令：command_id 不复用，expected_revision 是那一行读回来的修订。
  expect(new Set(fake.posts.map((post) => post.command_id)).size).toBe(2);
  expect(fake.posts.every((post) => post.expected_revision === "1")).toBe(true);
  expect(rowInActiveList(container, id(1))).toBeNull();
  expect(rowInActiveList(container, id(2))).toBeNull();
  expect(barOf(container)).toBeNull();
  expect(fake.rows).toEqual([]);
});

it("被引用阻止的那段留在列表与选择集里，其余照删，说明逐条列出并指向归档", async () => {
  const fake = fakeServer([row(1, "被引用的", "01"), row(2, "可以删的", "02")],
    { deleteBlockedIds: [id(1)] });
  const { container } = await mount(fake);
  await toggleRow(container, id(1));
  await toggleRow(container, id(2));
  await clickBar(container, "recent-work-batch-delete");
  await clickBar(container, "recent-work-batch-delete-confirm");

  expect(fake.posts).toHaveLength(2);
  expect(rowInActiveList(container, id(1))).not.toBeNull();
  expect(rowInActiveList(container, id(2))).toBeNull();
  const alert = container.querySelector('[data-testid="recent-work-batch-error"]');
  expect(alert?.textContent).toContain("已删除 1 段讨论");
  expect(alert?.textContent).toContain("被任务验收观察引用");
  expect(alert?.textContent).toContain("归档");
  // 失败的那段仍勾着（用户可以回去归档后再删）；业务拒绝不是结果不明，确认键不锁死。
  expect(selectOf(container, id(1))?.checked).toBe(true);
  expect(barText(container)).toContain("已选 1 段讨论");
  expect(barButton(container, "recent-work-batch-delete")?.disabled).toBe(false);
});

it("同因被阻止的多段合并成一句：原因只出现一次，同名标题按段数报", async () => {
  const fake = fakeServer([row(1, "关于Relay-Agent", "01"), row(2, "关于Relay-Agent", "02"),
    row(3, "关于Relay-Agent", "03")], { deleteBlockedIds: [id(1), id(2), id(3)] });
  const { container } = await mount(fake);
  for (const n of [1, 2, 3]) await toggleRow(container, id(n));
  await clickBar(container, "recent-work-batch-delete");
  await clickBar(container, "recent-work-batch-delete-confirm");

  expect(fake.posts).toHaveLength(3);
  const text = (container.querySelector('[data-testid="recent-work-batch-error"]')?.textContent ?? "")
    .replace(/\s+/gu, " ");
  expect(text).toContain("已删除 0 段讨论");
  // 三条同名、同一阻断原因：标题去重后按段数报，原因写在括号里。
  expect(text).toContain("「关于Relay-Agent」等 3 段还不能删除（被任务验收观察引用、有学习记录）");
  // 整句与建议都不按条数重复（2026-10-20 用户截图指认的正是这三遍红字）。
  expect(text.split("还不能删除").length - 1).toBe(1);
  expect(text.split("先改为归档").length - 1).toBe(1);
  expect(selectOf(container, id(1))?.checked).toBe(true);
});

it("批量删除的回执对不上时锁死确认键：不换 command_id 重发，勾选保留", async () => {
  const fake = fakeServer([row(1, "回执不明", "01")], { deleteReceiptCarriesForeignCommandId: true });
  const { container } = await mount(fake);
  await toggleRow(container, id(1));
  await clickBar(container, "recent-work-batch-delete");
  await clickBar(container, "recent-work-batch-delete-confirm");

  expect(fake.posts).toHaveLength(1);
  const alert = container.querySelector('[data-testid="recent-work-batch-error"]');
  expect(alert?.textContent).toContain("是否已删除尚未确定");
  // 行与勾选都留着：本次是否删掉未定，界面不替用户猜。
  expect(selectOf(container, id(1))?.checked).toBe(true);

  // 再点一次「删除」只进确认态；确认键已锁死，点下去也不会多发一条命令。
  await clickBar(container, "recent-work-batch-delete");
  const confirm = barButton(container, "recent-work-batch-delete-confirm");
  expect(confirm?.disabled).toBe(true);
  await act(async () => { confirm?.click(); });
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 20)); });
  expect(fake.posts).toHaveLength(1);
});
