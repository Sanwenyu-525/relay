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
  /**
   * 0111 的活动键：只用于排序，不再承担「有没有消息」的判断（2026-10-24 起）。
   * 行上的「未开始」标记与菜单里的「分叉」改读服务端读时派生的 `has_messages`。
   */
  last_message_at: string | null;
  /** 服务端读时派生：这段讨论有没有消息（直接数消息表）。 */
  has_messages: boolean;
  /** 0157：标题来源与最近一次生成请求；缺省按 LEGACY / null 读（旧服务端行为）。 */
  title_source?: string;
  title_generation?: Record<string, unknown> | null;
}

const row = (n: number, title: string, at: string): Row => ({
  id: id(n), project_id: null, task_id: null, title, status: "ACTIVE", revision: "1",
  pinned_at: null, unread_at: null,
  created_at: `2026-10-0${n}T${at}:00Z`, updated_at: `2026-10-0${n}T${at}:00Z`,
  last_message_at: `2026-10-0${n}T${at}:00Z`, has_messages: true
});

/** 还没有落过一条消息的会话：除活动键与派生事实外与普通行同形（这正是它难分辨的地方）。 */
const emptyRow = (n: number, title: string, at: string): Row =>
  ({ ...row(n, title, at), last_message_at: null, has_messages: false });

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

/**
 * 假服务端里导出的默认文档：只带界面会核对的那几列（format／schema_version／session.id／
 * messages／exported_at）。导出正文的十九个段落由服务端投影决定，测试不重复声明它，
 * 也不靠它排版——这正是客户端不建第二份类型的事实源。
 */
