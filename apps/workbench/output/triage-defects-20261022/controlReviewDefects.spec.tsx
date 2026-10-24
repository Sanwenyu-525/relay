import { afterEach, expect, it, vi } from "vitest";
import { createElement } from "react";
import RunControlPanel, { type RunControlState } from "../../src/components/RunControlPanel";
import { activateRelayConnection, resetRelayConnectionForTest } from "../../src/lib/relayConnection";
import { flush, mountReact, mountWorkbench } from "../../tests/mountApp";

const baseUrl = "http://127.0.0.1:8787";
const workspaceId = "11111111-1111-4111-8111-111111111111";
const reviewId = "22222222-2222-4222-8222-222222222222";
const reviewUrl = `${baseUrl}/api/v1/workspaces/${workspaceId}/reviews`;
let unmount: (() => void) | null = null;
afterEach(() => { unmount?.(); unmount = null; resetRelayConnectionForTest(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });
function response(status: number, body: unknown): Response {
  return { ok: status >= 200 && status < 300, status, json: async () => body } as Response;
}
function review(expiresAt: string | null = null) {
  return { id: reviewId, kind: "CRITERION", status: "OPEN", revision: "1", project_id: null,
    task_id: "33333333-3333-4333-8333-333333333333", run_id: "44444444-4444-4444-8444-444444444444",
    reason: "private-review-evidence-sentinel", target_hash: "a".repeat(64),
    target: { artifact_version_id: "55555555-5555-4555-8555-555555555555", acceptance_revision: "1", criterion_id: "human" },
    evidence: { summary: "private-review-evidence-sentinel" }, effect: { on_accept: "重新核对完成条件" },
    allowed_decisions: ["ACCEPT", "REQUEST_CHANGES"], expires_at: expiresAt,
    created_at: "2026-10-22T00:00:00.000Z", decided_at: null };
}
function activate() { activateRelayConnection({ baseUrl, workspaceId, bearerToken: "test-token" }); }

it("页面跨过有效期后，提交处理器应按当前时间阻止过期决定", async () => {
  activate();
  let now = Date.parse("2026-10-22T00:00:00.000Z");
  vi.spyOn(Date, "now").mockImplementation(() => now);
  const item = review("2026-10-22T00:01:00.000Z");
  let posts = 0;
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (init?.method === "POST") { posts++; return response(409, { code: "REVIEW_EXPIRED", detail: "请求已过期" }); }
    if (url === `${reviewUrl}?status=OPEN`) return response(200, { items: [item] });
    if (url === `${reviewUrl}/${reviewId}`) return response(200, item);
    if (url.endsWith("/artifacts")) return response(200, { items: [], current_accepted_version_ids: [] });
    if (url.endsWith("/attention/interventions")) return response(200, { items: [] });
    if (url.endsWith("/tasks?scope=all") || url.endsWith("/projects?status=active")) return response(200, { items: [], next_cursor: null });
    throw new Error(`unexpected ${url}`);
  }));
  const mounted = await mountWorkbench("/reviews"); unmount = mounted.unmount; await flush();
  expect(mounted.wrapper.get('[data-testid="review-decision-ACCEPT"]').attributes("disabled")).toBeUndefined();
  now += 120_000;
  await mounted.wrapper.get('[data-testid="review-decision-ACCEPT"]').trigger("click"); await flush();
  expect(posts).toBe(0);
});

