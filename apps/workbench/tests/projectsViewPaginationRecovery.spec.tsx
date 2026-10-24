/*
 * 禅道 #110 回归：项目列表续页失败不得清空已读项目、原游标与摘要事实。
 *
 * 红测口径（对应 triage 复现 output/triage-defects-20261022/projectListMoreFailure.spec.tsx）：
 * 首屏成功读到 ACTIVE 项目 P（next_action_task_id=null，next_cursor=projects+page2），
 * 续页 503 DATABASE_UNAVAILABLE 之后仍须保留 P、保留原游标入口、保留「尚未明确下一步」，
 * 并且摘要不得在后续页未读完时宣称全量结论。
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { activateRelayConnection, resetRelayConnectionForTest } from "../src/lib/relayConnection";
import { DomWrapper, flush, mountWorkbench } from "./mountApp";

const baseUrl = "http://127.0.0.1:8787";
const workspaceId = "11111111-1111-4111-8111-111111111111";
const projectP = "77777777-7777-4777-8777-777777777777";
const projectQ = "88888888-8888-4888-8888-888888888888";
const page2 = "projects+page2";
const created = "2026-10-23T00:00:00.000Z";

let unmount: (() => void) | null = null;

// 项目详情抽屉走 AppDialog 的 createPortal，挂在 document.body，容器里查不到。
const portal = () => new DomWrapper(document.body);

afterEach(() => {
  unmount?.(); unmount = null;
  resetRelayConnectionForTest(); vi.unstubAllGlobals();
});

function connect(): void {
  activateRelayConnection({ baseUrl, workspaceId, bearerToken: "test-bearer-token-0123456789abcdef" });
}
function response(status: number, body: unknown): Response {
  return { ok: status >= 200 && status < 300, status, json: async () => body } as Response;
}
function project(id: string, title: string, nextTaskId: string | null = null) {
  return { id, title, project_type: "GENERAL", revision: "2", state_revision: "3",
    archive_status: "ACTIVE", archived_at: null, phase_key: "PLANNING",
    next_action_task_id: nextTaskId, created_at: created, updated_at: created };
}
/** 与真实路由一致：项目主区读 /projects?status=all，左栏近期工作与任务各读一次自己的范围。 */
function routeFetch(handler: (url: URL) => Response | null): (input: RequestInfo | URL) => Promise<Response> {
  return vi.fn(async (input: RequestInfo | URL) => {
    const url = new URL(String(input));
    const routed = handler(url);
    if (routed !== null) return routed;
    if (url.pathname.endsWith("/attention/interventions")) return response(200, { items: [] });
    if (url.pathname.endsWith("/tasks")) return response(200, { items: [], next_cursor: null });
    if (url.pathname.endsWith("/assist-sessions")) return response(200, { items: [] });
    if (url.pathname.endsWith("/projects")) return response(200, { items: [], next_cursor: null });
    return response(200, []);
  });
}

