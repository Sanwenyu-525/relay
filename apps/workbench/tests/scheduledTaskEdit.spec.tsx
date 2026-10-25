import { afterEach, describe, expect, it, vi } from "vitest";
import { flush, mountWorkbench } from "./mountApp";
import { activateRelayConnection, resetRelayConnectionForTest } from "../src/lib/relayConnection";

const baseUrl = "http://127.0.0.1:8787";
const workspaceId = "11111111-1111-4111-8111-111111111111";
const projectId = "22222222-2222-4222-8222-222222222222";
const taskId = "33333333-3333-4333-8333-333333333333";
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
function envelope(commandId: string, result: unknown) {
  return { command_id: commandId, committed_at: "2026-10-25T00:00:00.000Z", result, links: {} };
}

/** 已到期的每周计划：编辑页回填以它为准（revision 7、WEEKLY 周一/周四、次数用尽）。 */
function expiredWeeklyDetail() {
  return {
    scheduled_task_id: taskId, project_id: projectId, status: "EXPIRED", revision: "7",
    schedule_generation: "2", next_due_at: null, title: "每周核对样例",
    template: { task_title: "核对样例", objective: "只核对A样例", criteria: [{ statement: "A样例通过" }], mode: "AI_ASSIST" },
    repeat_rule: { kind: "WEEKLY", weekdays: [1, 4] }, timezone: "Asia/Shanghai", local_time: "09:30",
    first_run_at: "2026-10-19T01:30:00.000Z", max_runs: 5, runs_started: 5,
    authorization_expires_at: "2026-10-24T00:00:00.000Z", created_at: "2026-10-10T00:00:00.000Z",
    history: [],
    project: { title: "甲项目", revision: "1", archived: false },
    occurrences: [],
    pending_occurrences: [],
  };
}
function blockedOccurrence(reason: string) {
  return { occurrence_id: "44444444-4444-4444-8444-444444444444", scheduled_task_id: taskId, project_id: projectId,
    schedule_generation: "2", sequence: "3", due_at: "2026-10-23T01:30:00.000Z", timezone: "Asia/Shanghai",
    missed: true, status: "BLOCKED", task_id: null, run_id: null, reason, revision: "9",
    created_at: "2026-10-23T01:30:00.000Z" };
}
function common(url: string): Response | null {
  if (url.endsWith("/attention/interventions")) return response(200, { items: [] });
  for (const prefix of [root]) {
    if (url === `${prefix}/tasks?scope=all`) return response(200, { items: [], next_cursor: null });
    if (url === `${prefix}/assist-sessions?include_context=true`) return response(200, { items: [] });
    if (url === `${prefix}/projects?status=active`) return response(200, { items: [], next_cursor: null });
  }
  if (url === `${root}/scheduled-tasks`) return response(200, { project_id: null, items: [] });
  return null;
}

