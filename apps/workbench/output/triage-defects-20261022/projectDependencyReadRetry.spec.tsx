import { afterEach, expect, it, vi } from "vitest";
import { activateRelayConnection, resetRelayConnectionForTest } from "../../src/lib/relayConnection";
import { flush, mountWorkbench } from "../../tests/mountApp";
const wid = "11111111-1111-4111-8111-111111111111";
const pid = "22222222-2222-4222-8222-222222222222";
const tid = "33333333-3333-4333-8333-333333333333";
const dep = "44444444-4444-4444-8444-444444444444";
let unmount: (() => void) | null = null;
afterEach(() => { unmount?.(); unmount = null; resetRelayConnectionForTest(); vi.unstubAllGlobals(); sessionStorage.clear(); });
function response(body: unknown, status = 200): Response { return { ok: status < 400, status, json: async () => body } as Response; }
it("项目单任务前置详情暂时失败后应可原地重读，不能静默吞错并永久不重读同项", async () => {
  let healthy = false;
  let detailReads = 0;
  const task = { id: tid, title: "唯一任务等待前置", project_id: pid, status: "READY", mode: "ME", revision: "0", executor: { kind: "HUMAN", run_id: null }, current_completion_id: null, waiting_reason: null, blocking_task_ids: [dep], unresolved_blocker_ids: [], allowed_actions: [] };
  activateRelayConnection({ baseUrl: "http://127.0.0.1:8787", workspaceId: wid, bearerToken: "test-token" });
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
    const url = new URL(String(input));
    if (url.pathname.endsWith(`/projects/${pid}`)) return response({ id: pid, title: "dependency probe project", project_type: "GENERAL", revision: "1", state_revision: "1", archived_at: null });
    if (url.pathname.endsWith("/tasks") && url.searchParams.get("project_id") === pid) return response({ items: [task], next_cursor: null });
    if (url.pathname.endsWith(`/tasks/${tid}`)) {
      detailReads++;
      if (!healthy) return response({ code: "DATABASE_UNAVAILABLE", detail: "temporary dependency detail read failure" }, 503);
      return response({ ...task, acceptance: { acceptance_revision: "1", objective: "objective", source: "CREATE", criteria: [] }, dependencies: [{ task_id: dep, dependency_kind: "REQUIRED", title: "可恢复前置任务名称", status: "INBOX" }] });
    }
    if (url.pathname.endsWith("/attention/interventions")) return response({ items: [] });
    if (url.pathname.endsWith("/projects") || url.pathname.endsWith("/tasks")) return response({ items: [], next_cursor: null });
    return response([]);
  }));
  const mounted = await mountWorkbench(`/projects/${pid}/tasks`); unmount = mounted.unmount; await flush();
  expect(detailReads).toBe(1);
  expect(mounted.wrapper.text()).toContain("前置任务尚未完成");
  const hasReadError = mounted.wrapper.text().includes("数据库不可达") || mounted.wrapper.text().includes("读取失败");
  healthy = true;
  await mounted.wrapper.get(`[data-testid="project-task-row-${tid}"]`).trigger("click"); await flush();
  const retry = mounted.wrapper.findAll("button").find(b => /重读.*依赖|重试|重新读取/.test(b.text()));
  if (retry) { await retry.trigger("click"); await flush(); }
  const restored = mounted.wrapper.text().includes("可恢复前置任务名称");
  console.log("TRIAGE_PROJECT_DEPENDENCY_READ_RETRY", JSON.stringify({ detailReads, hasReadError, retryOffered: Boolean(retry), dependencyRestored: restored, startDisabled: mounted.wrapper.get('[data-testid="project-task-start"]').attributes("disabled") !== undefined, fallbackTaskDetailLink: mounted.wrapper.find(`a[href="/tasks/${tid}"]`).exists() }));
  mounted.unmount(); unmount = null;
  const healthyMount = await mountWorkbench(`/projects/${pid}/tasks`); unmount = healthyMount.unmount; await flush();
  expect(healthyMount.wrapper.text()).toContain("可恢复前置任务名称");
  console.log("TRIAGE_PROJECT_DEPENDENCY_HEALTHY_CONTROL", JSON.stringify({ detailReads, recoveredAfterRemount: true }));
  expect(restored, "server recovered but the same selected task cannot retry its swallowed dependency read failure").toBe(true);
});
