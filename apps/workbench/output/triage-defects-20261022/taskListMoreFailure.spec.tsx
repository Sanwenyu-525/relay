import { afterEach, expect, it, vi } from "vitest";
import { activateRelayConnection, resetRelayConnectionForTest } from "../../src/lib/relayConnection";
import { flush, mountWorkbench } from "../../tests/mountApp";
const wid = "11111111-1111-4111-8111-111111111111";
const tid = "55555555-5555-4555-8555-555555555555";
let unmount: (() => void) | null = null;
afterEach(() => { unmount?.(); unmount = null; resetRelayConnectionForTest(); vi.unstubAllGlobals(); });
function response(body: unknown, status = 200): Response { return { ok: status < 400, status, json: async () => body } as Response; }
it("任务列表续页503不应清空已加载前页或丢失续页重试游标", async () => {
  const cursors: (string | null)[] = [];
  activateRelayConnection({ baseUrl: "http://127.0.0.1:8787", workspaceId: wid, bearerToken: "test-token" });
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
    const url = new URL(String(input));
    if (url.pathname.endsWith("/tasks") && url.searchParams.get("scope") === "all") {
      const cursor = url.searchParams.get("cursor"); cursors.push(cursor);
      if (cursor !== null) return response({ code: "DATABASE_UNAVAILABLE", detail: "temporary second-page failure" }, 503);
      return response({ items: [{ id: tid, title: "FIRST_PAGE_TASK_KEEP", project_id: null, status: "INBOX", mode: "ME", revision: "2", executor: { kind: "HUMAN", run_id: null }, current_completion_id: null, waiting_reason: null, blocking_task_ids: [], unresolved_blocker_ids: [], allowed_actions: [] }], next_cursor: "task-page+2" });
    }
    if (url.pathname.endsWith("/attention/interventions")) return response({ items: [] });
    if (url.pathname.endsWith("/projects")) return response({ items: [], next_cursor: null });
    return response([]);
  }));
  const mounted = await mountWorkbench("/tasks"); unmount = mounted.unmount; await flush();
  const region = mounted.wrapper.get('[data-testid="tasks-live-all"]');
  expect(region.text()).toContain("FIRST_PAGE_TASK_KEEP");
  await region.get('[data-testid="tasks-live-load-more"]').trigger("click"); await flush();
  expect(region.text()).toContain("数据库不可达");
  const firstPageStillVisible = region.find(`[data-testid="task-row-${tid}"]`).exists();
  const moreStillVisible = region.find('[data-testid="tasks-live-load-more"]').exists();
  console.log("TRIAGE_TASK_LIST_MORE_FAILURE", JSON.stringify({ cursors, firstPageStillVisible, moreStillVisible, text: region.text() }));
  expect(firstPageStillVisible).toBe(true);
  expect(moreStillVisible).toBe(true);
});