function exportBodyOf(target: Row | undefined, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    format: "relay-session-export", schema_version: "1.0",
    exported_at: "2026-11-01T12:00:00.000Z",
    session: { id: target?.id ?? null, title: target?.title ?? "", status: target?.status ?? "ACTIVE",
      revision: target?.revision ?? "1" },
    messages: [{ id: "message-1", role: "USER" }, { id: "message-2", role: "ASSISTANT" }],
    ...extra
  };
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
  /** 删除命令真的删了行，回执却对不上那一枚 command_id：客户端必须按原 ID 查回执再下结论。 */
  deleteReceiptCarriesForeignCommandId?: boolean;
  /** 删除命令返回 500：命令没落库，回执也查不到——结果只能是「待核实」。 */
  deleteServerError?: boolean;
  /** 只有这几条什么都没做就返回 500（服务端确实没提交）：其余照常删除。 */
  deleteServerErrorIds?: readonly string[];
  /**
   * 这几条：命令与回执在服务端同一事务里提交成功，**响应却丢了**（界面只看到 500）。
   * 服务端行已消失、回执可查；客户端按原 command_id 核对到已删之后，这一行必须从列表里
   * 真正收掉，而不只是改统计（2026-11-01 独立验收发现的 P1）。
   */
  deleteResponseLostIds?: readonly string[];
  /**
   * 这几条是 P1 的正主：服务端真的删成功了（行已没、回执已在同一事务里写入），
   * 但响应丢失，且删除时那一次自动核对**还查不到回执**——事务此刻尚未对外可见。
   * 于是界面只能停在「待核实」；用户点「核对回执」时的第二次查才拿到回执。
   * 核对到已删之后，这一行（含它在归档段里的那一份）与勾选必须一起收掉。
   */
  deleteReceiptFoundOnlyOnRecheckIds?: readonly string[];
  /**
   * `/export` 那一发的行为（2026-11-01 会话导出）。这里只需要三种：给一份文档、给一个失败、
   * 给一个还不回来的请求。缺省文档见 `exportBodyOf`。
   */
  exportExtra?: Record<string, unknown>;
  /** 导出返回这个状态与问题体（404、500…）：验证失败说的是真实原因，且没有落任何文件。 */
  exportFailure?: { status: number; code?: string; detail?: string; request_id?: string };
  /** 导出请求挂着不返回：这一条自己进入「导出中…」，⋯ 与行上别的命令不该跟着锁死。 */
  exportHang?: boolean;
  /**
   * 0157 重新生成标题：命令受理后，第一次重读这条会话时落定的结果。
   * `FAILED` 用来验证失败反馈与原标题保留，不在这里调用任何模型。
   */
  titleRegeneration?: { readonly title: string; readonly errorCode: string | null } } = {}): Fake {
  const posts: Record<string, unknown>[] = [];
  const reads: string[] = [];
  let conflicted = false;
  // 已落库的命令回执：按 command_id 存，客户端按原 ID 查回执时从这里取。
  const receipts = new Map<string, { command_type: string; result: Record<string, unknown> }>();
  // 同一枚回执被查了几次：`deleteReceiptFoundOnlyOnRecheckIds` 靠它把第一次核对挡成查不到。
  const receiptReads = new Map<string, number>();
  // 哪些命令属于「当场查不到、第二次才查得到」那一类。
  const receiptNotYetVisible = new Set<string>();
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
    const command = /\/assist-sessions\/([^/]+)\/(title\/generate|title|pin|unread|archive|reopen|fork|delete)$/u.exec(path);
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
        if (options.deleteServerError === true
          || (options.deleteServerErrorIds ?? []).includes(target.id)) {
          // 服务端内部错误：命令没有落库，回执也查不到——是否生效未知。
          return json({ code: "INTERNAL_ERROR", detail: "请求未能完成，请通过 request_id 在本机日志中核对。",
            request_id: "req-delete-500" }, 500);
        }
        rows.splice(rows.indexOf(target), 1);
        const result = { session_id: target.id, revision: target.revision,
          deleted_messages: 2, deleted_attachments: 0,
          deleted_at: "2026-10-18T08:00:00.000Z" };
        // 回执按**我们发出去的那一枚 command_id** 存：客户端核对回执时按原 ID 查。
        const commandId = String(body.command_id);
        receipts.set(commandId, { command_type: "DeleteAssistSession", result });
        if ((options.deleteReceiptFoundOnlyOnRecheckIds ?? []).includes(target.id)) {
          // 同上，但删除时那一次自动核对还查不到——只有用户点「核对回执」的第二次查才拿到。
          receiptNotYetVisible.add(commandId);
          return json({ code: "INTERNAL_ERROR", detail: "请求未能完成，请通过 request_id 在本机日志中核对。",
            request_id: "req-delete-racing" }, 500);
        }
        if ((options.deleteResponseLostIds ?? []).includes(target.id)) {
          // 服务端这一发真的提交了（行已没、回执已写），响应却在回来的路上丢了：500。
          return json({ code: "INTERNAL_ERROR", detail: "请求未能完成，请通过 request_id 在本机日志中核对。",
            request_id: "req-delete-lost" }, 500);
        }
        if (options.deleteReceiptCarriesForeignCommandId === true) {
          return json({ command_id: "00000000-0000-4000-8000-000000000000",
            committed_at: "2026-10-18T08:00:00Z", result });
        }
        return json({ ...committed, result });
      }
      if (action === "title") {
        target.title = String(body.title);
        target.title_source = "USER_DEFINED";
        bump(target);
        return json({ ...committed, result: { session_id: target.id, title: target.title,
          revision: target.revision, updated_at: target.updated_at } });
      }
      if (action === "title/generate") {
        // 受理请求：只写一条 PENDING 投影，标题一个字符都不改。
        target.title_generation = { status: "PENDING", request_kind: "REGENERATE",
          generator: null, error_code: null, requested_at: "2026-11-01T12:00:00.000Z",
          settled_at: null };
        return json({ ...committed, result: { session_id: target.id,
          request_id: "99999999-9999-4999-8999-999999999999", status: "PENDING",
          revision: target.revision, requested_at: "2026-11-01T12:00:00.000Z" } });
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
    const exportPath = /\/assist-sessions\/([^/]+)\/export$/u.exec(path);
    if (exportPath !== null) {
      const target = find(String(exportPath[1]));
      reads.push(`export:${String(exportPath[1])}`);
      if (options.exportHang === true) return new Promise<Response>(() => {});
      if (options.exportFailure !== undefined) {
        const { status, code, detail, request_id } = options.exportFailure;
        // 未注册路由的 404 不带 Relay code（服务端给的是裸 HTTP_ERROR），与「这条会话不可见」不同因。
        return json({ code, detail, request_id }, status);
      }
      if (target === undefined) return json({ code: "RESOURCE_NOT_FOUND", detail: "gone" }, 404);
      return json(exportBodyOf(target, options.exportExtra));
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
      // 标题生成在途：本次轮询就是它落定的一拍。模型结果由测试声明，
      // 失败时不改标题——与服务端「保留原标题」的口径一致。
      if (target.title_generation?.status === "PENDING" && options.titleRegeneration !== undefined) {
        const settled = options.titleRegeneration;
        target.title_generation = { status: settled.errorCode === null ? "COMPLETED" : "FAILED",
          request_kind: "REGENERATE", generator: settled.errorCode === null ? "MODEL" : null,
          error_code: settled.errorCode, requested_at: "2026-11-01T12:00:00.000Z",
          settled_at: "2026-11-01T12:00:02.000Z" };
        if (settled.errorCode === null) { target.title = settled.title; bump(target); }
      }
      return json(target);
    }
    if (path.endsWith("/projects")) return json({ items: [], next_cursor: null });
    // 命令回执：按原 command_id 查。查不到就是 404（服务端口径：查不到不能证明从未提交）。
    const receipt = /\/commands\/([^/]+)$/u.exec(path);
    if (receipt !== null) {
      reads.push("receipt");
      const key = String(receipt[1]);
      const seen = (receiptReads.get(key) ?? 0) + 1;
      receiptReads.set(key, seen);
      const found = receipts.get(key);
      // 命令已在服务端提交，但删除时那一次自动核对撞上的是「事务还没对外可见」：第一次查不到。
      if (found !== undefined && receiptNotYetVisible.has(key) && seen === 1) {
        return json({ code: "COMMAND_NOT_FOUND", detail: "没有这条回执" }, 404);
      }
      if (found === undefined) return json({ code: "COMMAND_NOT_FOUND", detail: "没有这条回执" }, 404);
      return json({ command_id: key, command_type: found.command_type,
        committed_at: "2026-10-18T08:00:00Z", result: found.result });
    }
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

/** 标题生成的等待是真实计时（1s 一拍）：这里不伪造时钟，只等它真的跑完一拍。 */
async function wait(ms: number): Promise<void> {
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, ms)); });
}

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