describe("定时任务编辑（P0-B）", () => {
  it("编辑页按详情回填（含周规则勾选），保存携带 expected_revision 与原因，成功后回详情", async () => {
    connect();
    const edits: Record<string, unknown>[] = [];
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const commonResponse = common(url);
      if (commonResponse) return commonResponse;
      if (url === `${root}/scheduled-tasks/${taskId}`) return response(200, expiredWeeklyDetail());
      if (url === `${root}/scheduled-tasks/${taskId}/edits` && init?.method === "POST") {
        edits.push(JSON.parse(String(init.body)) as Record<string, unknown>);
        return response(200, envelope(String(edits[0]!.command_id), {
          scheduled_task_id: taskId, project_id: projectId, status: "EXPIRED", revision: "8",
          schedule_generation: "2", next_due_at: null }));
      }
      throw new Error(`unexpected ${url}`);
    }));
    const mounted = await mountWorkbench(`/scheduled-tasks/${taskId}/edit`); unmount = mounted.unmount;
    await flush(30);

    // 回填：标题、验收标准按行合并、周规则勾选周一/周四、项目只读、到期计划提示先编辑再启用。
    expect((mounted.wrapper.get('[data-testid="scheduled-task-title"]').element as HTMLInputElement).value).toBe("每周核对样例");
    expect((mounted.wrapper.get('[data-testid="scheduled-task-criteria"]').element as HTMLTextAreaElement).value).toBe("A样例通过");
    expect((mounted.wrapper.find('[data-testid="scheduled-task-weekday-1"]').element as HTMLInputElement).checked).toBe(true);
    expect((mounted.wrapper.find('[data-testid="scheduled-task-weekday-4"]').element as HTMLInputElement).checked).toBe(true);
    expect((mounted.wrapper.find('[data-testid="scheduled-task-weekday-2"]').element as HTMLInputElement).checked).toBe(false);
    expect(mounted.wrapper.get('[data-testid="scheduled-task-edit-project-readonly"]').attributes("disabled")).toBeDefined();
    expect(mounted.wrapper.text()).toContain("仍保持「已到期」");

    await mounted.wrapper.get('[data-testid="scheduled-task-title"]').setValue("每周核对样例（改）");
    await mounted.wrapper.get('[data-testid="scheduled-task-expires-at"]').setValue("2026-11-20T09:00");
    await mounted.wrapper.get('[data-testid="scheduled-task-edit-reason"]').setValue("延长授权两周");
    await mounted.wrapper.get("form.create-form").trigger("submit");
    await flush(30);

    expect(edits).toHaveLength(1);
    expect(edits[0]!.expected_revision).toBe("7");
    expect(edits[0]!.reason).toBe("延长授权两周");
    expect(edits[0]!.title).toBe("每周核对样例（改）");
    expect(edits[0]!.repeat_rule).toEqual({ kind: "WEEKLY", weekdays: [1, 4] });
    expect((edits[0]!.template as Record<string, unknown>).task_title).toBe("核对样例");
    expect(mounted.router.currentRoute.value.path).toBe(`/scheduled-tasks/${taskId}`);
  });

  it("修改原因是编辑的必填项：缺原因不提交任何命令", async () => {
    connect();
    const edits: unknown[] = [];
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const commonResponse = common(url);
      if (commonResponse) return commonResponse;
      if (url === `${root}/scheduled-tasks/${taskId}`) return response(200, expiredWeeklyDetail());
      if (url === `${root}/scheduled-tasks/${taskId}/edits` && init?.method === "POST") {
        edits.push(init.body); return response(200, envelope("c", {}));
      }
      throw new Error(`unexpected ${url}`);
    }));
    const mounted = await mountWorkbench(`/scheduled-tasks/${taskId}/edit`); unmount = mounted.unmount;
    await flush(30);

    await mounted.wrapper.get('[data-testid="scheduled-task-title"]').setValue("只改标题");
    await mounted.wrapper.get("form.create-form").trigger("submit");
    await flush(30);
    expect(edits).toHaveLength(0);
    expect(mounted.wrapper.text()).toContain("需要说明这次修改的原因");
  });

  it("修改响应未知冻结原命令：回执未到只许原 ID 重试；回执命中（EditScheduledTask 且对象一致）才回详情", async () => {
    connect();
    const edits: Record<string, unknown>[] = [];
    let receiptFound = false;
    let receiptChecks = 0;
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const commonResponse = common(url);
      if (commonResponse) return commonResponse;
      if (url === `${root}/scheduled-tasks/${taskId}`) return response(200, expiredWeeklyDetail());
      if (url === `${root}/scheduled-tasks/${taskId}/edits` && init?.method === "POST") {
        edits.push(JSON.parse(String(init.body)) as Record<string, unknown>);
        throw new TypeError("response lost");
      }
      if (url.startsWith(`${root}/commands/`)) {
        receiptChecks += 1;
        const commandId = decodeURIComponent(url.slice(`${root}/commands/`.length));
        if (!receiptFound) return response(404, { code: "COMMAND_NOT_FOUND", detail: "command not found" });
        return response(200, { ...envelope(commandId, {
          scheduled_task_id: taskId, project_id: projectId, status: "EXPIRED", revision: "8",
          schedule_generation: "2", next_due_at: null }), command_type: "EditScheduledTask" });
      }
      throw new Error(`unexpected ${url}`);
    }));
    const mounted = await mountWorkbench(`/scheduled-tasks/${taskId}/edit`); unmount = mounted.unmount;
    await flush(30);
    await mounted.wrapper.get('[data-testid="scheduled-task-title"]').setValue("待核对标题");
    await mounted.wrapper.get('[data-testid="scheduled-task-edit-reason"]').setValue("改标题");
    await mounted.wrapper.get("form.create-form").trigger("submit");
    await flush(30);

    expect(edits).toHaveLength(1);
    const commandId = String(edits[0]!.command_id);
    expect(mounted.wrapper.get('[data-testid="scheduled-task-pending"]').text()).toContain(commandId);
    expect(mounted.wrapper.text()).toContain("修改结果未确认");
    expect(mounted.wrapper.get('[data-testid="scheduled-task-title"]').attributes("disabled")).toBeDefined();

    await mounted.wrapper.get('[data-testid="scheduled-task-check-receipt"]').trigger("click");
    await flush(30);
    expect(receiptChecks).toBe(1);
    // 回执未到：给出按原 ID 重试出口，但仍在编辑页且表单锁定，不生成第二条命令。
    expect(mounted.wrapper.get('[data-testid="scheduled-task-retry-original"]').text()).toContain("按原 ID 和原内容重试");
    expect(mounted.router.currentRoute.value.path).toBe(`/scheduled-tasks/${taskId}/edit`);

    receiptFound = true;
    await mounted.wrapper.get('[data-testid="scheduled-task-check-receipt"]').trigger("click");
    await flush(30);
    expect(receiptChecks).toBe(2);
    expect(mounted.router.currentRoute.value.path).toBe(`/scheduled-tasks/${taskId}`);
    expect(edits).toHaveLength(1);
  });

  it("版本冲突是明确拒绝：不冻结表单，可修内容后重新提交新命令", async () => {
    connect();
    const edits: Record<string, unknown>[] = [];
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const commonResponse = common(url);
      if (commonResponse) return commonResponse;
      if (url === `${root}/scheduled-tasks/${taskId}`) return response(200, expiredWeeklyDetail());
      if (url === `${root}/scheduled-tasks/${taskId}/edits` && init?.method === "POST") {
        const body = JSON.parse(String(init.body)) as Record<string, unknown>;
        edits.push(body);
        if (edits.length === 1) return response(409, { code: "REVISION_CONFLICT", detail: "版本已变化" });
        return response(200, envelope(String(body.command_id), {
          scheduled_task_id: taskId, project_id: projectId, status: "EXPIRED", revision: "9",
          schedule_generation: "2", next_due_at: null }));
      }
      throw new Error(`unexpected ${url}`);
    }));
    const mounted = await mountWorkbench(`/scheduled-tasks/${taskId}/edit`); unmount = mounted.unmount;
    await flush(30);
    await mounted.wrapper.get('[data-testid="scheduled-task-title"]').setValue("第一次提交");
    await mounted.wrapper.get('[data-testid="scheduled-task-edit-reason"]').setValue("第一次");
    await mounted.wrapper.get("form.create-form").trigger("submit");
    await flush(30);

    expect(mounted.wrapper.text()).toContain("修改失败");
    expect(mounted.wrapper.find('[data-testid="scheduled-task-pending"]').exists()).toBe(false);
    expect(mounted.wrapper.get('[data-testid="scheduled-task-title"]').attributes("disabled")).toBeUndefined();

    await mounted.wrapper.get("form.create-form").trigger("submit");
    await flush(30);
    expect(edits).toHaveLength(2);
    expect(edits[1]!.command_id).not.toBe(edits[0]!.command_id);
  });
});

