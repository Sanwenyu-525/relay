import { afterEach, expect, it, vi } from "vitest";
import { activateRelayConnection, resetRelayConnectionForTest } from "../../src/lib/relayConnection";
import { flush, mountWorkbench } from "../../tests/mountApp";
const wid = "11111111-1111-4111-8111-111111111111";
const pid = "22222222-2222-4222-8222-222222222222";
const tid = (i: number) => `33333333-3333-4333-8333-${String(i).padStart(12, "0")}`;
let unmount: (() => void) | null = null;
afterEach(() => { unmount?.(); unmount = null; resetRelayConnectionForTest(); vi.unstubAllGlobals(); sessionStorage.clear(); });
function response(body: unknown): Response { return { ok: true, status: 200, json: async () => body } as Response; }
it("项目任务页应可发现第51个任务，不能只读首批却搜索断言全项目无匹配", async () => {
  const cursors: (string | null)[] = [];
  const task = (i: number) => ({ id: tid(i), title: i === 51 ? "EXISTING_TASK_51_UNIQUE" : `FIRST_PAGE_TASK_${i}`, project_id: pid, status: "INBOX", mode: "ME", revision: "0", executor: { kind: "HUMAN", run_id: null }, current_completion_id: null, waiting_reason: null, blocking_task_ids: [], unresolved_blocker_ids: [], allowed_actions: [] });
  activateRelayConnection({ baseUrl: "http://127.0.0.1:8787", workspaceId: wid, bearerToken: "test-token" });
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
    const url = new URL(String(input)); const path = url.pathname;
    if (path.endsWith(`/projects/${pid}`)) return response({ id: pid, title: "51-task-project", project_type: "GENERAL", revision: "1", state_revision: "1", archived_at: null });
    if (path.endsWith("/tasks") && url.searchParams.get("project_id") === pid) { const cursor = url.searchParams.get("cursor"); cursors.push(cursor); return response({ items: cursor === null ? Array.from({ length: 50 }, (_, i) => task(i + 1)) : [task(51)], next_cursor: cursor === null ? "task-page+51" : null }); }
    if (path.endsWith(`/tasks/${tid(1)}`)) return response({ ...task(1), acceptance: { acceptance_revision: "1", objective: "objective", source: "CREATE", criteria: [] }, dependencies: [] });
    if (path.endsWith("/attention/interventions")) return response({ items: [] });
    if (path.endsWith("/projects") || path.endsWith("/tasks")) return response({ items: [], next_cursor: null });
    return response([]);
  }));
  const mounted = await mountWorkbench(`/projects/${pid}/tasks`); unmount = mounted.unmount; await flush();
  expect(mounted.wrapper.findAll('[data-testid^="project-task-row-"]').length).toBeGreaterThanOrEqual(50);
  const paginationAvailable = mounted.wrapper.findAll("button").some(button => /加载更多|下一页|继续读取/.test(button.text()));
  await mounted.wrapper.get('input[name="project-task-search"]').setValue("EXISTING_TASK_51_UNIQUE"); await flush();
  const claimsNoProjectMatch = mounted.wrapper.text().includes("当前项目没有匹配该关键词的任务。");
  const task51Visible = mounted.wrapper.find(`[data-testid="project-task-row-${tid(51)}"]`).exists();
  console.log("TRIAGE_PROJECT_TASK_PAGINATION", JSON.stringify({ cursors, paginationAvailable, claimsNoProjectMatch, task51Visible }));
  expect(task51Visible || paginationAvailable && !claimsNoProjectMatch).toBe(true);
});
