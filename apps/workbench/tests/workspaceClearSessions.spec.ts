import { act, createElement, Fragment } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import WorkspaceClearSessions from "../src/components/WorkspaceClearSessions";
import { FeedbackHost } from "../src/components/Feedback";
import { RelayApiClient } from "../src/api/relayClient";

/**
 * 「清空该工作区会话」的口径（UI-WORKSPACE-CLEAR，2026-11-04，2026-11-10 按用户口径收窄）。
 *
 * 守护的是行为，不是外观：
 * 1. 悬停提示必须说出完整后果与作用范围，不用原生 title。
 * 2. 清空是**逐条走既有 DeleteAssistSession 命令**，不能整表直写；任务是「任务」段的事，
 *    任务执行会话与委派子会话不在范围，另一个工作区（不同 workspaceId）不会收到任何请求。
 * 3. **范围是「会话（按目录）」这一段收集的会话**：各目录分组的讨论一起算，含已归档；
 *    用户口径里的这一段是会话的集合区域，不是单个目录。
 * 4. 先读当前事实再确认，确认框条数必须和实际目标一致；重复触发不产生第二次破坏。
 * 5. 阻断、明确失败、结果未确认各自可读；未确认只核对原 command_id 回执，绝不换新命令重删。
 */

const workspaceId = "11111111-1111-4111-8111-111111111111";
const id = (n: number) => `33333333-3333-4333-8333-${String(n).padStart(12, "0")}`;
const DIR_A = "44444444-4444-4444-8444-444444444444";
const DIR_B = "55555555-5555-4555-8555-555555555555";

interface Row {
  readonly id: string;
  project_id: string | null;
  task_id: string | null;
  parent_session_id?: string | null;
  title: string;
  status: string;
  revision: string;
  pinned_at: string | null;
  unread_at: string | null;
  created_at: string;
  updated_at: string;
  last_message_at: string | null;
  has_messages: boolean;
  context?: { readonly project_goals: readonly unknown[];
    readonly working_directory: { readonly resource_id: string;
      readonly canonical_root: string; readonly source: string } | null };
}

const directory = (resourceId: string, root: string) => ({
  project_goals: [], working_directory: { resource_id: resourceId,
    canonical_root: root, source: "USER_PICKED" }
});

const row = (n: number, title: string, extra: Partial<Row> = {}): Row => ({
  id: id(n), project_id: null, task_id: null, parent_session_id: null, title,
  status: "ACTIVE", revision: "1", pinned_at: null, unread_at: null,
  created_at: `2026-11-0${n}T08:00:00Z`, updated_at: `2026-11-0${n}T08:00:00Z`,
  last_message_at: `2026-11-0${n}T08:00:00Z`, has_messages: true,
  context: directory(DIR_A, "D:/work/a"), ...extra
});

const json = (body: unknown, status = 200) =>
  ({ ok: status < 400, status, json: async () => body }) as Response;

function fakeServer(initial: Row[], options: {
  deleteBlockedIds?: readonly string[];
  deleteResponseLostIds?: readonly string[];
  /** 响应丢失且回执也读不到：真实「结果未确认」，不得被当成成功。 */
  dropReceipt?: boolean;
} = {}) {
  const rows = [...initial];
  const deletedTargets: string[] = [];
  const requestedPaths: string[] = [];
  const receipts = new Map<string, Record<string, unknown>>();
  const find = (sessionId: string) => rows.find((item) => item.id === sessionId);

  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    const path = url.pathname;
    requestedPaths.push(path);
    const deletion = /\/workspaces\/([^/]+)\/assist-sessions\/([^/]+)\/delete$/u.exec(path);
    if (init?.method === "POST" && deletion !== null) {
      expect(deletion[1]).toBe(workspaceId);
      const target = find(String(deletion[2]));
      const body = JSON.parse(String(init.body)) as Record<string, unknown>;
      deletedTargets.push(String(deletion[2]));
      if (target === undefined) return json({ code: "RESOURCE_NOT_FOUND", detail: "gone" }, 404);
      if ((options.deleteBlockedIds ?? []).includes(target.id)) {
        return json({ code: "SESSION_DELETE_BLOCKED", detail: "referenced",
          conflict: { blocking_reasons: ["LEARNING_RECORDS"] } }, 409);
      }
      rows.splice(rows.indexOf(target), 1);
      const commandId = String(body.command_id);
      if (!options.dropReceipt) {
        receipts.set(commandId, { session_id: target.id, revision: target.revision,
          deleted_messages: 1, deleted_attachments: 0, deleted_at: "2026-11-04T09:00:00.000Z" });
      }
      if ((options.deleteResponseLostIds ?? []).includes(target.id)) {
        return json({ code: "INTERNAL_ERROR", detail: "请求未能完成。", request_id: "req-lost" }, 500);
      }
      return json({ command_id: commandId, committed_at: "2026-11-04T09:00:00Z",
        result: receipts.get(commandId) });
    }
    if (path.endsWith("/assist-sessions")) {
      const status = url.searchParams.get("status") ?? "ACTIVE";
      expect(path).toContain(`/workspaces/${workspaceId}/`);
      return json({ items: rows.filter((item) => status === "ALL" || item.status === status) });
    }
    const receipt = /\/workspaces\/([^/]+)\/commands\/([^/]+)$/u.exec(path);
    if (receipt !== null) {
      expect(receipt[1]).toBe(workspaceId);
      const commandId = String(receipt[2]);
      const found = receipts.get(commandId);
      return found === undefined
        ? json({ code: "RESOURCE_NOT_FOUND", detail: "no receipt" }, 404)
        : json({ command_id: commandId, command_type: "DeleteAssistSession",
          committed_at: "2026-11-04T09:00:00Z", result: found });
    }
    throw new Error(`unexpected request: ${init?.method ?? "GET"} ${path}`);
  }));

  return { rows, deletedTargets, requestedPaths };
}