it("还没有消息的会话：行上标「未开始」，菜单里没有分叉（2026-10-24）", async () => {
  // 两条同标题的空会话正是用户截图里的形态：11:39 建会话、首条消息没落地，12:30 又分叉出（1）。
  const fake = fakeServer([emptyRow(1, "关于Relay-Agent", "01"), row(2, "说过话的讨论", "02")]);
  const { container } = await mount(fake);

  // 标记只出现在空会话那一行：说过话的行不受影响，标题可用宽与改造前一致。
  expect(rowOf(container, id(1))?.querySelector('[data-testid="recent-work-not-started"]')?.textContent)
    .toBe("未开始");
  expect(rowOf(container, id(2))?.querySelector('[data-testid="recent-work-not-started"]')).toBeNull();
  // 状态同时进可访问名称：不靠颜色、也不只靠视觉标记。
  expect(container.querySelector(`[data-testid="recent-work-${id(1)}"]`)?.getAttribute("aria-label"))
    .toContain("未开始");

  // 没有可搬的历史，服务端只会拒绝：这一项干脆不出现，与归档态只留「重开」同一先例。
  await openMenu(container, id(1));
  const actions = [...panelOf(container, id(1))!.querySelectorAll(".recent-work-row-action")]
    .map((button) => (button.textContent ?? "").trim());
  expect(actions).not.toContain("分叉这段讨论");
  expect(actions).toContain("重命名");

  // 说过话的那一条照旧能分叉：判据是消息事实，不是「这一列里有没有空会话」。
  await openMenu(container, id(2));
  expect([...panelOf(container, id(2))!.querySelectorAll(".recent-work-row-action")]
    .map((button) => (button.textContent ?? "").trim())).toContain("分叉这段讨论");
});

