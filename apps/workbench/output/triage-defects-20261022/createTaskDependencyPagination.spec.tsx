import { afterEach, expect, it, vi } from "vitest";
import { activateRelayConnection, resetRelayConnectionForTest } from "../../src/lib/relayConnection";
import { flush, mountWorkbench } from "../../tests/mountApp";
const wid = "11111111-1111-4111-8111-111111111111";
const pid = "22222222-2222-4222-8222-222222222222";
const tid = (n: number) => `33333333-3333-4333-8333-${String(n).padStart(12, "0")}`;
let unmount: (() => void) | null = null;
afterEach(() => { unmount?.(); unmount = null; resetRelayConnectionForTest(); vi.unstubAllGlobals(); });
const response = (body: unknown): Response => ({ ok: true, status: 200, json: async () => body }) as Response;
it("新建任务的依赖候选不能静默漏掉项目第51个既有任务", async () => {
  const cursors: (string | null)[] = [];
  const task = (n: number) => ({ id: tid(n), title: n === 51 ? "第51项必须能选择为前置" : `前置候选${n}`, project_id: pid, status: "INBOX", mode: "ME", revision: "0", executor: { kind: "HUMAN", run_id: null }, current_completion_id: null, waiting_reason: null, blocking_task_ids: [], unresolved_blocker_ids: [], allowed_actions: [] });
  activateRelayConnection({ baseUrl: "http://127.0.0.1:8787", workspaceId: wid, bearerToken: "test-token" });
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
    const url = new URL(String(input));
    if (url.pathname.endsWith("/tasks") && url.searchParams.get("project_id") === pid) { const cursor = url.searchParams.get("cursor"); cursors.push(cursor); return response({ items: cursor === null ? Array.from({ length: 50 }, (_, i) => task(i + 1)) : [task(51)], next_cursor: cursor === null ? "dependency+page51" : null }); }
    if (url.pathname.endsWith("/projects")) return response({ items: [], next_cursor: null });
    if (url.pathname.endsWith("/attention/interventions")) return response({ items: [] });
    return response([]);
  }));
  const mounted = await mountWorkbench(`/tasks?view=create&project=${pid}`); unmount = mounted.unmount; await flush();
  const select = mounted.wrapper.get('select[name="task-dependency"]');
  const options = select.findAll("option");
  const targetVisible = options.some(option => option.attributes("value") === tid(51));
  const loadMore = mounted.wrapper.findAll("button").find(b => /加载更多|下一页|继续读取/.test(b.text()));
  console.log("TRIAGE_CREATE_TASK_DEPENDENCY_PAGINATION", JSON.stringify({ cursors, candidateCount: options.length - 1, targetVisible, loadMoreOffered: Boolean(loadMore) }));
  expect(options.length).toBeGreaterThanOrEqual(51);
  expect(targetVisible || Boolean(loadMore), "existing prerequisite beyond first page must remain selectable").toBe(true);
});
