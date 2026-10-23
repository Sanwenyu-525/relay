import { afterEach, describe, expect, it, vi } from "vitest";
import { DomWrapper, flush, mountWorkbench } from "./mountApp";
import { activateRelayConnection, resetRelayConnectionForTest } from "../src/lib/relayConnection";

const baseUrl = "http://127.0.0.1:8787";
const workspaceId = "11111111-1111-4111-8111-111111111111";
const projectId = "22222222-2222-4222-8222-222222222222";
const taskId = "33333333-3333-4333-8333-333333333333";
const occurrenceId = "44444444-4444-4444-8444-444444444444";
const root = `${baseUrl}/api/v1/workspaces/${workspaceId}`;
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
function occurrence() {
  return { occurrence_id: occurrenceId, scheduled_task_id: taskId, project_id: projectId,
    sequence: "1", due_at: "2026-10-22T01:00:00.000Z", timezone: "Asia/Shanghai", missed: true,
    status: "BLOCKED", task_id: null, run_id: null, reason: "MISSED", revision: "1",
    created_at: "2026-10-22T01:00:00.000Z" };
}
function schedule(overrides: Record<string, unknown> = {}) {
  return { scheduled_task_id: taskId, project_id: projectId, title: "每早整理", status: "ENABLED",
    revision: "3", schedule_generation: "1", next_due_at: "2026-10-23T01:00:00.000Z",
    template: { task_title: "每早整理", objective: "整理昨日进展", criteria: [{ statement: "覆盖三项进展" }], mode: "AI_ASSIST" },
    repeat_rule: { kind: "DAILY", interval_days: 1 }, timezone: "Asia/Shanghai", local_time: "09:00",
    first_run_at: "2026-10-22T01:00:00.000Z", max_runs: 10, runs_reserved: 0, runs_started: 0,
    authorization_expires_at: "2026-11-18T01:00:00.000Z", created_at: "2026-10-21T00:00:00.000Z",
    project: { title: "甲项目", revision: "1", archived: false }, occurrences: [], ...overrides };
}
function statusResult(status: string) {
  return { scheduled_task_id: taskId, project_id: projectId, status, revision: "4",
    schedule_generation: "1", next_due_at: "2026-10-23T01:00:00.000Z" };
}
function envelope(commandId: string, commandType: string, result: unknown) {
  return { command_id: commandId, committed_at: "2026-10-22T00:00:00.000Z", command_type: commandType, result, links: {} };
}
function common(url: string): Response | null {
  if (url.endsWith("/attention/interventions")) return response(200, { items: [] });
  if (url === `${root}/tasks?scope=all`) return response(200, { items: [], next_cursor: null });
  if (url === `${root}/assist-sessions?include_context=true`) return response(200, { items: [] });
  if (url === `${root}/projects?status=active`) return response(200, { items: [], next_cursor: null });
  return null;
}
function button(label: string): HTMLButtonElement | undefined {
  return [...document.querySelectorAll("button")].find((node) => node.textContent === label) as HTMLButtonElement | undefined;
}
async function clickText(label: string) {
  const node = button(label);
  expect(node, `按钮 ${label}`).toBeDefined();
  await new DomWrapper(node ?? null).trigger("click");
}