it("活动键为空但确有消息：不标「未开始」且照常可分叉（读时派生的事实，2026-10-24 用户确认）", async () => {
  // 历史缺陷的形态：0111 之前的会话有消息、活动键却是 NULL。标记与分叉必须信消息表的派生事实，
  // 否则同一条会话会在左栏说「未开始」、点进去却有正文（用户截图指认的那处自相矛盾）。
  const drifted: Row = { ...row(1, "活动键漏推进的讨论", "01"), last_message_at: null, has_messages: true };
  const fake = fakeServer([drifted, emptyRow(2, "真的空会话", "02")]);
  const { container } = await mount(fake);

  expect(rowOf(container, id(1))?.querySelector('[data-testid="recent-work-not-started"]')).toBeNull();
  expect(container.querySelector(`[data-testid="recent-work-${id(1)}"]`)?.getAttribute("aria-label"))
    .not.toContain("未开始");
  // 确有历史，分叉入口照常出现；空会话那一条仍不出现。
  await openMenu(container, id(1));
  expect([...panelOf(container, id(1))!.querySelectorAll(".recent-work-row-action")]
    .map((button) => (button.textContent ?? "").trim())).toContain("分叉这段讨论");
  expect(rowOf(container, id(2))?.querySelector('[data-testid="recent-work-not-started"]')?.textContent)
    .toBe("未开始");
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
  // 归档态只留「重开 + 导出 + 删除」：重命名/置顶/分叉都得先重开；删除与归档是两条通道，不因归档被挡住。
  // 导出留在这一态（任务书 §二）：要拿去外部分析的往往正是已经结束、需要复盘的那一段。
  expect([...(panelOf(container, id(1))?.querySelectorAll("button") ?? [])]
    .map((button) => (button.textContent ?? "").trim())).toEqual(["重开这段讨论", "导出会话", "删除"]);
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
    .map((button) => (button.textContent ?? "").trim())).toEqual(["置顶", "重命名", "重新生成标题", "取消未读", "分叉这段讨论", "复制会话 ID", "导出会话", "归档", "删除"]);
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

/**
 * 一次导出要拦住的两样东西（jsdom 既没有 `createObjectURL`，也不会真的导航下载）。
 *
 * 这里记录的是**交出去的文件名与正文**——浏览器/WebView2 把它存成什么、撞名时怎么改名，
 * 属于本机实机验收（任务书 §六），不是这几条断言能证明的。
 */
function stubDownload(): { readonly names: string[]; readonly blobs: Blob[]; restore: () => void } {
  const names: string[] = [];
  const blobs: Blob[] = [];
  Object.defineProperty(URL, "createObjectURL", { configurable: true,
    value: (blob: Blob) => { blobs.push(blob); return `blob:export-${blobs.length}`; } });
  Object.defineProperty(URL, "revokeObjectURL", { configurable: true, value: () => {} });
  Object.defineProperty(HTMLAnchorElement.prototype, "click", { configurable: true,
    value: function anchorClick(this: HTMLAnchorElement) { names.push(this.download); } });
  return { names, blobs, restore: () => {
    // 三个都是本用例加上去的自有属性：jsdom 里 `click` 长在 HTMLElement.prototype 上，
    // 因此还原方式是 delete，让锚点重新落回继承来的那一个。
    delete (URL as unknown as Record<string, unknown>).createObjectURL;
    delete (URL as unknown as Record<string, unknown>).revokeObjectURL;
    delete (HTMLAnchorElement.prototype as unknown as Record<string, unknown>).click;
  } };
}

const exportItemOf = (container: HTMLElement, sessionId: string) =>
  panelOf(container, sessionId)?.querySelector<HTMLButtonElement>(`[data-testid="recent-work-export-${sessionId}"]`);

it("导出会话是一次只读 GET：不发命令、不重读、不推进修订，落盘文件名与提示都取服务端给的那一份", async () => {
  const download = stubDownload();
  try {
    const fake = fakeServer([row(1, "要拿去做复盘的讨论", "01")]);
    const { container } = await mount(fake);
    const sessionId = id(1);
    await openMenu(container, sessionId);
    // 落盘之前先读得到的隐私说明（任务书 §五）：这句话必须在点下去之前就在条目上。
    expect(exportItemOf(container, sessionId)?.title).toContain("消息正文按原文保留");
    await clickAction(container, sessionId, "导出会话");

    // 只读：一条命令都没发，也不回头重读这一行，行上的修订与更新时间原样不动。
    expect(fake.posts).toEqual([]);
    expect(fake.reads.filter((read) => read.startsWith("single:"))).toEqual([]);
    expect(fake.reads.filter((read) => read.startsWith("export:"))).toEqual([`export:${sessionId}`]);
    expect(fake.rows[0]?.revision).toBe("1");
    expect(fake.rows[0]?.updated_at).toBe("2026-10-01T01:00Z");

    // 日期取自文档里的 exported_at，不是界面上的今天；正文是服务端投影原文，界面不重拼。
    expect(download.names).toEqual(["Relay-要拿去做复盘的讨论-20261101.json"]);
    expect(await download.blobs[0]?.text()).toContain("relay-session-export");

    // 成功反馈报出文件名，并且活得比面板久：面板一收起，「叫什么」这句话就没了可读的地方。
    expect(document.querySelector(`[data-testid="session-export-done-${sessionId}"]`)?.textContent)
      .toContain("Relay-要拿去做复盘的讨论-20261101.json");
    // 导出没改动这一行，因此不收起浮层、也不换成「已导出」之外的第二种说法。
    expect(panelOf(container, sessionId)).not.toBeNull();
    expect((exportItemOf(container, sessionId)?.textContent ?? "").trim()).toBe("已导出会话");
  } finally { download.restore(); }
});

it("导出进行中只锁这一条自己：⋯ 与面板里别的动作照旧可用，请求没回来之前不落任何文件", async () => {
  const download = stubDownload();
  try {
    const fake = fakeServer([row(1, "正在导出的讨论", "01")], { exportHang: true });
    const { container } = await mount(fake);
    const sessionId = id(1);
    await openMenu(container, sessionId);
    const item = exportItemOf(container, sessionId)!;
    await act(async () => { item.click(); });

    // 等待期间这一条读作不可用，但仍是可聚焦的原生 button：`disabled` 会把键盘焦点丢到 body，
    // 后续 Esc 就再送不到面板（2026-11-01 真实 Chromium 键盘用例实测）。
    expect(item.getAttribute("aria-disabled")).toBe("true");
    expect(item.disabled).toBe(false);
    expect((item.textContent ?? "").trim()).toBe("导出中…");
    // 重复激活由守卫挡住：请求还挂着，第二次点不会再发一发。
    await act(async () => { item.click(); });
    expect(fake.reads.filter((read) => read.startsWith("export:"))).toHaveLength(1);
    // 等待走的是这一条自己的状态，不是命令用的 `busy`：一次读取不该把整行——包括归档和删除——锁住。
    expect(menuOf(container, sessionId)?.disabled).toBe(false);
    const others = [...(panelOf(container, sessionId)?.querySelectorAll("button") ?? [])]
      .filter((button) => button !== item);
    expect(others).toHaveLength(8);
    expect(others.every((button) => !button.disabled)).toBe(true);
    // 一个文件都没交出去：正文此刻还不存在，提前落盘就是一个空 JSON。
    expect(download.names).toEqual([]);
  } finally { download.restore(); }
});

it("导出失败把真实原因就地说出来：不落文件、不给成功提示，条目从等待态回到可再试一次", async () => {
  const download = stubDownload();
  try {
    const fake = fakeServer([row(1, "导不动的讨论", "01")], {
      exportFailure: { status: 500, code: "INTERNAL_ERROR",
        detail: "请求未能完成，请通过 request_id 在本机日志中核对。", request_id: "req-export-500" } });
    const { container } = await mount(fake);
    const sessionId = id(1);
    await openMenu(container, sessionId);
    await clickAction(container, sessionId, "导出会话");

    // 说的是服务端给的那一句 + 追溯号，不是笼统的「导出失败」。
    const alert = panelOf(container, sessionId)?.querySelector('[role="alert"]');
    expect(alert?.textContent).toContain("req-export-500");
    // 读取没有命令、也没有回执：这句话不能把人指向一条根本不存在的 command ID。
    expect(alert?.textContent).not.toMatch(/command|回执/u);
    expect(alert?.textContent).toContain("没有产生任何改动");
    expect(download.names).toEqual([]);
    expect(document.querySelector(`[data-testid="session-export-done-${sessionId}"]`)).toBeNull();
    // 失败之后这一条自己回到可点：不锁死、也不留下一个已经过期的「导出中…」。
    expect(exportItemOf(container, sessionId)?.disabled).toBe(false);
    expect((exportItemOf(container, sessionId)?.textContent ?? "").trim()).toBe("导出会话");
    expect(fake.posts).toEqual([]);
    expect(fake.rows[0]?.revision).toBe("1");
  } finally { download.restore(); }
});

it("导出撞上没注册路由的 404 时说清两种可能，并且同样没有产生文件", async () => {
  const download = stubDownload();
  try {
    // 裸 404（服务端没有 Relay code）＝这个 URL 上根本没有这条路由，与「会话不可见」不是一回事。
    const fake = fakeServer([row(1, "连着旧 API 的讨论", "01")], {
      exportFailure: { status: 404, detail: "请求的路径在当前服务上不存在。" } });
    const { container } = await mount(fake);
    const sessionId = id(1);
    await openMenu(container, sessionId);
    await clickAction(container, sessionId, "导出会话");

    const alert = panelOf(container, sessionId)?.querySelector('[role="alert"]');
    expect(alert?.textContent).toContain("导出接口返回了未注册路由的 404");
    expect(alert?.textContent).toContain("导出没有产生任何文件");
    expect(download.names).toEqual([]);
  } finally { download.restore(); }
});

it("服务端在 completeness 里声明了截断，成功提示必须跟着说这是部分导出", async () => {
  const download = stubDownload();
  try {
    const fake = fakeServer([row(1, "很长的讨论", "01")], {
      exportExtra: { completeness: { messages: { truncated: true, exported: 2000, limit: 2000 } } } });
    const { container } = await mount(fake);
    const sessionId = id(1);
    await openMenu(container, sessionId);
    await clickAction(container, sessionId, "导出会话");

    const toast = document.querySelector(`[data-testid="session-export-done-${sessionId}"]`);
    expect(toast?.textContent).toContain("部分导出");
    // 残缺说清楚去哪看，而不是把「少了一段」含糊成「导出成功」。
    expect(toast?.textContent).toContain("completeness");
    expect(await download.blobs[0]?.text()).toContain("\"truncated\": true");
    expect(fake.posts).toEqual([]);
  } finally { download.restore(); }
});

it("归档段里那条同样给导出：它排在删除之前，导出既不改动状态也不发命令", async () => {
  const download = stubDownload();
  try {
    const fake = fakeServer([{ ...row(1, "要复盘的归档讨论", "01"), status: "ARCHIVED" }]);
    const { container } = await mount(fake);
    const sessionId = id(1);
    const archivedSection = container.querySelector<HTMLDetailsElement>('[data-testid="recent-work-archived"]')!;
    await act(async () => { archivedSection.open = true;
      archivedSection.dispatchEvent(new Event("toggle", { bubbles: true })); });
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 20)); });

    await openMenu(container, sessionId);
    // 归档态的菜单：重开在前，导出紧随其后，细线之后才是唯一那个不可逆动作。
    expect([...(panelOf(container, sessionId)?.querySelectorAll("button") ?? [])]
      .map((button) => (button.textContent ?? "").trim()))
      .toEqual(["重开这段讨论", "导出会话", "删除"]);

    await clickAction(container, sessionId, "导出会话");
    expect(fake.posts).toEqual([]);
    expect(download.names).toEqual(["Relay-要复盘的归档讨论-20261101.json"]);
    // 导出是读取：归档还是归档，这一行的状态与修订都没被这次点击碰过。
    expect(fake.rows[0]?.status).toBe("ARCHIVED");
    expect(fake.rows[0]?.revision).toBe("1");
  } finally { download.restore(); }
});