describe("到期详情与补跑拒绝的呈现（P0-A/B）", () => {
  it("EXPIRED 详情给出先编辑再显式启用的路径；继续被 409 拒绝时如实显示原因", async () => {
    connect();
    const detail = { ...expiredWeeklyDetail(), occurrences: [blockedOccurrence("MISSED")], pending_occurrences: [blockedOccurrence("MISSED")] };
    const statusChanges: Record<string, unknown>[] = [];
    const resolutions: Record<string, unknown>[] = [];
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const commonResponse = common(url);
      if (commonResponse) return commonResponse;
      if (url === `${root}/scheduled-tasks/${taskId}`) return response(200, detail);
      if (url === `${root}/scheduled-tasks/${taskId}/status-changes` && init?.method === "POST") {
        statusChanges.push(JSON.parse(String(init.body)) as Record<string, unknown>);
        return response(409, { code: "INVALID_TRANSITION", detail: "已到期的定时任务需要先通过编辑延长授权有效期（或恢复执行次数预算），不能直接重新启用。" });
      }
      if (url.startsWith(`${root}/scheduled-task-occurrences/`) && url.endsWith("/resolutions") && init?.method === "POST") {
        resolutions.push(JSON.parse(String(init.body)) as Record<string, unknown>);
        return response(409, { code: "INVALID_TRANSITION", detail: "这次触发当前不能补跑：定时任务执行次数已用尽。" });
      }
      throw new Error(`unexpected ${url}`);
    }));
    const mounted = await mountWorkbench(`/scheduled-tasks/${taskId}`); unmount = mounted.unmount;
    await flush(30);

    expect(mounted.wrapper.text()).toContain("先「编辑」延长授权或提高次数上限");
    expect(mounted.wrapper.get('[data-testid="scheduled-task-edit-entry"]').attributes("href")).toBe(`/scheduled-tasks/${taskId}/edit`);
    expect(mounted.wrapper.get('[data-testid="scheduled-task-resume"]').text()).toBe("继续");

    await mounted.wrapper.get('[data-testid="scheduled-task-resume"]').trigger("click");
    await flush(30);
    expect(statusChanges).toHaveLength(1);
    expect(mounted.wrapper.text()).toContain("已到期的定时任务需要先通过编辑延长授权有效期");

    await mounted.wrapper.get('[data-testid^="scheduled-task-retry-"]').trigger("click");
    await flush(30);
    expect(resolutions).toHaveLength(1);
    expect(mounted.wrapper.text()).toContain("不能补跑");
    // 明确拒绝不进入待核对冻结：操作按钮回到可用。
    expect(mounted.wrapper.get('[data-testid="scheduled-task-resume"]').attributes("disabled")).toBeUndefined();
  });
});
