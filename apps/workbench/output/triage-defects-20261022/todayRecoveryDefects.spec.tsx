import { afterEach, expect, it, vi } from "vitest";
import { activateRelayConnection, resetRelayConnectionForTest } from "../../src/lib/relayConnection";
import { flush, mountWorkbench } from "../../tests/mountApp";
const baseUrl = "http://127.0.0.1:8787";
const workspaceId = "11111111-1111-4111-8111-111111111111";
const taskId = "33333333-3333-4333-8333-333333333333";
let unmount: (() => void) | null = null;
afterEach(() => { unmount?.(); unmount = null; resetRelayConnectionForTest(); sessionStorage.clear(); vi.unstubAllGlobals(); });
function response(status: number, body: unknown): Response { return { ok: status >= 200 && status < 300, status, json: async () => body } as Response; }

it("今日置顶响应丢失后切页返回应保留原命令和禁止新提交", async () => {
  activateRelayConnection({ baseUrl, workspaceId, bearerToken: "test-token" });
  const ids: string[] = [];
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    if (init?.method === "POST") { ids.push(JSON.parse(String(init.body)).command_id); throw new TypeError("lost after commit"); }
    if (url.pathname.endsWith("/today")) return response(200, { date: url.searchParams.get("date"), timezone: url.searchParams.get("timezone"), selection_revision: "1", focus: null, focus_has_eligible_candidate: false,
      eligible_items: [{ task_id: taskId, task_revision: "2", project_id: null, title: "未知命令恢复探针", status: "READY", priority: null, due_local_date: null, timezone: null,
        pin: false, later_local_date: null, later_timezone: null, reason_codes: ["READY_TO_START"], evidence_refs: [], allowed_actions: ["PIN"] }], waiting_items: [], blocked_pinned_items: [] });
    if (url.pathname.endsWith(`/tasks/${taskId}`)) return response(200, { id: taskId, project_id: null, title: "任务", status: "READY", mode: "ME", revision: "2",
      executor: { kind: "HUMAN", run_id: null, ownership_epoch: "0" }, current_completion_id: null, waiting_reason: null, blocking_task_ids: [], unresolved_blocker_ids: [], allowed_actions: [],
      acceptance: { acceptance_revision: "1", objective: "目标", source: "CREATE", criteria: [] }, dependencies: [] });
    if (url.pathname.endsWith("/reviews")) return response(200, { items: [] });
    if (url.pathname.endsWith("/attention/interventions")) return response(200, { items: [] });
    if (url.pathname.endsWith("/tasks") || url.pathname.endsWith("/projects")) return response(200, { items: [], next_cursor: null });
    throw new Error(`unexpected ${url}`);
  }));
  const mounted = await mountWorkbench("/today"); unmount = mounted.unmount; await flush();
  const pin = () => mounted.wrapper.findAll("button").find(button => button.text() === "置顶")!;
  await pin().trigger("click"); await flush();
  expect(ids).toHaveLength(1);
  expect(mounted.wrapper.get('[data-testid="today-pending"]').text()).toContain(ids[0]);
  await mounted.router.push("/reviews"); await flush();
  await mounted.router.push("/today"); await flush();
  console.log("TRIAGE_TODAY_RETURN", JSON.stringify({ route: mounted.router.currentRoute.value.path, originalCommand: ids[0], recovered: mounted.wrapper.find('[data-testid="today-pending"]').exists() }));
  const recovered = mounted.wrapper.find('[data-testid="today-pending"]').exists();
  const nextPin = pin();
  if (nextPin) { await nextPin.trigger("click"); await flush(); }
  console.log("TRIAGE_TODAY_COMMANDS", JSON.stringify(ids));
  expect(new Set(ids).size).toBe(1);
  expect(recovered).toBe(true);
});

it("今日安排未编辑表单在刷新读到新修订后不应以新revision回写旧计划值", async () => {
  activateRelayConnection({ baseUrl, workspaceId, bearerToken: "test-token" });
  let updated = false;
  const posts: Record<string, unknown>[] = [];
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    if (init?.method === "POST") {
      posts.push(JSON.parse(String(init.body)));
      return response(409, { code: "REVISION_CONFLICT", detail: "probe does not write actual state" });
    }
    if (url.pathname.endsWith("/today")) return response(200, { date: url.searchParams.get("date"), timezone: url.searchParams.get("timezone"), selection_revision: "1", focus: null, focus_has_eligible_candidate: false,
      eligible_items: [{ task_id: taskId, task_revision: updated ? "3" : "2", project_id: null, title: "表单同步探针", status: "READY", priority: updated ? "HIGH" : "LOW", due_local_date: updated ? "2026-11-01" : null, timezone: updated ? "Asia/Shanghai" : null,
        pin: false, later_local_date: null, later_timezone: null, reason_codes: ["READY_TO_START"], evidence_refs: [], allowed_actions: ["PIN", "SET_LATER"] }], waiting_items: [], blocked_pinned_items: [] });
    if (url.pathname.endsWith(`/tasks/${taskId}`)) return response(200, { id: taskId, project_id: null, title: "任务", status: "READY", mode: "ME", revision: updated ? "3" : "2",
      executor: { kind: "HUMAN", run_id: null, ownership_epoch: "0" }, current_completion_id: null, waiting_reason: null, blocking_task_ids: [], unresolved_blocker_ids: [], allowed_actions: [],
      acceptance: { acceptance_revision: "1", objective: "目标", source: "CREATE", criteria: [] }, dependencies: [] });
    if (url.pathname.endsWith("/reviews") || url.pathname.endsWith("/attention/interventions")) return response(200, { items: [] });
    if (url.pathname.endsWith("/tasks") || url.pathname.endsWith("/projects")) return response(200, { items: [], next_cursor: null });
    throw new Error(`unexpected ${url}`);
  }));
  const mounted = await mountWorkbench("/today"); unmount = mounted.unmount; await flush();
  expect((mounted.wrapper.get('.today-task select').element as HTMLSelectElement).value).toBe("LOW");
  updated = true;
  await mounted.wrapper.get('.today-query .secondary-button').trigger("click"); await flush();
  expect(mounted.wrapper.get('.today-task__trace').text()).toContain("任务修订 v3");
  await mounted.wrapper.findAll('.today-task__forms form')[1].trigger("submit"); await flush();
  console.log("TRIAGE_TODAY_STALE_FORM", JSON.stringify(posts));
  expect(posts[0]).toMatchObject({ expected_revision: "3", priority: "HIGH", due_local_date: "2026-11-01" });
});
