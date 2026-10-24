import { afterEach, describe, expect, it, vi } from "vitest";
import { flush, mountWorkbench } from "./mountApp";
import { activateRelayConnection, resetRelayConnectionForTest } from "../src/lib/relayConnection";

// 禅道 #34 / DEV-0126：详情只读最近 20 条历史时，窗口外的旧 BLOCKED 时段
// 必须仍然出现在「待处理的触发」里，且能补跑 / 忽略（走既有 resolutions 接口）。

const baseUrl = "http://127.0.0.1:8787";
const workspaceId = "11111111-1111-4111-8111-111111111111";
const projectId = "22222222-2222-4222-8222-222222222222";
const taskId = "33333333-3333-4333-8333-333333333333";
const root = `${baseUrl}/api/v1/workspaces/${workspaceId}`;
// 最旧的一条 BLOCKED；其余 20 条较新的 SKIPPED 占满默认 20 条窗口。
const oldBlockedId = "44444444-4444-4444-8444-000000000001";
let unmount: (() => void) | null = null;

afterEach(() => {
  unmount?.(); unmount = null;
  resetRelayConnectionForTest(); vi.unstubAllGlobals();
});

function connect() {
  activateRelayConnection({ baseUrl, workspaceId, bearerToken: "test-bearer-token-0123456789abcdef" });
}
function response(status: number, body: unknown): Response {
  return { ok: status >= 200 && status < 300, status, json: async () => body } as Response;
}
function occurrence(id: string, status: string, dueAt: string) {
  return { occurrence_id: id, scheduled_task_id: taskId, project_id: projectId,
    sequence: "1", due_at: dueAt, timezone: "Asia/Shanghai", missed: status === "BLOCKED",
    status, task_id: null, run_id: null,
    reason: status === "BLOCKED" ? "MISSED" : "PREVIOUS_TASK_NOT_ACCEPTED", revision: "1",
    created_at: dueAt };
}
function detailFixture() {
  const windowed = Array.from({ length: 20 }, (_unused, index) => occurrence(
    `44444444-4444-4444-8444-0000000001${String(index).padStart(2, "0")}`, "SKIPPED",
    `2026-10-23T01:00:00.000Z`));
  // 旧 BLOCKED 不在最近 20 条窗口内：created_at 早于窗口里任何一条。
  const oldest = occurrence(oldBlockedId, "BLOCKED", "2026-10-01T01:00:00.000Z");
  return { scheduled_task_id: taskId, project_id: projectId, title: "每早整理", status: "ENABLED",
    revision: "3", schedule_generation: "1", next_due_at: "2026-10-24T01:00:00.000Z",
    template: { task_title: "每早整理", objective: "整理昨日进展", criteria: [{ statement: "覆盖三项进展" }], mode: "AI_ASSIST" },
    repeat_rule: { kind: "DAILY", interval_days: 1 }, timezone: "Asia/Shanghai", local_time: "09:00",
    first_run_at: "2026-10-01T01:00:00.000Z", max_runs: 100, runs_reserved: 21, runs_started: 0,
    authorization_expires_at: "2026-11-18T01:00:00.000Z", created_at: "2026-10-01T00:00:00.000Z",
    history: [],
    project: { title: "甲项目", revision: "1", archived: false },
    occurrences: windowed,
    pending_occurrences: [oldest] };
}
function envelope(commandId: string, result: unknown) {
  return { command_id: commandId, committed_at: "2026-10-22T00:00:00.000Z",
    command_type: "ResolveScheduledTaskOccurrence", result, links: {} };
}
function common(url: string): Response | null {
  if (url.endsWith("/attention/interventions")) return response(200, { items: [] });
  if (url === `${root}/tasks?scope=all`) return response(200, { items: [], next_cursor: null });
  if (url === `${root}/assist-sessions?include_context=true`) return response(200, { items: [] });
  if (url === `${root}/projects?status=active`) return response(200, { items: [], next_cursor: null });
  return null;
}

describe("定时任务详情的窗口外待处理时段", () => {
  it("窗口外的旧 BLOCKED 出现在待处理的触发里，且可补跑与忽略", async () => {
    connect();
    const posted: { url: string; body: Record<string, unknown> }[] = [];
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const commonResponse = common(url);
      if (commonResponse) return commonResponse;
      if (url === `${root}/scheduled-tasks/${taskId}`) return response(200, detailFixture());
      if (url === `${root}/scheduled-task-occurrences/${oldBlockedId}/resolutions` && init?.method === "POST") {
        const body = JSON.parse(String(init.body)) as Record<string, unknown>;
        posted.push({ url, body });
        return response(200, envelope(String(body.command_id),
          { occurrence_id: oldBlockedId, scheduled_task_id: taskId,
            status: body.action === "RETRY" ? "DISPATCHING" : "RESOLVED", revision: "2" }));
      }
      throw new Error(`unexpected ${url}`);
    }));
    const mounted = await mountWorkbench(`/scheduled-tasks/${taskId}`); unmount = mounted.unmount;
    await flush(30);

    const pendingSection = mounted.wrapper.get('[data-testid="scheduled-task-blocked"]');
    expect(pendingSection.text()).toContain("应用关闭期间错过");
    expect(pendingSection.find(`[data-testid="scheduled-task-retry-${oldBlockedId}"]`).exists()).toBe(true);
    expect(pendingSection.find(`[data-testid="scheduled-task-dismiss-${oldBlockedId}"]`).exists()).toBe(true);

    const resolutionsUrl = `${root}/scheduled-task-occurrences/${oldBlockedId}/resolutions`;
    await pendingSection.get(`[data-testid="scheduled-task-retry-${oldBlockedId}"]`).trigger("click");
    await flush(30);
    expect(posted).toHaveLength(1);
    expect(posted[0]!.url).toBe(resolutionsUrl);
    expect(posted[0]!.body).toMatchObject({ action: "RETRY" });

    await pendingSection.get(`[data-testid="scheduled-task-dismiss-${oldBlockedId}"]`).trigger("click");
    await flush(30);
    expect(posted).toHaveLength(2);
    expect(posted[1]!.url).toBe(resolutionsUrl);
    expect(posted[1]!.body).toMatchObject({ action: "DISMISS" });
  });
});
