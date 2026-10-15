import { act } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { activateRelayConnection, resetRelayConnectionForTest } from "../src/lib/relayConnection";
import { DomWrapper, flush, mountWorkbench } from "./mountApp";

const baseUrl = "http://127.0.0.1:8787";
const workspaceId = "11111111-1111-4111-8111-111111111111";
const otherWorkspaceId = "99999999-9999-4999-8999-999999999999";
const projectId = "22222222-2222-4222-8222-222222222222";
const otherProjectId = "33333333-3333-4333-8333-333333333333";
const created = "2026-09-26T00:00:00Z";
const root = `${baseUrl}/api/v1/workspaces/${workspaceId}`;
let unmount: (() => void) | null = null;

afterEach(() => {
  unmount?.(); unmount = null;
  resetRelayConnectionForTest(); sessionStorage.clear(); vi.unstubAllGlobals();
});
function connect(id = workspaceId) {
  activateRelayConnection({ baseUrl, workspaceId: id, bearerToken: "test-bearer-token-0123456789abcdef" });
}
function response(status: number, body: unknown): Response {
  return { ok: status >= 200 && status < 300, status, json: async () => body } as Response;
}
function project(id = projectId, archived = false, revision = "2") {
  return { id, title: id === projectId ? "待归档项目" : "另一项目", project_type: "GENERAL",
    revision, state_revision: "1", archived_at: archived ? created : null };
}
function listItem(id = projectId, archived = false, revision = "2") {
  return { ...project(id, archived, revision), archive_status: archived ? "ARCHIVED" : "ACTIVE",
    phase_key: "PLANNING", next_action_task_id: null, created_at: created, updated_at: created };
}
function archiveEnvelope(commandId: string, id = projectId) {
  return { command_id: commandId, committed_at: created, result: { project_id: id,
    revision: "3", archived_at: created, archive_status: "ARCHIVED" } };
}
const portal = () => new DomWrapper(document.body);
// 详情抽屉与确认框都是 role=dialog；按 aria-label 精确定位确认框，避免抓到抽屉本身。
const confirmDialog = () => new DomWrapper(document.querySelector('[role="dialog"][aria-label="确认归档项目"]'));

/**
 * 归档入口自 2026-10-11 起在项目详情抽屉里：先点卡片打开抽屉，再点抽屉中的归档按钮。
 * 抽屉走 createPortal 挂在 document.body，所以按钮必须用 document 查询。
 */
async function openArchive(projectId: string, wrapper: DomWrapper): Promise<void> {
  await wrapper.get(`[data-testid="project-row-${projectId}"]`).trigger("click");
  await flush();
  await portal().get('[data-testid="project-archive"]').trigger("click");
  await flush();
}