describe("项目列表续页失败恢复（禅道 #110）", () => {
  it("续页 503 保留已读项目、原游标入口与未定下一步事实，摘要不宣称全量结论", async () => {
    connect();
    const cursors: (string | null)[] = [];
    vi.stubGlobal("fetch", routeFetch((url) => {
      if (!url.pathname.endsWith("/projects")) return null;
      const cursor = url.searchParams.get("cursor");
      cursors.push(cursor);
      if (cursor !== null) return response(503, { code: "DATABASE_UNAVAILABLE", detail: "续页暂时不可用" });
      return response(200, { items: [project(projectP, "第一页项目必须保留")], next_cursor: page2 });
    }));

    const mounted = await mountWorkbench("/projects"); unmount = mounted.unmount; await flush();

    // 首屏事实成立：P 可见、摘要点出「尚未明确下一步」、提供加载更多。
    expect(mounted.wrapper.find(`[data-testid="project-row-${projectP}"]`).exists()).toBe(true);
    expect(mounted.wrapper.get('[data-testid="projects-summary"]').text()).toContain("1 个项目尚未明确下一步");
    expect(mounted.wrapper.find('[data-testid="projects-live-load-more"]').exists()).toBe(true);

    // 先打开 P 的详情抽屉：续页失败不该把它关掉（已读事实仍可读）。
    await mounted.wrapper.get(`[data-testid="project-card-more-${projectP}"]`).trigger("click");
    await flush();
    expect(portal().get('[data-testid="project-open"]').attributes("href")).toBe(`/projects/${projectP}`);

    await mounted.wrapper.get('[data-testid="projects-live-load-more"]').trigger("click");
    await flush(60);

    // 续页失败后：P 仍在、加载更多入口仍在（原游标没丢）、出现局部续页错误。
    expect(cursors).toContain(page2);
    expect(mounted.wrapper.find(`[data-testid="project-row-${projectP}"]`).exists()).toBe(true);
    expect(mounted.wrapper.find('[data-testid="projects-live-load-more"]').exists()).toBe(true);
    expect(portal().find('[data-testid="project-open"]').exists()).toBe(true);
    const moreError = mounted.wrapper.get('[data-testid="projects-live-more-error"]');
    expect(moreError.text()).toContain("续页失败");
    expect(moreError.text()).toContain("数据库不可达");
    expect(moreError.text()).toContain("已保留前面加载的结果");
    // 错误是局部的，不是整页错误态。
    expect(mounted.wrapper.find('[data-testid="projects-live-count"]').exists()).toBe(true);

    // 摘要不得把「已读 1 页」说成全量：仍有后续页未读完，不能断言所有项目下一步已明确。
    const summary = mounted.wrapper.get('[data-testid="projects-summary"]').text();
    expect(summary).not.toContain("所有项目的下一步都已明确");
    expect(summary).not.toContain("0 个项目正在推进");
    expect(summary).toContain("已加载范围内");
    expect(summary).toContain("1 个项目尚未明确下一步");
    expect(summary).toContain("后续页");
  });

  it("按原游标重试成功后错误消失、项目只追加一次", async () => {
    connect();
    const cursors: (string | null)[] = [];
    vi.stubGlobal("fetch", routeFetch((url) => {
      if (!url.pathname.endsWith("/projects")) return null;
      const cursor = url.searchParams.get("cursor");
      cursors.push(cursor);
      if (cursor === page2 && cursors.filter((item) => item === page2).length === 1) {
        return response(503, { code: "DATABASE_UNAVAILABLE", detail: "续页暂时不可用" });
      }
      if (cursor === page2) return response(200, { items: [project(projectQ, "第二页项目")], next_cursor: null });
      return response(200, { items: [project(projectP, "第一页项目必须保留")], next_cursor: page2 });
    }));

    const mounted = await mountWorkbench("/projects"); unmount = mounted.unmount; await flush();
    await mounted.wrapper.get('[data-testid="projects-live-load-more"]').trigger("click");
    await flush(60);
    expect(mounted.wrapper.find('[data-testid="projects-live-more-error"]').exists()).toBe(true);

    // 重试沿用同一个游标，不是从头刷新。
    await mounted.wrapper.get('[data-testid="projects-live-more-retry"]').trigger("click");
    await flush(60);

    expect(cursors.filter((item) => item === page2)).toHaveLength(2);
    expect(mounted.wrapper.find('[data-testid="projects-live-more-error"]').exists()).toBe(false);
    expect(mounted.wrapper.find(`[data-testid="project-row-${projectP}"]`).exists()).toBe(true);
    expect(mounted.wrapper.find(`[data-testid="project-row-${projectQ}"]`).exists()).toBe(true);
    // 已读项目不重复：P 只出现一次。
    expect(mounted.wrapper.findAll(`[data-testid="project-row-${projectP}"]`)).toHaveLength(1);
    expect(mounted.wrapper.findAll(`[data-testid="project-row-${projectQ}"]`)).toHaveLength(1);
    expect(mounted.wrapper.get('[data-testid="projects-live-count"]').text()).toContain("已加载 2 项");
    // 读完全部页后才给全量结论：不再带「已加载范围内」限定，数量按已读全集给。
    const summary = mounted.wrapper.get('[data-testid="projects-summary"]').text();
    expect(summary).toContain("2 个项目正在推进");
    expect(summary).toContain("2 个项目尚未明确下一步");
    expect(summary).not.toContain("已加载范围内");
    expect(summary).not.toContain("后续页");
  });

  it("首读失败仍是全页错误态，摘要不把未知说成全量 0 或全部明确", async () => {
    connect();
    vi.stubGlobal("fetch", routeFetch((url) => {
      if (!url.pathname.endsWith("/projects")) return null;
      if (url.searchParams.get("status") === "all") {
        return response(503, { code: "DATABASE_UNAVAILABLE", detail: "列表读取失败" });
      }
      return response(200, { items: [], next_cursor: null });
    }));

    const mounted = await mountWorkbench("/projects"); unmount = mounted.unmount; await flush();

    expect(mounted.wrapper.find('[data-testid="projects-live-list"]').exists()).toBe(true);
    expect(mounted.wrapper.text()).toContain("数据库不可达");
    expect(mounted.wrapper.find('[data-testid="projects-live-more-error"]').exists()).toBe(false);
    const summary = mounted.wrapper.get('[data-testid="projects-summary"]').text();
    expect(summary).not.toContain("所有项目的下一步都已明确");
    expect(summary).not.toContain("0 个项目正在推进");
    expect(summary).toContain("尚未确认");
  });

  it("续页失权时清空已读项目，不保留不可再读的数据", async () => {
    connect();
    let page2Attempts = 0;
    vi.stubGlobal("fetch", routeFetch((url) => {
      if (!url.pathname.endsWith("/projects")) return null;
      const cursor = url.searchParams.get("cursor");
      if (cursor === page2) {
        page2Attempts += 1;
        return response(403, { code: "FORBIDDEN", detail: "项目列表不可读" });
      }
      return response(200, { items: [project(projectP, "第一页项目必须保留")], next_cursor: page2 });
    }));

    const mounted = await mountWorkbench("/projects"); unmount = mounted.unmount; await flush();
    expect(mounted.wrapper.find(`[data-testid="project-row-${projectP}"]`).exists()).toBe(true);

    await mounted.wrapper.get('[data-testid="projects-live-load-more"]').trigger("click");
    await flush(60);

    expect(page2Attempts).toBe(1);
    // 失权后已读数据不再展示，也不给「按原游标重试」的假入口。
    expect(mounted.wrapper.find(`[data-testid="project-row-${projectP}"]`).exists()).toBe(false);
    expect(mounted.wrapper.find('[data-testid="projects-live-load-more"]').exists()).toBe(false);
    expect(mounted.wrapper.find('[data-testid="projects-live-more-error"]').exists()).toBe(false);
    expect(mounted.wrapper.text()).toContain("权限或作用域已失效");
    const summary = mounted.wrapper.get('[data-testid="projects-summary"]').text();
    expect(summary).not.toContain("所有项目的下一步都已明确");
    expect(summary).not.toContain("0 个项目正在推进");
  });
});