function makeClient(): RelayApiClient {
  return new RelayApiClient({ baseUrl: "http://127.0.0.1:4031", workspaceId, bearerToken: "test-token" });
}

const mountedRoots: ReturnType<typeof createRoot>[] = [];

async function mount(client: RelayApiClient,
  onCleared: (ids: readonly string[], allDeleted: boolean) => void) {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  mountedRoots.push(root);
  await act(async () => {
    root.render(createElement(Fragment, null,
      createElement(WorkspaceClearSessions, { client, onCleared }),
      createElement(FeedbackHost)));
  });
  const button = () => container.querySelector<HTMLElement>('[data-testid="workspace-clear-sessions"]');
  const portal = (testId: string) => document.querySelector<HTMLElement>(`[data-testid="${testId}"]`);
  const click = async (testId: string) => {
    const target = portal(testId);
    if (target === null) throw new Error(`portal control not found: ${testId}`);
    await act(async () => { target.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true })); });
    await flush();
  };
  return { container, root, button, portal, click };
}

async function flush(milliseconds = 60): Promise<void> {
  await act(async () => { await new Promise<void>((resolve) => window.setTimeout(resolve, milliseconds)); });
  await act(async () => { await new Promise<void>((resolve) => window.setTimeout(resolve, 10)); });
}

afterEach(async () => {
  vi.unstubAllGlobals();
  for (const root of mountedRoots.splice(0)) {
    await act(async () => { root.unmount(); });
  }
  document.body.innerHTML = "";
});

it("悬停提示说清作用范围，确认框按整段会话集合计数，各目录讨论一起清、任务会话与子会话不动", async () => {
  const server = fakeServer([
    row(1, "讨论 A"),
    row(2, "讨论 B"),
    row(3, "任务执行会话", { task_id: id(90) }),
    row(4, "委派子会话", { parent_session_id: id(1) }),
    row(5, "另一目录讨论", { context: directory(DIR_B, "D:/work/b") }),
    { ...row(6, "已归档讨论"), status: "ARCHIVED" }
  ]);
  const onCleared = vi.fn<(ids: readonly string[], allDeleted: boolean) => void>();
  const mounted = await mount(makeClient(), onCleared);
  const button = mounted.button();
  expect(button).not.toBeNull();

  await act(async () => { button?.focus(); });
  const tooltip = mounted.portal("workspace-clear-tooltip");
  expect(tooltip?.textContent)
    .toBe("清空「会话（按目录）」里的讨论（含已归档）；「任务」段的执行会话不在范围内");

  await act(async () => { button?.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true })); });
  await flush();
  // 目录 A 两条 + 目录 B 一条 + 已归档一条 = 4；任务执行会话与委派子会话不在范围。
  expect(mounted.portal("workspace-clear-count")?.textContent).toBe("4");
  expect(mounted.portal("workspace-clear-confirm")?.textContent).toContain("清空 4 条会话");

  await mounted.click("workspace-clear-confirm");
  expect(server.deletedTargets).toEqual([id(1), id(2), id(5), id(6)]);
  expect(server.rows.map((item) => item.title)).toEqual(["任务执行会话", "委派子会话"]);
  expect(onCleared).toHaveBeenCalledWith([id(1), id(2), id(5), id(6)], true);

  // 再点一次：这一段里已没有可清会话，不再发任何删除命令（重复点击不产生第二次破坏）。
  await act(async () => { button?.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true })); });
  await flush();
  expect(mounted.portal("workspace-clear-empty")?.textContent).toContain("没有可清空");
  expect(server.deletedTargets).toEqual([id(1), id(2), id(5), id(6)]);


});

