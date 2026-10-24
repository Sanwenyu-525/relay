import { afterEach, expect, it, vi } from "vitest";
import { DomWrapper, flush, mountWorkbench } from "../../tests/mountApp";
import { activateRelayConnection, resetRelayConnectionForTest } from "../../src/lib/relayConnection";

const wid = "11111111-1111-4111-8111-111111111111";
const pid = "22222222-2222-4222-8222-222222222222";
const sid = "33333333-3333-4333-8333-333333333333";
const base = `http://127.0.0.1:8787/api/v1/workspaces/${wid}`;
let cleanup: (() => void) | undefined;
afterEach(() => { cleanup?.(); cleanup = undefined; resetRelayConnectionForTest(); vi.unstubAllGlobals(); });

function response(body: unknown, status = 200): Response {
  return { ok: status < 400, status, json: async () => body } as Response;
}
function schedule(id = sid) {
  return { scheduled_task_id: id, project_id: pid, title: "triage schedule", status: "ENABLED", revision: "1",
    schedule_generation: "1", next_due_at: "2026-11-01T01:00:00.000Z",
    template: { task_title: "triage task", objective: "read only probe", criteria: [{ statement: "evidence" }], mode: "AI_ASSIST" },
    repeat_rule: { kind: "DAILY", interval_days: 1 }, timezone: "Asia/Shanghai", local_time: "09:00",
    first_run_at: "2026-11-01T01:00:00.000Z", max_runs: 5, runs_reserved: 0, runs_started: 0,
    authorization_expires_at: "2026-11-10T01:00:00.000Z", created_at: "2026-10-22T00:00:00.000Z",
    project: { title: "probe project", revision: "1", archived: false }, occurrences: [] };
}
function connect() {
  activateRelayConnection({ baseUrl: "http://127.0.0.1:8787", workspaceId: wid, bearerToken: "probe-token-not-a-real-credential" });
}
function common(url: string) {
  if (url.endsWith("/attention/interventions")) return response({ items: [] });
  if (url.endsWith("/tasks?scope=all")) return response({ items: [], next_cursor: null });
  if (url.includes("/assist-sessions")) return response({ items: [] });
  if (url.includes("/projects?")) return response({ items: [], next_cursor: null });
  return response({ items: [] });
}
function clickText(text: string) {
  const button = [...document.querySelectorAll("button")].find((node) => node.textContent === text);
  expect(button, `button ${text}`).toBeDefined();
  return new DomWrapper(button ?? null).trigger("click");
}

it("list must not replace command identity after an uncertain status response", async () => {
  connect(); const posted: { command_id: string }[] = [];
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url === `${base}/scheduled-tasks`) return response({ project_id: null, items: [schedule()] });
    if (url === `${base}/scheduled-tasks/${sid}/status-changes`) {
      posted.push(JSON.parse(String(init?.body))); throw new TypeError("response lost after server commit");
    }
    return common(url);
  }));
  const mounted = await mountWorkbench("/scheduled-tasks"); cleanup = mounted.unmount;
  await flush(30); await clickText("暂停"); await flush(30);
  expect(mounted.wrapper.text()).toContain("本次提交是否生效尚未确定");
  await clickText("暂停"); await flush(30);
  console.log("TRIAGE_STATUS_IDS", posted.map((p) => p.command_id));
  expect(new Set(posted.map((p) => p.command_id)).size, "uncertain command must retain one identity").toBe(1);
});

it("detail must not replace command identity after an uncertain retry response", async () => {
  connect(); const posted: { command_id: string }[] = [];
  const oid = "44444444-4444-4444-8444-444444444444";
  const item = { ...schedule(), occurrences: [{ occurrence_id: oid, scheduled_task_id: sid, project_id: pid,
    sequence: "1", due_at: "2026-10-22T01:00:00.000Z", timezone: "Asia/Shanghai", missed: true,
    status: "BLOCKED", task_id: null, run_id: null, reason: "MISSED", revision: "1", created_at: "2026-10-22T01:00:00.000Z" }] };
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url === `${base}/scheduled-tasks/${sid}`) return response(item);
    if (url === `${base}/scheduled-task-occurrences/${oid}/resolutions`) {
      posted.push(JSON.parse(String(init?.body))); throw new TypeError("response lost after server commit");
    }
    return common(url);
  }));
  const mounted = await mountWorkbench(`/scheduled-tasks/${sid}`); cleanup = mounted.unmount;
  await flush(30); await clickText("补跑一次"); await flush(30);
  expect(mounted.wrapper.text()).toContain("本次提交是否生效尚未确定");
  await clickText("补跑一次"); await flush(30);
  console.log("TRIAGE_RETRY_IDS", posted.map((p) => p.command_id));
  expect(new Set(posted.map((p) => p.command_id)).size, "uncertain retry must retain one identity").toBe(1);
});

it("detail read failure must offer a local retry without route detour", async () => {
  connect();
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
    if (String(input) === `${base}/scheduled-tasks/${sid}`) throw new TypeError("temporary read failure");
    return common(String(input));
  }));
  const mounted = await mountWorkbench(`/scheduled-tasks/${sid}`); cleanup = mounted.unmount;
  await flush(30);
  expect(mounted.wrapper.text()).toContain("这条定时任务当前无法读取");
  const retry = [...document.querySelectorAll("main button")].find((button) => /重试|重新读取|刷新/u.test(button.textContent ?? ""));
  expect(retry, "transient detail read error has no local retry").toBeDefined();
});