it("导出条目可聚焦、成功后 Esc 仍把焦点交回 ⋯", async () => {
  const download = stubDownload();
  try {
    const fake = fakeServer([row(1, "键盘走一遍的讨论", "01")]);
    const { container } = await mount(fake);
    const sessionId = id(1);
    const trigger = menuOf(container, sessionId)!;
    await openMenu(container, sessionId);
    const item = exportItemOf(container, sessionId)!;
    // 面板里的动作是原生 button，没有 tabindex="-1"：Tab 走到它，Enter/Space 由浏览器默认触发。
    expect(item.getAttribute("tabindex")).toBeNull();
    await act(async () => { item.focus(); });
    expect(document.activeElement).toBe(item);
    await act(async () => { item.click(); });
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 20)); });
    expect(download.names).toHaveLength(1);

    const panel = panelOf(container, sessionId)!;
    await act(async () => { panel.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })); });
    expect(panelOf(container, sessionId)).toBeNull();
    expect(document.activeElement).toBe(trigger);
    // 面板收起来了，成功提示仍在页壳上：这句话不靠浮层活着。
    expect(document.querySelector(`[data-testid="session-export-done-${sessionId}"]`)).not.toBeNull();
  } finally { download.restore(); }
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

it("动作按参考菜单分组成「图标 + 名称」：置顶／重命名／未读一组，分组细线之后复制身份、导出、归档与删除收尾", async () => {
  const fake = fakeServer([row(1, "分组结构", "01")]);
  const { container } = await mount(fake);
  const sessionId = id(1);
  await openMenu(container, sessionId);
  const panel = panelOf(container, sessionId)!;

  // 顺序与分组：置顶／重命名／未读／分叉在前，分组细线之后复制身份、导出、归档与删除收尾（参考菜单的两组读法）。
  // 导出紧跟复制会话 ID、排在归档与删除之前（2026-11-01 用户任务书 §二）：它和复制一样只是
  // 「取一份东西出去」，不该混在两个带不可逆读感的动作中间。
  expect([...panel.children].map((child) => child.getAttribute("role") === "separator"
    ? "separator" : (child.textContent ?? "").trim()))
    .toEqual(["置顶", "重命名", "重新生成标题", "标记为未读", "分叉这段讨论", "separator", "复制会话 ID", "导出会话", "归档", "删除"]);
  // 分组细线是 div 而不是 button：不吃焦点、不参与命令，只作视觉分隔。
  expect(panel.querySelector('[role="separator"]')?.tagName).toBe("DIV");
  // 九条动作各带一枚前缀图标；图标不进 textContent，因此单独核对存在性。
  expect([...panel.querySelectorAll("button")].map((button) => button.querySelector("svg") !== null))
    .toEqual([true, true, true, true, true, true, true, true, true]);
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

it("被其它对象引用时删除整条拒绝：原因逐条列出并给出可执行动作，行不动、不发第二发", async () => {
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
  const alert = document.querySelector(`[data-testid="session-delete-close-${sessionId}"]`)
    ?.closest(".recent-work-row-panel")?.querySelector('[role="alert"]');
  // 阻止项按可读中文逐条列出，并给出**真正能做的动作**（不是一句「先改为归档」糊弄过去）。
  expect(alert?.textContent).toContain("被任务验收观察引用");
  expect(alert?.textContent).toContain("有学习记录");
  expect(alert?.textContent).toContain("先在任务里解除对这条消息的验收引用");
  expect(alert?.textContent).toContain("先在学习页清空这段讨论的评估记录");
  // 业务拒绝是终态：不再摆一颗「删除」，避免让人再点一次同一个必然被拒绝的动作。
  expect(document.querySelector(`[data-testid="session-delete-confirm-${sessionId}"]`)).toBeNull();
  expect(document.querySelector(`[data-testid="session-delete-close-${sessionId}"]`)).not.toBeNull();
});

it("回执对不上时按原 command_id 核对：核对到已删就当已删，不重发", async () => {
  const fake = fakeServer([row(1, "回执不明", "01")], { deleteReceiptCarriesForeignCommandId: true });
  const { container } = await mount(fake);
  const sessionId = id(1);

  await openMenu(container, sessionId);
  await clickAction(container, sessionId, "删除");
  await act(async () => {
    document.querySelector<HTMLButtonElement>(`[data-testid="session-delete-confirm-${sessionId}"]`)!.click();
  });
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 20)); });

  // 一条删除命令 + 一次按原 ID 的回执核对；没有换 command_id 重发。
  expect(fake.posts).toHaveLength(1);
  expect(fake.reads).toContain("receipt");
  // 回执核对到「这条删除确实提交了」：行消失，浮层收起。
  expect(rowInActiveList(container, sessionId)).toBeNull();
  expect(document.querySelector(`[data-testid="session-delete-close-${sessionId}"]`)).toBeNull();
});