it("刷新得到读取失权403后应清除旧判断依据，不能只禁用写按钮", async () => {
  activate(); const item = review(); let denied = false;
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url === `${reviewUrl}?status=OPEN`) return denied ? response(403, { code: "FORBIDDEN", detail: "请求不可读取" }) : response(200, { items: [item] });
    if (url === `${reviewUrl}/${reviewId}`) return response(200, item);
    if (url.endsWith("/artifacts")) return response(200, { items: [], current_accepted_version_ids: [] });
    if (url.endsWith("/attention/interventions")) return response(200, { items: [] });
    if (url.endsWith("/tasks?scope=all") || url.endsWith("/projects?status=active")) return response(200, { items: [], next_cursor: null });
    throw new Error(`unexpected ${url}`);
  }));
  const mounted = await mountWorkbench("/reviews"); unmount = mounted.unmount; await flush();
  expect(mounted.wrapper.text()).toContain("private-review-evidence-sentinel");
  denied = true;
  await mounted.wrapper.get('[data-testid="review-refresh"]').trigger("click"); await flush();
  expect(mounted.wrapper.get('[data-testid="review-read-error"]').text()).toContain("请求不可读取");
  expect(mounted.wrapper.get('[data-testid="review-decision-ACCEPT"]').attributes("disabled")).toBeDefined();
  expect(mounted.wrapper.text()).not.toContain("private-review-evidence-sentinel");
});

it("Run暂停收到明确要求核对回执的503后不能换新命令再发", async () => {
  activate(); window.sessionStorage.clear();
  const ids: string[] = [];
  vi.stubGlobal("fetch", vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
    if (init?.method === "POST") {
      ids.push(JSON.parse(String(init.body)).command_id);
      return response(503, { code: "DATABASE_UNAVAILABLE", detail: "response uncertain", retry_action: "CHECK_RECEIPT_THEN_RETRY" });
    }
    throw new Error("unexpected read");
  }));
  const state = { run: { id: "44444444-4444-4444-8444-444444444444", revision: "1", status: "RUNNING", pendingControlRequest: null, waitReason: null },
    task: { id: "33333333-3333-4333-8333-333333333333", revision: "1", executor: "AI", status: "IN_PROGRESS" },
    controlRecord: null, activeRun: true, terminal: false, projectWriteBlockedReason: null } as RunControlState;
  const mounted = await mountReact(createElement(RunControlPanel, { state, onReload: vi.fn() })); unmount = mounted.unmount;
  await mounted.wrapper.get('[data-testid="run-control-PAUSE"]').trigger("click"); await flush();
  const pause = mounted.wrapper.find('[data-testid="run-control-PAUSE"]');
  if (pause.exists()) { await pause.trigger("click"); await flush(); }
  console.log("TRIAGE_RUN_CONTROL_503", JSON.stringify(ids));
  expect(new Set(ids).size).toBe(1);
  expect(mounted.wrapper.find('[data-testid="run-check-receipt"]').exists()).toBe(true);
});

it("Review决定收到明确要求核对回执的503后不能换新命令再发", async () => {
  activate(); const item = review(); const ids: string[] = [];
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (init?.method === "POST") {
      ids.push(JSON.parse(String(init.body)).command_id);
      return response(503, { code: "DATABASE_UNAVAILABLE", detail: "response uncertain", retry_action: "CHECK_RECEIPT_THEN_RETRY" });
    }
    if (url === `${reviewUrl}?status=OPEN`) return response(200, { items: [item] });
    if (url === `${reviewUrl}/${reviewId}`) return response(200, item);
    if (url.endsWith("/artifacts")) return response(200, { items: [], current_accepted_version_ids: [] });
    if (url.endsWith("/attention/interventions")) return response(200, { items: [] });
    if (url.endsWith("/tasks?scope=all") || url.endsWith("/projects?status=active")) return response(200, { items: [], next_cursor: null });
    throw new Error(`unexpected ${url}`);
  }));
  const mounted = await mountWorkbench("/reviews"); unmount = mounted.unmount; await flush();
  await mounted.wrapper.get('[data-testid="review-decision-ACCEPT"]').trigger("click"); await flush();
  const accept = mounted.wrapper.find('[data-testid="review-decision-ACCEPT"]');
  if (accept.exists()) { await accept.trigger("click"); await flush(); }
  console.log("TRIAGE_REVIEW_503", JSON.stringify(ids));
  expect(new Set(ids).size).toBe(1);
  expect(mounted.wrapper.find('[data-testid="review-check-receipt"]').exists()).toBe(true);
});
