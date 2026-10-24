import { act, createElement } from "react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, expect, it, vi } from "vitest";
import AssistView from "../../src/views/AssistView";
import { activateRelayConnection, resetRelayConnectionForTest } from "../../src/lib/relayConnection";
import { mountReact } from "../../tests/mountApp";
const wid = "11111111-1111-4111-8111-111111111111";
const pid = "22222222-2222-4222-8222-222222222222";
const sid = "33333333-3333-4333-8333-333333333333";
let unmount: (() => void) | null = null;
const originalClipboard=Object.getOwnPropertyDescriptor(navigator,"clipboard");
afterEach(() => { unmount?.(); unmount = null; vi.clearAllTimers(); vi.useRealTimers(); resetRelayConnectionForTest(); vi.unstubAllGlobals();vi.restoreAllMocks(); if(originalClipboard)Object.defineProperty(navigator,"clipboard",originalClipboard);else Reflect.deleteProperty(navigator,"clipboard"); });
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
it("当前只复制Markdown的计划按钮应准确说明复制，不应称为导出文件", async () => {
  const kind="start";
  const clipboardWrite=vi.fn(async()=>undefined);
  Object.defineProperty(navigator,"clipboard",{configurable:true,value:{writeText:clipboardWrite}});
  const downloads:string[]=[];
  vi.spyOn(HTMLAnchorElement.prototype,"click").mockImplementation(function(){if(this.download)downloads.push(this.download);});
  vi.useFakeTimers();
  const submitted: string[] = [];
  let receiptReads = 0;
  let goalReads = 0;
  let messageReads = 0;
  const session = { id: sid, workspace_id: wid, project_id: pid, task_id: null, title: "goal recovery probe", status: "ACTIVE", revision: "1", chat_mode: "GOAL", created_at: "2026-10-23T00:00:00Z", updated_at: "2026-10-23T00:00:00Z" };
  const goal = { goal_id: "44444444-4444-4444-8444-444444444444", session_id: sid, objective: "GOAL_RECOVERY_PROBE", status: "BUDGET_EXHAUSTED", current_step: null, progress: null, stop_reason: {code:"MODEL_BUDGET_EXHAUSTED",detail:"额度耗尽",questions:[],resumable:true}, criteria: [], steps: [], round_count: 1, no_progress_rounds: 0, plan_version_id: null, plan_version: null, last_round_at: null, actions: {pause:false,cancel:true,resume:true,confirm_completion:false}, revision: "1", created_at:"2026-10-23T00:00:00Z", updated_at:"2026-10-23T00:00:00Z" };
  const plan={plan_id:"55555555-5555-4555-8555-555555555555",session_id:sid,version:1,status:"CURRENT",goal:"PLAN_EXECUTION_PROBE",scope:[],steps:[],verification:[],open_questions:[],source_message_id:"66666666-6666-4666-8666-666666666666",created_at:"2026-10-23T00:00:00Z"};
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?:RequestInit) => {
    const p = new URL(String(input)).pathname;
    if((p.endsWith(`/assist-goals/${goal.goal_id}/resume`) || p.endsWith(`/assist-sessions/${sid}/goals`)) && init?.method==="POST") {
      submitted.push(JSON.parse(String(init.body)).command_id);
      throw new TypeError("Failed to fetch after server accepted command");
    }
    if(p.includes('/commands/')) {receiptReads++; return json({code:"NOT_FOUND"},404);}
    if (p.endsWith(`/projects/${pid}`)) return json({ id: pid, title: "goal project", project_type: "GENERAL", revision: "1", state_revision: "1", archived_at: null });
    if (p.endsWith(`/projects/${pid}/state`)) return json({ project_id: pid, revision: "1", phase_key: "GENERAL", next_action_task_id: null, selected_artifact_version_refs: [], completed_highlight_refs: [] });
    if (p.endsWith("/assist-sessions")) return json({ items: [session] });
    if (p.endsWith(`/assist-sessions/${sid}`)) return json(session);
    if (p.endsWith(`/assist-sessions/${sid}/goal`)) { goalReads++; return json({goal:kind==="resume"?goal:null,rounds:[]}); }
    if (p.endsWith(`/assist-sessions/${sid}/plans`)) return json(kind==="start"?{latest:plan,versions:[plan]}:{latest:null,versions:[]});
    if (p.endsWith(`/assist-sessions/${sid}/messages`)) {messageReads++; return json({items:[]});}
    if (p.endsWith("/model-selection")) return json({ model: null, revision: "0" });
    if (p.endsWith("/model-port")) return json({ provider: "fake", configured: false, model: null, base_url: null, max_call_tokens: null });
    if (p.endsWith("/model-port/verification")) return json({ current_config_fingerprint: null, last: null, matches_current_config: false, worker_startup_validation: "NOT_CONFIGURED" });
    if (p.endsWith("/default-working-directory")) return json({ resource_id: null, canonical_root: null, display_name: null, write_tier: null, default_write_tier: null, status: "UNSET", reason: null, revision: "0" });
    if (p.endsWith("/memory-settings")) return json({ workspace_id: wid, revision: "0", recall_enabled: true, automatic_compaction: true, auto_capture: true });
    return json({ items: [], next_cursor: null });
  }));
  activateRelayConnection({ baseUrl: "http://127.0.0.1:8787", workspaceId: wid, bearerToken: "test-token" });
  const element = () => createElement(MemoryRouter, { initialEntries: [`/projects/${pid}?skill=assist`] }, createElement(AssistView, { targetKind: "PROJECT", targetId: pid }));
  const mounted = await mountReact(element()); unmount = mounted.unmount;
  await act(async () => { await vi.advanceTimersByTimeAsync(100); });
  const button='[data-testid="plan-card-export"]';
  expect(mounted.wrapper.find(button).exists()).toBe(true);
  await mounted.wrapper.get(button).trigger("click");
  await act(async () => { await vi.advanceTimersByTimeAsync(100); });
  console.log("TRIAGE_PLAN_FILE_EXPORT",JSON.stringify({buttonLabel:mounted.wrapper.get(button).text(),clipboardCalls:clipboardWrite.mock.calls.length,clipboardText:clipboardWrite.mock.calls[0],downloads,postCount:submitted.length}));
  expect(clipboardWrite).toHaveBeenCalledTimes(1);
  expect(downloads).toHaveLength(0);
  expect(mounted.wrapper.get(button).text(),"documented current behavior is clipboard copy; label must not promise an unimplemented file export").toContain("复制");
});
