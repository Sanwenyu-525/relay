import { afterEach, expect, it, vi } from "vitest";
import { createElement } from "react";
import { MemoryRouter } from "react-router-dom";
import GoalProjectLinkPanel from "../src/views/GoalProjectLinkPanel";
import { RelayApiClient } from "../src/api/relayClient";
import { flush, mountReact } from "./mountApp";

/**
 * 禅道 #19（DEV-0141）：Goal↔Project 关联的项目选择必须能读到分页后续页。
 * 复用 getProjectsPage 既有 cursor/nextCursor：逐页手动加载、合并去重、失败保留
 * 已读与游标可重试、刷新清范围并隔离迟到页、末页如实收口；关联仍按列表里那份
 * 确切 Project revision 提交，且只列进行中项目。
 */

const baseUrl = "http://127.0.0.1:8787";
const workspaceId = "11111111-1111-4111-8111-111111111111";
const goalId = "44444444-4444-4444-8444-444444444444";
/** 只含路径：URL 的 pathname 不带 host，比对时不能拼 baseUrl。 */
const root = `/api/v1/workspaces/${workspaceId}`;

let cleanup: (() => void) | undefined;
afterEach(() => { cleanup?.(); cleanup = undefined; vi.unstubAllGlobals(); });

function response(status: number, body: unknown): Response {
  return { ok: status >= 200 && status < 300, status, json: async () => body } as Response;
}

function client() {
  return new RelayApiClient({ baseUrl, workspaceId, bearerToken: "test-bearer-token-0123456789abcdef" });
}

function project(id: string, title: string, revision = "2") {
  return { id, title, project_type: "GENERAL", revision, state_revision: "1", archived_at: null,
    archive_status: "ACTIVE", phase_key: "PLANNING", next_action_task_id: null,
    created_at: "2026-10-24T00:00:00Z", updated_at: "2026-10-24T00:00:00Z" };
}

const projectA = { id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", title: "第一页项目", revision: "2" };
const projectB = { id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", title: "重复出现项目", revision: "2" };
const projectC = { id: "cccccccc-cccc-4ccc-8ccc-cccccccccccc", title: "第二页目标项目", revision: "7" };
const projectLate = { id: "dddddddd-dddd-4ddd-8ddd-dddddddddddd", title: "迟到页项目", revision: "9" };

async function mountPanel() {
  const mounted = await mountReact(createElement(MemoryRouter, null,
    createElement(GoalProjectLinkPanel, { client: client(), goalId, goalTitle: "目标" })));
  cleanup = mounted.unmount;
  await flush();
  return mounted;
}

function optionTexts(wrapper: Awaited<ReturnType<typeof mountPanel>>): string[] {
  const select = wrapper.wrapper.get('[data-testid="goal-link-project"]').element;
  if (select === null) throw new Error("goal-link-project select not rendered");
  return Array.from(select.querySelectorAll("option")).map((option) => option.textContent ?? "");
}

async function clickMore(wrapper: Awaited<ReturnType<typeof mountPanel>>) {
  const more = wrapper.wrapper.findAll("button").find((button) => button.text() === "加载更多项目");
  expect(more, "有 next_cursor 时应提供加载更多项目入口").toBeDefined();
  await more!.trigger("click");
  await flush();
}

it("有 next_cursor 可逐页读取：合并去重、末页收口，且只请求进行中项目", async () => {
  const reads: string[] = [];
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
    const url = new URL(String(input));
    if (url.pathname === `${root}/projects`) {
      reads.push(url.searchParams.get("cursor") ?? "first");
      if (url.searchParams.get("status") !== "active") throw new Error("project link list must stay active-only");
      if (!url.searchParams.has("cursor")) return response(200, { items: [project(projectA.id, projectA.title), project(projectB.id, projectB.title)], next_cursor: "second-page" });
      return response(200, { items: [project(projectB.id, projectB.title), project(projectC.id, projectC.title, projectC.revision)], next_cursor: null });
    }
    throw new Error(`unexpected ${url}`);
  }));
  const view = await mountPanel();

  expect(optionTexts(view)).toHaveLength(3); // 占位项 + A + B
  expect(view.wrapper.get('[data-testid="goal-link-page-state"]').text()).toContain("仍有后续页未读");

  await clickMore(view);
  expect(reads).toEqual(["first", "second-page"]);

  // 合并去重：B 在两页都出现，只保留一份；C 可进入下拉。
  const texts = optionTexts(view).join("\n");
  expect(texts).toContain("第二页目标项目");
  expect(optionTexts(view)).toHaveLength(4); // 占位项 + A + B + C
  expect(optionTexts(view).filter((text) => text.includes("重复出现项目"))).toHaveLength(1);
  expect(view.wrapper.find('[data-testid="goal-link-more"]').exists()).toBe(false);
  expect(view.wrapper.get('[data-testid="goal-link-page-state"]').text()).toContain("已列出全部 3 个");
});