it("服务端 500 且查不到回执时停在待核实：不宣称成功也不宣称失败，只留核对回执", async () => {
  const fake = fakeServer([row(1, "结果未知", "01")], { deleteServerError: true });
  const { container } = await mount(fake);
  const sessionId = id(1);

  await openMenu(container, sessionId);
  await clickAction(container, sessionId, "删除");
  await act(async () => {
    document.querySelector<HTMLButtonElement>(`[data-testid="session-delete-confirm-${sessionId}"]`)!.click();
  });
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 20)); });

  expect(fake.posts).toHaveLength(1);
  // 行还在（服务端没删成功），但也不能说「删除失败」——回执尚未查到。
  expect(rowInActiveList(container, sessionId)).not.toBeNull();
  const panel = document.querySelector(`[data-testid="session-delete-close-${sessionId}"]`)
    ?.closest(".recent-work-row-panel");
  expect(panel?.textContent).toContain("删除结果待核实");
  expect(panel?.textContent).toContain("还没有确定");
  // 只有核对回执与关闭：没有「删除」键，也就没有第二次确认。
  expect(document.querySelector(`[data-testid="session-delete-confirm-${sessionId}"]`)).toBeNull();
  expect(document.querySelector(`[data-testid="session-delete-recheck-${sessionId}"]`)).not.toBeNull();
  // 原始追溯号只在技术详情里，不进主提示句。
  expect(panel?.querySelector(".recent-work-delete-detail")?.textContent).toContain("req-delete-500");
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
    .toEqual(["重开这段讨论", "导出会话", "separator", "删除"]);
  await clickAction(container, sessionId, "删除");
  expect(document.querySelector(`[data-testid="session-delete-confirm-${sessionId}"]`)).not.toBeNull();
  expect(fake.posts.map((post) => post.action)).toEqual(["archive"]);
});