describe("live Project 归档", () => {
  it("单读 ACTIVE Project 后明确确认，成功刷新列表并能进入历史项目", async () => {
    connect();
    let archived = false;
    const posts: Record<string, unknown>[] = [];
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input).slice(root.length);
      // 左栏近期工作固定读 status=active；项目主区默认读 status=all。
      if (path === "/projects?status=active") return response(200, { items: [], next_cursor: null });
      if (path === "/projects?status=all") return response(200, {
        items: archived ? [listItem(projectId, true, "3")] : [listItem()], next_cursor: null });
      if (path === "/projects?status=archived") return response(200, {
        items: archived ? [listItem(projectId, true, "3")] : [], next_cursor: null });
      if (path === `/projects/${projectId}`) return response(200, project(projectId, archived, archived ? "3" : "2"));
      if (path === `/projects/${projectId}/archive` && init?.method === "POST") {
        posts.push(JSON.parse(String(init.body)) as Record<string, unknown>);
        archived = true;
        return response(200, archiveEnvelope(String(posts[0].command_id)));
      }
      throw new Error(`Unexpected request ${path}`);
    }); vi.stubGlobal("fetch", fetchMock);
    const mounted = await mountWorkbench("/projects"); unmount = mounted.unmount;
    await openArchive(projectId, mounted.wrapper);
    expect(confirmDialog().text()).toContain("当前修订 v2");
    expect(posts).toHaveLength(0);
    await portal().get('[data-testid="project-archive-cancel"]').trigger("click");
    expect(posts).toHaveLength(0);
    await portal().get('[data-testid="project-archive"]').trigger("click"); await flush();
    await portal().get('[data-testid="project-archive-confirm"]').trigger("click"); await flush();
    expect(posts).toHaveLength(1);
    expect(Object.keys(posts[0]).sort()).toEqual(["command_id", "expected_revision"]);
    expect(posts[0]).toMatchObject({ expected_revision: "2" });
    expect(mounted.wrapper.get('[data-testid="project-archive-success"]').text()).toContain(projectId);
    // 「全部项目」范围仍保留这条已归档事实；切到进行中确认它已离开活动范围，再到已归档范围打开它。
    await mounted.wrapper.get('[data-testid="projects-tab-active"]').trigger("click"); await flush(30);
    expect(mounted.wrapper.get('[data-testid="projects-live-count"]').text()).toContain("已加载 0 项");
    await mounted.wrapper.get('[data-testid="projects-tab-archived"]').trigger("click"); await flush(30);
    expect(mounted.wrapper.get(`[data-testid="project-row-${projectId}"]`).text()).toContain("待归档项目");
    await mounted.wrapper.get(`[data-testid="project-row-${projectId}"]`).trigger("click"); await flush();
    expect(portal().get('[data-testid="project-open"]').attributes("href")).toBe(`/projects/${projectId}`);
    expect(fetchMock.mock.calls.some(([input]) => String(input) === `${root}/projects?status=archived`)).toBe(true);
  });

  it("服务端阻断只显示固定代码及可行动说明，不伪造可归档结论", async () => {
    connect();
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input).slice(root.length);
      if (path === "/projects?status=active") return response(200, { items: [], next_cursor: null });
      if (path === "/projects?status=all") return response(200, { items: [listItem()], next_cursor: null });
      if (path === `/projects/${projectId}`) return response(200, project());
      if (path === `/projects/${projectId}/archive` && init?.method === "POST")
        return response(409, { code: "PROJECT_ARCHIVE_BLOCKED", detail: "archive blocked",
          conflict: { blocking_reasons: ["TASK_ACTIVE", "UNKNOWN_EFFECT", "RESOURCE_CLAIM_UNSETTLED"] } });
      throw new Error(`Unexpected request ${path}`);
    }));
    const mounted = await mountWorkbench("/projects"); unmount = mounted.unmount;
    await openArchive(projectId, mounted.wrapper);
    await portal().get('[data-testid="project-archive-confirm"]').trigger("click"); await flush();
    const reasons = mounted.wrapper.get('[data-testid="project-archive-blockers"]').text();
    expect(reasons).toContain("TASK_ACTIVE");
    expect(reasons).toContain("按原动作身份核对");
    expect(reasons).toContain("租约过期不等于安全释放");
    expect(mounted.wrapper.find('[data-testid="project-archive-pending"]').exists()).toBe(false);
    expect(mounted.wrapper.get(`[data-testid="project-row-${projectId}"]`).exists()).toBe(true);
  });

  it("修订冲突刷新 ACTIVE 事实，已归档冲突指向历史范围", async () => {
    connect();
    let revision = "2";
    let archived = false;
    let posts = 0;
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input).slice(root.length);
      if (path === "/projects?status=active") return response(200, { items: [], next_cursor: null });
      if (path === "/projects?status=all") return response(200, {
        items: archived ? [] : [listItem(projectId, false, revision)], next_cursor: null });
      if (path === `/projects/${projectId}`) return response(200, project(projectId, archived, revision));
      if (path === `/projects/${projectId}/archive` && init?.method === "POST") {
        posts++;
        if (posts === 1) { revision = "3"; return response(409, { code: "REVISION_CONFLICT",
          detail: "stale", conflict: { expected_revision: "2", actual_revision: "3" } }); }
        archived = true;
        return response(409, { code: "PROJECT_ARCHIVED", detail: "already archived" });
      }
      throw new Error(`Unexpected request ${path}`);
    }));
    const mounted = await mountWorkbench("/projects"); unmount = mounted.unmount;
    await openArchive(projectId, mounted.wrapper);
    await portal().get('[data-testid="project-archive-confirm"]').trigger("click"); await flush();
    expect(mounted.wrapper.get('[data-testid="project-archive-error"]').text()).toContain("当前 v3");
    // 冲突后列表重读，抽屉保持打开并按 id 对齐到新的修订事实。
    expect(portal().text()).toContain("Project v3");
    await portal().get('[data-testid="project-archive"]').trigger("click"); await flush();
    expect(confirmDialog().text()).toContain("当前修订 v3");
    await portal().get('[data-testid="project-archive-confirm"]').trigger("click"); await flush();
    expect(mounted.wrapper.get('[data-testid="project-archive-error"]').text()).toContain("已经归档");
    expect(mounted.wrapper.get('[data-testid="projects-live-count"]').text()).toContain("已加载 0 项");
  });

  it("响应不明跨 Workspace 保留原命令，回原范围查 404 后只原样重试", async () => {
    connect();
    const posts: { workspace: string; body: Record<string, unknown> }[] = [];
    const receipts: string[] = [];
    let archived = false;
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const isOriginal = url.startsWith(root);
      const scopeRoot = isOriginal ? root : `${baseUrl}/api/v1/workspaces/${otherWorkspaceId}`;
      const path = url.slice(scopeRoot.length);
      if (path === "/projects?status=active") return response(200, { items: [], next_cursor: null });
      if (path === "/projects?status=all") return response(200, { items: isOriginal
        ? archived ? [] : [listItem(), listItem(otherProjectId)] : [listItem(otherProjectId)], next_cursor: null });
      if (path === `/projects/${projectId}` && isOriginal) return response(200, project());
      if (path.startsWith("/commands/")) {
        receipts.push(url);
        if (receipts.length === 1) return response(200, { ...archiveEnvelope(String(posts[0].body.command_id)),
          command_type: "CreateProject" });
        return response(404, { code: "COMMAND_NOT_FOUND", detail: "not found" });
      }
      if (path === `/projects/${projectId}/archive` && init?.method === "POST" && isOriginal) {
        const body = JSON.parse(String(init.body)) as Record<string, unknown>;
        posts.push({ workspace: workspaceId, body });
        if (posts.length === 1) throw new TypeError("response lost");
        archived = true;
        return response(200, archiveEnvelope(String(body.command_id)));
      }
      throw new Error(`Unexpected request ${url}`);
    }));
    const mounted = await mountWorkbench("/projects"); unmount = mounted.unmount;
    await openArchive(projectId, mounted.wrapper);
    await portal().get('[data-testid="project-archive-confirm"]').trigger("click"); await flush();
    expect(mounted.wrapper.get('[data-testid="project-archive-pending"]').text()).toContain(projectId);
    await mounted.wrapper.get(`[data-testid="project-row-${otherProjectId}"]`).trigger("click"); await flush();
    expect(portal().get('[data-testid="project-archive"]').attributes("disabled")).toBeDefined();
    await act(async () => connect(otherWorkspaceId)); await flush();
    expect(mounted.wrapper.find('[data-testid="project-archive-pending"]').exists()).toBe(false);
    expect(receipts).toHaveLength(0);
    await act(async () => connect()); await flush();
    expect(mounted.wrapper.get('[data-testid="project-archive-pending"]').text()).toContain(projectId);
    await mounted.wrapper.get('[data-testid="project-archive-receipt"]').trigger("click"); await flush();
    expect(receipts).toHaveLength(1);
    expect(receipts[0]).toContain(`${root}/commands/${posts[0].body.command_id}`);
    expect(mounted.wrapper.find('[data-testid="project-archive-retry"]').exists()).toBe(false);
    await mounted.wrapper.get('[data-testid="project-archive-receipt"]').trigger("click"); await flush();
    expect(receipts).toHaveLength(2);
    await mounted.wrapper.get('[data-testid="project-archive-retry"]').trigger("click"); await flush();
    expect(posts).toHaveLength(2);
    expect(posts[1]).toEqual(posts[0]);
    expect(mounted.wrapper.get('[data-testid="project-archive-success"]').text()).toContain(projectId);
  });
});