describe("定时任务状态与时段处理的命令恢复", () => {
  it("列表暂停响应丢失后冻结原 command_id：重复点击不产生新命令，按原 ID 重试载荷一致", async () => {
    connect();
    const posted: Record<string, unknown>[] = [];
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const commonResponse = common(url);
      if (commonResponse) return commonResponse;
      if (url === `${root}/scheduled-tasks`) return response(200, { project_id: null, items: [schedule()] });
      if (url === `${root}/scheduled-tasks/${taskId}/status-changes` && init?.method === "POST") {
        const body = JSON.parse(String(init.body)) as Record<string, unknown>;
        posted.push(body);
        if (posted.length === 1) throw new TypeError("response lost after server commit");
        return response(200, envelope(String(body.command_id), "SetScheduledTaskStatus", statusResult("PAUSED")));
      }
      if (url.startsWith(`${root}/commands/`)) {
        const commandId = decodeURIComponent(url.slice(`${root}/commands/`.length));
        return response(404, { code: "COMMAND_NOT_FOUND", detail: "command not found", command_id: commandId });
      }
      throw new Error(`unexpected ${url}`);
    }));
    const mounted = await mountWorkbench("/scheduled-tasks"); unmount = mounted.unmount;
    await flush(30);
    await clickText("暂停");
    await flush(30);

    expect(posted).toHaveLength(1);
    const commandId = String(posted[0]!.command_id);
    expect(mounted.wrapper.get('[data-testid="scheduled-status-pending"]').text()).toContain(commandId);
    expect(mounted.wrapper.text()).toContain("本次提交是否生效尚未确定");
    expect(button("暂停")!.disabled).toBe(true);
    expect(button("停用")!.disabled).toBe(true);

    await clickText("暂停");
    await flush(30);
    expect(posted).toHaveLength(1);

    await clickText("核对原命令回执");
    await flush(30);
    expect(mounted.wrapper.text()).toContain("原命令暂未查到回执");
    await clickText("按原 ID 重试同一变更");
    await flush(30);
    expect(posted).toHaveLength(2);
    expect(posted[1]).toEqual(posted[0]);
    expect(mounted.wrapper.find('[data-testid="scheduled-status-pending"]').exists()).toBe(false);
  });

  it("列表 HTTP 500 也按结果未知处理：保留原 command_id，回执命中后收口", async () => {
    connect();
    const posted: Record<string, unknown>[] = [];
    let receiptChecks = 0;
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const commonResponse = common(url);
      if (commonResponse) return commonResponse;
      if (url === `${root}/scheduled-tasks`) return response(200, { project_id: null, items: [schedule()] });
      if (url === `${root}/scheduled-tasks/${taskId}/status-changes` && init?.method === "POST") {
        posted.push(JSON.parse(String(init.body)) as Record<string, unknown>);
        return response(500, { code: "INTERNAL_ERROR", detail: "服务端已处理，但响应链失败" });
      }
      if (url.startsWith(`${root}/commands/`)) {
        receiptChecks += 1;
        const commandId = decodeURIComponent(url.slice(`${root}/commands/`.length));
        return response(200, envelope(commandId, "SetScheduledTaskStatus", statusResult("PAUSED")));
      }
      throw new Error(`unexpected ${url}`);
    }));
    const mounted = await mountWorkbench("/scheduled-tasks"); unmount = mounted.unmount;
    await flush(30);
    await clickText("暂停");
    await flush(30);

    expect(posted).toHaveLength(1);
    expect(mounted.wrapper.get('[data-testid="scheduled-status-pending"]').text()).toContain(String(posted[0]!.command_id));
    expect(button("暂停")!.disabled).toBe(true);

    await clickText("核对原命令回执");
    await flush(30);
    expect(receiptChecks).toBe(1);
    expect(mounted.wrapper.find('[data-testid="scheduled-status-pending"]').exists()).toBe(false);
    expect(posted).toHaveLength(1);
  });

  it("列表明确业务拒绝才解锁：版本冲突后允许修正输入并以新 command_id 重发", async () => {
    connect();
    const posted: Record<string, unknown>[] = [];
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const commonResponse = common(url);
      if (commonResponse) return commonResponse;
      if (url === `${root}/scheduled-tasks`) return response(200, { project_id: null, items: [schedule()] });
      if (url === `${root}/scheduled-tasks/${taskId}/status-changes` && init?.method === "POST") {
        posted.push(JSON.parse(String(init.body)) as Record<string, unknown>);
        if (posted.length === 1) {
          return response(409, { code: "REVISION_CONFLICT", detail: "版本已变化",
            conflict: { expected_revision: "3", actual_revision: "4" } });
        }
        return response(200, envelope(String(posted[posted.length - 1]!.command_id), "SetScheduledTaskStatus", statusResult("PAUSED")));
      }
      throw new Error(`unexpected ${url}`);
    }));
    const mounted = await mountWorkbench("/scheduled-tasks"); unmount = mounted.unmount;
    await flush(30);
    await clickText("暂停");
    await flush(30);

    expect(posted).toHaveLength(1);
    expect(mounted.wrapper.text()).toContain("状态修改失败");
    expect(mounted.wrapper.find('[data-testid="scheduled-status-pending"]').exists()).toBe(false);
    expect(button("暂停")!.disabled).toBe(false);

    await clickText("暂停");
    await flush(30);
    expect(posted).toHaveLength(2);
    expect(posted[1]!.command_id).not.toBe(posted[0]!.command_id);
    expect(mounted.wrapper.find('[data-testid="scheduled-status-pending"]').exists()).toBe(false);
  });

  it("详情补跑响应丢失后冻结原 command_id：重复点击不产生新命令，按原 ID 重试载荷一致", async () => {
    connect();
    const posted: Record<string, unknown>[] = [];
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const commonResponse = common(url);
      if (commonResponse) return commonResponse;
      if (url === `${root}/scheduled-tasks/${taskId}`) return response(200, schedule({ occurrences: [occurrence()] }));
      if (url === `${root}/scheduled-task-occurrences/${occurrenceId}/resolutions` && init?.method === "POST") {
        const body = JSON.parse(String(init.body)) as Record<string, unknown>;
        posted.push(body);
        if (posted.length === 1) throw new TypeError("response lost after server commit");
        return response(200, envelope(String(body.command_id), "ResolveScheduledTaskOccurrence",
          { occurrence_id: occurrenceId, status: "RETRY_QUEUED", revision: "2" }));
      }
      if (url.startsWith(`${root}/commands/`)) return response(404, { code: "COMMAND_NOT_FOUND", detail: "command not found" });
      throw new Error(`unexpected ${url}`);
    }));
    const mounted = await mountWorkbench(`/scheduled-tasks/${taskId}`); unmount = mounted.unmount;
    await flush(30);
    await clickText("补跑一次");
    await flush(30);

    expect(posted).toHaveLength(1);
    const commandId = String(posted[0]!.command_id);
    expect(mounted.wrapper.get('[data-testid="scheduled-detail-pending"]').text()).toContain(commandId);
    expect(mounted.wrapper.text()).toContain("本次提交是否生效尚未确定");
    expect(button("补跑一次")!.disabled).toBe(true);
    expect(button("忽略")!.disabled).toBe(true);

    await clickText("补跑一次");
    await flush(30);
    expect(posted).toHaveLength(1);

    await clickText("核对原命令回执");
    await flush(30);
    expect(mounted.wrapper.text()).toContain("原命令暂未查到回执");
    await clickText("按原 ID 重试同一命令");
    await flush(30);
    expect(posted).toHaveLength(2);
    expect(posted[1]).toEqual(posted[0]);
    expect(mounted.wrapper.find('[data-testid="scheduled-detail-pending"]').exists()).toBe(false);
  });

  it("详情回执对象不匹配时不放行：仍停留在待核对且不发送新命令", async () => {
    connect();
    const posted: Record<string, unknown>[] = [];
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const commonResponse = common(url);
      if (commonResponse) return commonResponse;
      if (url === `${root}/scheduled-tasks/${taskId}`) return response(200, schedule({ occurrences: [occurrence()] }));
      if (url === `${root}/scheduled-task-occurrences/${occurrenceId}/resolutions` && init?.method === "POST") {
        posted.push(JSON.parse(String(init.body)) as Record<string, unknown>);
        return response(500, { code: "INTERNAL_ERROR", detail: "服务端已处理，但响应链失败" });
      }
      if (url.startsWith(`${root}/commands/`)) {
        const commandId = decodeURIComponent(url.slice(`${root}/commands/`.length));
        return response(200, envelope(commandId, "ResolveScheduledTaskOccurrence",
          { occurrence_id: "55555555-5555-4555-8555-555555555555", status: "RETRY_QUEUED", revision: "2" }));
      }
      throw new Error(`unexpected ${url}`);
    }));
    const mounted = await mountWorkbench(`/scheduled-tasks/${taskId}`); unmount = mounted.unmount;
    await flush(30);
    await clickText("补跑一次");
    await flush(30);
    expect(posted).toHaveLength(1);

    await clickText("核对原命令回执");
    await flush(30);
    expect(mounted.wrapper.text()).toContain("仍需核对");
    expect(mounted.wrapper.find('[data-testid="scheduled-detail-pending"]').exists()).toBe(true);
    expect(button("补跑一次")!.disabled).toBe(true);
    expect(posted).toHaveLength(1);
  });

  it("详情首次读取失败后就地重新读取同一任务，期间没有任何写命令", async () => {
    connect();
    let detailReads = 0;
    const writes: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const commonResponse = common(url);
      if (commonResponse) return commonResponse;
      if (url === `${root}/scheduled-tasks/${taskId}`) {
        detailReads += 1;
        if (detailReads === 1) throw new TypeError("temporary read failure");
        return response(200, schedule());
      }
      if (init?.method === "POST") writes.push(url);
      throw new Error(`unexpected ${url}`);
    }));
    const mounted = await mountWorkbench(`/scheduled-tasks/${taskId}`); unmount = mounted.unmount;
    await flush(30);

    expect(mounted.wrapper.text()).toContain("这条定时任务当前无法读取");
    await mounted.wrapper.get('[data-testid="scheduled-task-detail-reread"]').trigger("click");
    await flush(30);

    expect(detailReads).toBe(2);
    expect(mounted.wrapper.text()).toContain("每早整理");
    expect(mounted.wrapper.find('[data-testid="scheduled-task-detail-reread"]').exists()).toBe(false);
    expect(writes).toEqual([]);
  });
});