/* ---------------------------------------------------------------------------------------------
 * 会话行的批量选择复选框（2026-10-20 用户指令「给会话 item 加一个复选框，方便删除记录」）。
 *
 * 这里守五条口径，都是「删除不可撤销」这条业务事实的延伸：
 * 1. **选择只是选择。** 勾选不发命令、不动行；只有确认那一下才发删除。
 * 2. **一段一条命令。** 批量不是新端点：每段各取 command_id、各带读回来的修订，不假装原子。
 * 3. **部分成功要如实报。** 被引用阻止的那条留在列表里并留在选择集里，同一原因只写一次。
 * 4. **结果只给一次。** 失败后停在结果态（DEV-0098），同一张确认卡片里读完原因就关闭，
 *    不退回带「删除」按钮的第三次确认；结果不明也不重发。
 * 5. **核对到已删就当已删，并且真的收掉那一行。** 结果未知只按**原 command_id** 查回执，
 *    不重发；查到已删之后行、分组副本、勾选、归档那一份都要一起消失，只改统计不算修完
 *    （2026-11-01 独立验收发现的 P1）。仍查不到的那条一行都不动。
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

it("被引用阻止的那段留在列表与选择集里，其余照删：结论一行、原因一次、可执行动作一次", async () => {
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
  const report = container.querySelector('[data-testid="recent-work-batch-error"]');
  // 顶层只有一行结论：删了几段、没删掉几段、待核实几段。
  expect(container.querySelector('[data-testid="recent-work-batch-summary"]')?.textContent)
    .toContain("已删除 1 段");
  expect(container.querySelector('[data-testid="recent-work-batch-summary"]')?.textContent)
    .toContain("1 段未删除");
  expect(report?.textContent).toContain("被任务验收观察引用");
  // 原因只写一次，并且给出真正能做的动作。
  expect((report?.textContent ?? "").split("被任务验收观察引用").length - 1).toBe(1);
  expect(report?.textContent).toContain("先在任务里解除对这条消息的验收引用");
  // 失败的那段仍勾着（用户可以回去处理引用后再删）；结果态不再提供第二次删除确认。
  expect(selectOf(container, id(1))?.checked).toBe(true);
  expect(barText(container)).toContain("删除结果");
  expect(barButton(container, "recent-work-batch-delete")).toBeNull();
  expect(barButton(container, "recent-work-batch-delete-confirm")).toBeNull();
  // 关闭即结束这一轮：勾选清空，卡片收起，不会再出现第三次确认。
  await clickBar(container, "recent-work-batch-result-close");
  expect(barOf(container)).toBeNull();
  expect(selectOf(container, id(1))?.checked).toBe(false);
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
  expect(container.querySelector('[data-testid="recent-work-batch-summary"]')?.textContent)
    .toContain("已删除 0 段");
  // 三条同名、同一阻断原因：标题去重后按段数报，原因写一次。
  expect(text).toContain("「关于Relay-Agent」等 3 段还不能删除：被任务验收观察引用、有学习记录");
  // 整句与建议都不按条数重复（2026-10-20 用户截图指认的正是这三遍红字）。
  expect(text.split("还不能删除").length - 1).toBe(1);
  expect(text.split("被任务验收观察引用").length - 1).toBe(1);
  expect(selectOf(container, id(1))?.checked).toBe(true);
  // 结果态是本轮唯一终态：不会退回「已选 3 段讨论 + 删除」的第三次确认。
  expect(barText(container)).toContain("删除结果");
  expect(barButton(container, "recent-work-batch-delete")).toBeNull();
  await clickBar(container, "recent-work-batch-result-close");
  expect(barOf(container)).toBeNull();
});

it("批量删除的回执对不上时按原 command_id 核对：核对到已删就当已删，不重发", async () => {
  const fake = fakeServer([row(1, "回执不明", "01")], { deleteReceiptCarriesForeignCommandId: true });
  const { container } = await mount(fake);
  await toggleRow(container, id(1));
  await clickBar(container, "recent-work-batch-delete");
  await clickBar(container, "recent-work-batch-delete-confirm");

  expect(fake.posts).toHaveLength(1);
  expect(fake.reads).toContain("receipt");
  // 回执核对到已提交：行消失，这一轮没有留下待核实的残项。
  expect(rowInActiveList(container, id(1))).toBeNull();
  expect(container.querySelector('[data-testid="recent-work-batch-error"]')).toBeNull();
  expect(barOf(container)).toBeNull();
});

it("批量删除里结果未知的那条停在待核实：不宣称成功也不宣称失败，只留核对回执", async () => {
  const fake = fakeServer([row(1, "结果未知", "01")], { deleteServerError: true });
  const { container } = await mount(fake);
  await toggleRow(container, id(1));
  await clickBar(container, "recent-work-batch-delete");
  await clickBar(container, "recent-work-batch-delete-confirm");

  expect(fake.posts).toHaveLength(1);
  const report = container.querySelector('[data-testid="recent-work-batch-error"]');
  expect(container.querySelector('[data-testid="recent-work-batch-summary"]')?.textContent)
    .toContain("1 段待核实");
  expect(report?.textContent).toContain("还没有确定");
  // 行与勾选都留着：本次是否删掉未定，界面不替用户猜。
  expect(rowInActiveList(container, id(1))).not.toBeNull();
  expect(selectOf(container, id(1))?.checked).toBe(true);
  // 结果态没有再次删除的入口；只有核对回执与关闭。
  expect(barButton(container, "recent-work-batch-delete")).toBeNull();
  expect(barButton(container, "recent-work-batch-delete-confirm")).toBeNull();
  expect(barButton(container, "recent-work-batch-recheck")).not.toBeNull();
  await clickBar(container, "recent-work-batch-result-close");
  expect(barOf(container)).toBeNull();
  expect(fake.posts).toHaveLength(1);
});

it("核对回执确认已删之后那一行真的收掉：部分成功、部分未知、被阻断的互不误伤", async () => {
  const fake = fakeServer([row(1, "被引用挡住", "01"), row(2, "响应丢了", "02"),
    row(3, "服务端没提交", "03"), row(4, "正常删除", "04")], {
    deleteBlockedIds: [id(1)],
    deleteReceiptFoundOnlyOnRecheckIds: [id(2)],
    deleteServerErrorIds: [id(3)]
  });
  const { container } = await mount(fake);
  for (const n of [1, 2, 3, 4]) await toggleRow(container, id(n));
  await clickBar(container, "recent-work-batch-delete");
  await clickBar(container, "recent-work-batch-delete-confirm");

  // 四条各走各的结局：一条当场删成，一条被跨对象引用挡住，两条结果未知——
  // 其中「响应丢了」那条在删除时已自动按原命令核对过一次，撞上回执还没对外可见。
  expect(fake.posts).toHaveLength(4);
  expect(container.querySelector('[data-testid="recent-work-batch-summary"]')?.textContent)
    .toBe("已删除 1 段，1 段未删除，2 段待核实");
  expect(rowInActiveList(container, id(4))).toBeNull();
  for (const n of [1, 2, 3]) {
    expect(rowInActiveList(container, id(n))).not.toBeNull();
    expect(selectOf(container, id(n))?.checked).toBe(true);
  }

  await clickBar(container, "recent-work-batch-recheck");
  // 核对只读取回执，一条删除命令都没有重发。
  expect(fake.posts).toHaveLength(4);
  // 已确认删掉的那条：行与勾选一起消失（分组副本派生自这两份列表，跟着没了）。
  expect(rowInActiveList(container, id(2))).toBeNull();
  expect(selectOf(container, id(2))).toBeNull();
  // 仍查不到回执的那条一行不动：既不改成成功，也不改成失败，继续留在待核实。
  expect(rowInActiveList(container, id(3))).not.toBeNull();
  expect(selectOf(container, id(3))?.checked).toBe(true);
  // 业务阻断的那条也原样留着：等用户回去解除引用，界面不替它猜结局。
  expect(rowInActiveList(container, id(1))).not.toBeNull();
  expect(container.querySelector('[data-testid="recent-work-batch-summary"]')?.textContent)
    .toBe("已删除 2 段，1 段未删除，1 段待核实");
  // 终态没变：还是这一张卡片，只有「核对回执」与「关闭」，没有第二次删除确认。
  expect(barText(container)).toContain("删除结果");
  expect(barButton(container, "recent-work-batch-delete")).toBeNull();
  expect(barButton(container, "recent-work-batch-delete-confirm")).toBeNull();
  expect(barButton(container, "recent-work-batch-recheck")).not.toBeNull();
});

it("批量里连归档段那条也一起核对掉：活跃与归档两份投影同时收行，核对完不再留待核实", async () => {
  const fake = fakeServer([row(1, "活跃里丢了响应", "01"),
    { ...row(2, "归档里丢了响应", "02"), status: "ARCHIVED" }],
    { deleteReceiptFoundOnlyOnRecheckIds: [id(1), id(2)] });
  const { container } = await mount(fake);
  const archivedSection = container.querySelector<HTMLDetailsElement>('[data-testid="recent-work-archived"]')!;
  await act(async () => { archivedSection.open = true;
    archivedSection.dispatchEvent(new Event("toggle", { bubbles: true })); });
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 20)); });
  await toggleRow(container, id(1));
  await toggleRow(container, id(2));
  await clickBar(container, "recent-work-batch-delete");
  await clickBar(container, "recent-work-batch-delete-confirm");

  // 两条都删到了服务端、两条都还查不到回执：结果未知时列表一行都不收。
  expect(fake.posts).toHaveLength(2);
  expect(container.querySelector('[data-testid="recent-work-batch-summary"]')?.textContent)
    .toBe("已删除 0 段，2 段待核实");
  expect(archivedSection.querySelector(`[data-testid="recent-work-${id(2)}"]`)).not.toBeNull();

  await clickBar(container, "recent-work-batch-recheck");
  expect(fake.posts).toHaveLength(2);
  // 移除按确切 sessionId 同时打在两份投影上：归档段里那一份不能留在原地当幽灵行。
  expect(rowInActiveList(container, id(1))).toBeNull();
  expect(selectOf(container, id(1))).toBeNull();
  expect(archivedSection.querySelector(`[data-testid="recent-work-${id(2)}"]`)).toBeNull();
  expect(archivedSection.querySelector(".recent-work-group-count")?.textContent).toBe("0");
  expect(selectOf(container, id(2))).toBeNull();
  // 全部核对到位 = 这一轮没有残项：与「批量删除全部成功」同一终态，提示卡片自己收起，
  // 不再留「核对回执」，也不留一句已经过期的大白话结论。
  expect(barButton(container, "recent-work-batch-recheck")).toBeNull();
  expect(barOf(container)).toBeNull();
});

/**
 * 0157 重新生成标题：回执只代表受理，界面必须等到读回终态才换标题。
 *
 * 这里守护三件事：手动命名先确认（初始焦点在取消）、受理后显示在途而不是成功、
 * 终态读回后行标题与成功提示同时出现。模型与落库由真实集成用例负责。
 */