it("续页失败保留已读列表与游标，可在原游标重试，不重读第一页", async () => {
  let failing = true;
  const firstPageReads: number[] = [];
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
    const url = new URL(String(input));
    if (url.pathname === `${root}/projects`) {
      if (!url.searchParams.has("cursor")) { firstPageReads.push(1); return response(200, { items: [project(projectA.id, projectA.title), project(projectB.id, projectB.title)], next_cursor: "second-page" }); }
      if (failing) return response(503, { code: "INTERNAL_ERROR", detail: "temporary paging failure", retryable: true });
      return response(200, { items: [project(projectC.id, projectC.title, projectC.revision)], next_cursor: null });
    }
    throw new Error(`unexpected ${url}`);
  }));
  const view = await mountPanel();
  await clickMore(view);

  // 暂态失败：已读列表保留、错误可见、入口仍在（原游标重试）。
  expect(view.wrapper.get('[data-testid="goal-link-more-error"]').text()).toContain("已读项目与原游标保留");
  expect(optionTexts(view).join("\n")).toContain("第一页项目");
  expect(view.wrapper.get('[data-testid="goal-link-more"]').exists()).toBe(true);
  expect(firstPageReads).toHaveLength(1);

  failing = false;
  await clickMore(view);
  expect(firstPageReads, "重试续页不得重读第一页").toHaveLength(1);
  expect(optionTexts(view).join("\n")).toContain("第二页目标项目");
  expect(view.wrapper.find('[data-testid="goal-link-more-error"]').exists()).toBe(false);
  expect(view.wrapper.find('[data-testid="goal-link-more"]').exists()).toBe(false);
});

it("刷新清空已读范围，刷新前在途的迟到页不得串入新列表", async () => {
  let deferSecondPage = false;
  let refreshed = false;
  // 挂对象属性而不是裸 let：闭包内的赋值不参与 TS 控制流收窄，裸 let 在调用点会被收窄成 never。
  const deferred = { release: null as ((value: Response) => void) | null };
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
    const url = new URL(String(input));
    if (url.pathname === `${root}/projects`) {
      if (!url.searchParams.has("cursor")) {
        // 刷新后的首页已读到最后：新范围不再有后续页。
        return response(200, { items: [project(projectA.id, projectA.title)], next_cursor: refreshed ? null : "second-page" });
      }
      if (deferSecondPage) {
        return new Promise<Response>((resolve) => { deferred.release = resolve; });
      }
      return response(200, { items: [project(projectC.id, projectC.title, projectC.revision)], next_cursor: null });
    }
    throw new Error(`unexpected ${url}`);
  }));
  const view = await mountPanel();

  // 续页请求挂在途；先点刷新，再放行迟到的第二页响应。
  deferSecondPage = true;
  const more = view.wrapper.findAll("button").find((button) => button.text() === "加载更多项目");
  await more!.trigger("click");
  await flush(5);
  const refresh = view.wrapper.get('[data-testid="goal-link-refresh"]');
  refreshed = true;
  await refresh.trigger("click");
  await flush();

  deferSecondPage = false;
  await deferred.release?.(response(200, { items: [project(projectLate.id, projectLate.title)], next_cursor: null }));
  await flush();

  // 刷新已把范围清回首页（末页）；迟到的续页被读取代次隔离，不进入列表。
  const texts = optionTexts(view).join("\n");
  expect(texts).not.toContain("迟到页项目");
  expect(texts).toContain("第一页项目");
  expect(texts).not.toContain("第二页目标项目");
  expect(view.wrapper.find('[data-testid="goal-link-more"]').exists()).toBe(false);
  expect(view.wrapper.get('[data-testid="goal-link-page-state"]').text()).toContain("已列出全部 1 个");
});

it("后续页项目可选，关联按该页确切 ID 与修订提交", async () => {
  const posts: { path: string; body: Record<string, unknown> }[] = [];
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    if (init?.method === "POST" && url.pathname.endsWith("/goal-links")) {
      const body = JSON.parse(String(init.body)) as Record<string, unknown>;
      posts.push({ path: url.pathname, body });
      return response(200, { command_id: body.command_id, committed_at: "2026-10-24T00:00:00Z",
        result: { project_id: projectC.id, revision: "8", goal_ids: [goalId] } });
    }
    if (url.pathname === `${root}/projects`) {
      if (!url.searchParams.has("cursor")) return response(200, { items: [project(projectA.id, projectA.title)], next_cursor: "second-page" });
      return response(200, { items: [project(projectC.id, projectC.title, projectC.revision)], next_cursor: null });
    }
    throw new Error(`unexpected ${url}`);
  }));
  const view = await mountPanel();
  await clickMore(view);

  await view.wrapper.get('[data-testid="goal-link-project"]').setValue(projectC.id);
  await view.wrapper.get('[data-testid="goal-link-submit"]').trigger("click");
  await flush(); await flush();

  const link = posts[0];
  expect(link, "选定后续页项目后应发出关联命令").toBeDefined();
  // project_id 走 URL 路径，载荷只带原修订与 goal。
  expect(link!.path).toBe(`${root}/projects/${projectC.id}/goal-links`);
  expect(link!.body.expected_revision).toBe(projectC.revision);
  expect(link!.body.goal_id).toBe(goalId);
  expect(view.wrapper.get('[data-testid="goal-link-receipt"]').text()).toContain(projectC.id);
});
