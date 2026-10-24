import { afterEach, expect, it, vi } from "vitest";
import { activateRelayConnection, resetRelayConnectionForTest } from "../../src/lib/relayConnection";
import { flush, mountWorkbench } from "../../tests/mountApp";
const wid = "11111111-1111-4111-8111-111111111111";
const pid = "77777777-7777-4777-8777-777777777777";
let unmount: (() => void) | null = null;
afterEach(() => { unmount?.(); unmount = null; resetRelayConnectionForTest(); vi.unstubAllGlobals(); });
function response(body: unknown, status = 200): Response { return { ok: status < 400, status, json: async () => body } as Response; }
it("项目列表续页临时失败应保留前页、未定下一步事实和原游标重试", async () => {
  const cursors: (string | null)[] = [];
  activateRelayConnection({ baseUrl: "http://127.0.0.1:8787", workspaceId: wid, bearerToken: "test-token" });
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
    const url = new URL(String(input));
    if (url.pathname.endsWith("/projects")) {
      const cursor = url.searchParams.get("cursor"); cursors.push(cursor);
      if (cursor !== null) return response({ code: "DATABASE_UNAVAILABLE", detail: "second project page temporarily unavailable" }, 503);
      return response({ items: [{ id: pid, title: "第一页项目必须保留", project_type: "GENERAL", revision: "1", state_revision: "1", archive_status: "ACTIVE", archived_at: null, phase_key: "CAPTURE", next_action_task_id: null, created_at: "2026-10-23T00:00:00Z", updated_at: "2026-10-23T00:00:00Z" }], next_cursor: "projects+page2" });
    }
    if (url.pathname.endsWith("/attention/interventions")) return response({ items: [] });
    return response([]);
  }));
  const mounted = await mountWorkbench("/projects"); unmount = mounted.unmount; await flush();
  expect(mounted.wrapper.text()).toContain("第一页项目必须保留");
  expect(mounted.wrapper.get('[data-testid="projects-summary"]').text()).toContain("1 个项目尚未明确下一步");
  await mounted.wrapper.get('[data-testid="projects-live-load-more"]').trigger("click"); await flush();
  const rowSurvives = mounted.wrapper.find(`[data-testid="project-row-${pid}"]`).exists();
  const cursorRetrySurvives = mounted.wrapper.find('[data-testid="projects-live-load-more"]').exists();
  const summary = mounted.wrapper.get('[data-testid="projects-summary"]').text();
  console.log("TRIAGE_PROJECT_LIST_MORE_FAILURE", JSON.stringify({ cursors, rowSurvives, cursorRetrySurvives, summary, hasReadError: mounted.wrapper.text().includes("数据库不可达") }));
  expect(rowSurvives, "A failed continuation must not erase already read projects").toBe(true);
  expect(cursorRetrySurvives).toBe(true);
  expect(summary).not.toContain("所有项目的下一步都已明确");
});