it("被业务引用阻断时如实保留并列出原因，不报整组成功", async () => {
  const server = fakeServer([
    row(1, "可删讨论"),
    row(2, "被引用讨论"),
    row(3, "另一目录讨论", { context: directory(DIR_B, "D:/work/b") })
  ], { deleteBlockedIds: [id(2)] });
  const onCleared = vi.fn<(ids: readonly string[], allDeleted: boolean) => void>();
  const mounted = await mount(makeClient(), onCleared);

  await act(async () => { mounted.button()?.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true })); });
  await flush();
  await mounted.click("workspace-clear-confirm");

  expect(server.deletedTargets).toEqual([id(1), id(2), id(3)]);
  expect(server.rows.map((item) => item.title)).toEqual(["被引用讨论"]);
  expect(onCleared).toHaveBeenCalledWith([id(1), id(3)], false);
  expect(mounted.portal("workspace-clear-summary")?.textContent).toContain("被业务引用保留");
  expect(mounted.portal("workspace-clear-blocked")?.textContent).toContain("被引用讨论");
  // 有阻断就不发「整段已清空」的成功回执：摘要如实写 2 成 1 留，而不是报 3 条全删。
  expect(mounted.portal("workspace-clear-success")).toBeNull();
  expect(mounted.portal("workspace-clear-summary")?.textContent).toContain("已清空 2 条会话");
  expect(mounted.portal("workspace-clear-summary")?.textContent).not.toContain("已清空 3 条会话");


});

it("响应丢失但服务端已提交时，只按原 command_id 核对回执并恢复成功", async () => {
  const server = fakeServer([row(1, "响应丢失讨论")], { deleteResponseLostIds: [id(1)] });
  const onCleared = vi.fn<(ids: readonly string[], allDeleted: boolean) => void>();
  const mounted = await mount(makeClient(), onCleared);

  await act(async () => { mounted.button()?.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true })); });
  await flush();
  await mounted.click("workspace-clear-confirm");

  expect(server.deletedTargets).toEqual([id(1)]);
  expect(onCleared).toHaveBeenCalledWith([id(1)], true);
  // 核对走的是原命令回执读取，没有发第二条删除命令。
  expect(server.requestedPaths.filter((path) => path.includes("/delete")).length).toBe(1);


});

it("响应丢失且回执也读不到时停在未确认，重读回执仍不假成功", async () => {
  const server = fakeServer([row(1, "未确认讨论")], { deleteResponseLostIds: [id(1)], dropReceipt: true });
  const onCleared = vi.fn<(ids: readonly string[], allDeleted: boolean) => void>();
  const mounted = await mount(makeClient(), onCleared);

  await act(async () => { mounted.button()?.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true })); });
  await flush();
  await mounted.click("workspace-clear-confirm");

  expect(server.deletedTargets).toEqual([id(1)]);
  expect(onCleared).not.toHaveBeenCalled();
  expect(mounted.portal("workspace-clear-summary")?.textContent).toContain("结果未确认");
  expect(mounted.portal("workspace-clear-success")).toBeNull();

  const commandId = document.querySelector(".workspace-clear-diagnostics code")?.textContent ?? "";
  expect(commandId).not.toBe("");
  await mounted.click(`workspace-clear-recheck-${id(1)}`);
  expect(mounted.portal("workspace-clear-recheck-note")?.textContent).toContain("仍未查到");
  expect(onCleared).not.toHaveBeenCalled();
  // 核对没有产生第二笔删除。
  expect(server.requestedPaths.filter((path) => path.includes("/delete")).length).toBe(1);


});

it("确认按钮的重复触发不会启动第二轮删除", async () => {
  const server = fakeServer([row(1, "讨论 A"), row(2, "讨论 B")]);
  const mounted = await mount(makeClient(), vi.fn());

  await act(async () => { mounted.button()?.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true })); });
  await flush();
  const confirm = mounted.portal("workspace-clear-confirm");
  expect(confirm).not.toBeNull();
  await act(async () => {
    confirm?.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    confirm?.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
  });
  await flush(120);

  expect(server.deletedTargets).toEqual([id(1), id(2)]);

});