it("重新生成标题：手动命名先确认，受理后经轮询把服务端的新标题落回这一行", async () => {
  const fake = fakeServer([
    { ...row(1, "我手动起的名字", "01"), title_source: "USER_DEFINED" }],
    { titleRegeneration: { title: "UI-聊天消息布局优化", errorCode: null } });
  const { container } = await mount(fake);
  await openMenu(container, id(1));
  await clickAction(container, id(1), "重新生成标题");

  // 手动命名：先说清会替换，初始焦点压在「取消」上。
  expect(panelOf(container, id(1))?.textContent).toContain("你当前手动设置的标题会被替换");
  expect(document.activeElement?.getAttribute("data-testid"))
    .toBe(`session-title-regenerate-cancel-${id(1)}`);
  await act(async () => {
    panelOf(container, id(1))?.querySelector<HTMLButtonElement>(
      `[data-testid="session-title-regenerate-confirm-${id(1)}"]`)?.click();
  });
  expect(fake.posts.filter((post) => post.action === "title/generate")).toHaveLength(1);
  // 受理不是成功：标题一个字符没变，面板就地说明还在等后台落定。
  expect(rowOf(container, id(1))?.querySelector(".recent-work-title")?.textContent)
    .toBe("我手动起的名字");
  expect(panelOf(container, id(1))?.querySelector(
    `[data-testid="recent-work-title-generating-${id(1)}"]`)).not.toBeNull();

  await wait(1200);
  expect(rowOf(container, id(1))?.querySelector(".recent-work-title")?.textContent)
    .toBe("UI-聊天消息布局优化");
  expect(document.querySelector(`[data-testid="session-title-regenerated-${id(1)}"]`)?.textContent)
    .toContain("已重新生成标题");
  expect(panelOf(container, id(1))).toBeNull();
});

it("重新生成标题失败：保留原标题并给出真实原因，不显示成功提示", async () => {
  const fake = fakeServer([row(1, "模型调不通的讨论", "01")],
    { titleRegeneration: { title: "不该出现的标题", errorCode: "TITLE_MODEL_UNAVAILABLE" } });
  const { container } = await mount(fake);
  await openMenu(container, id(1));
  await clickAction(container, id(1), "重新生成标题");
  expect(fake.posts.filter((post) => post.action === "title/generate")).toHaveLength(1);
  expect(rowOf(container, id(1))?.querySelector(".recent-work-title")?.textContent)
    .toBe("模型调不通的讨论");

  await wait(1200);
  expect(rowOf(container, id(1))?.querySelector(".recent-work-title")?.textContent)
    .toBe("模型调不通的讨论");
  expect(document.querySelector(`[data-testid="session-title-regenerated-${id(1)}"]`)).toBeNull();
  expect(document.querySelector(`[data-testid="recent-work-title-generate-failed-${id(1)}"]`)
    ?.textContent).toContain("没有可用的模型配置");
});
