import { afterEach, expect, it, vi } from "vitest";
import { createElement } from "react";
import TaskCompletionPanel, { type CompletionTarget } from "../src/components/TaskCompletionPanel";
import { flush, mountReact } from "./mountApp";
import { activateRelayConnection, resetRelayConnectionForTest } from "../src/lib/relayConnection";

/**
 * 禅道 #29（DEV-0131）：完成／重开的结果未知后此前只保留 command ID 字符串，
 * 用户改说明／原因再点会用同一 ID 发出新载荷（服务端将按 COMMAND_ID_REUSED 拒绝）。
 *
 * 修复口径：未知时冻结完整原请求（ID、任务修订、验收版本、产物版本集合、条件、声明／理由），
 * 再次点击＝原样重发冻结对象；表单里的后续编辑是新草稿，不进旧命令；
 * 只有服务端明确业务拒绝（422 等）才释放，允许按新事实换新命令。
 */

const baseUrl = "http://127.0.0.1:8787";
const workspaceId = "11111111-1111-4111-8111-111111111111";
const taskId = "33333333-3333-4333-8333-333333333333";
const root = `${baseUrl}/api/v1/workspaces/${workspaceId}`;

let cleanup: (() => void) | undefined;
afterEach(() => { cleanup?.(); cleanup = undefined; resetRelayConnectionForTest(); vi.unstubAllGlobals(); });

function connect() {
  activateRelayConnection({ baseUrl, workspaceId, bearerToken: "test-bearer-token-0123456789abcdef" });
}

function target(overrides: Partial<CompletionTarget> = {}): CompletionTarget {
  return { taskId, taskStatus: "IN_PROGRESS", taskRevision: "2", acceptanceRevision: "1",
    allowedActions: ["COMPLETE"], criteria: [], acceptedVersion: null, writeBlockedReason: null, ...overrides };
}

function completionResult() {
  return { task_id: taskId, status: "DONE", revision: "3", acceptance_revision: "1",
    completion_id: "77777777-7777-4777-8777-777777777777", human_acceptance_id: "88888888-8888-4888-8888-888888888888",
    artifact_version_ids: [], state_revision: null };
}

function response(body: unknown): Response { return { ok: true, status: 200, json: async () => body } as Response; }

async function mount(value = target()) {
  connect(); const onRefresh = vi.fn();
  const mounted = await mountReact(createElement(TaskCompletionPanel, { live: true, target: value, onRefresh }));
  cleanup = mounted.unmount;
  return { ...mounted, onRefresh };
}

it("完成结果未知后原样重试同 ID 同载荷，回执核对后收口", async () => {
  const posted: Record<string, unknown>[] = [];
  let receiptReady = false;
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (init?.method === "POST") {
      posted.push(JSON.parse(String(init.body)));
      throw new TypeError("lost completion response");
    }
    if (url.startsWith(`${root}/commands/`)) {
      const commandId = url.slice(`${root}/commands/`.length);
      if (!receiptReady) return { ok: false, status: 404, json: async () => ({ code: "COMMAND_NOT_FOUND", detail: "尚未提交", retryable: true }) } as Response;
      return response({ command_id: commandId, command_type: "CompleteHumanTask",
        committed_at: "2026-10-24T00:00:00.000Z", result: completionResult() });
    }
    throw new Error(`unexpected ${url}`);
  }));
  const view = await mount();
  await view.wrapper.get('[data-testid="task-complete"]').trigger("click"); await flush(25);
  await view.wrapper.get('input[name="completion-statement"]').setValue("changed statement after unknown response");
  await view.wrapper.get('[data-testid="task-complete"]').trigger("click"); await flush(25);

  // 两次 POST 同 ID 同载荷：编辑过的新说明留在草稿里，不进旧命令。
  expect(posted).toHaveLength(2);
  expect(posted[1]).toEqual(posted[0]);
  expect(posted[1]!.acceptance).toMatchObject({ statement: "按当前验收标准完成，并接受所选产物版本。" });
  const pendingNote = view.wrapper.get('[data-testid="task-complete-pending"]');
  expect(pendingNote.text()).toContain(String(posted[0]!.command_id));
  expect((view.wrapper.get('input[name="completion-statement"]').element as HTMLInputElement).value)
    .toBe("changed statement after unknown response");

  // 回执尚未出现：保持未知与原 ID。
  const query = view.wrapper.findAll("button").find((button) => button.text() === "查询本次完成回执");
  expect(query).toBeDefined();
  await query!.trigger("click"); await flush(25);
  expect(view.wrapper.get('[data-testid="task-complete-pending"]').exists()).toBe(true);

  // 回执确认且目标匹配：原命令收口，不产生第三次 POST。
  receiptReady = true;
  await query!.trigger("click"); await flush(25);
  expect(view.wrapper.find('[data-testid="task-complete-pending"]').exists()).toBe(false);
  expect(view.wrapper.get('[data-testid="task-complete-receipt"]').text()).toContain("回执确认已完成");
  expect(posted).toHaveLength(2);
});

it("重开结果未知后原样重试同 ID 同原因，回执核对后收口", async () => {
  const posted: Record<string, unknown>[] = [];
  let receiptReady = false;
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (init?.method === "POST") {
      posted.push(JSON.parse(String(init.body)));
      throw new TypeError("lost reopen response");
    }
    if (url.startsWith(`${root}/commands/`)) {
      const commandId = url.slice(`${root}/commands/`.length);
      if (!receiptReady) return { ok: false, status: 404, json: async () => ({ code: "COMMAND_NOT_FOUND", detail: "尚未提交", retryable: true }) } as Response;
      return response({ command_id: commandId, command_type: "ReopenTask",
        committed_at: "2026-10-24T00:00:00.000Z",
        result: { task_id: taskId, status: "READY", revision: "4", acceptance_revision: "2",
          previous_acceptance_revision: "1", previous_completion_id: null } });
    }
    throw new Error(`unexpected ${url}`);
  }));
  const view = await mount(target({ taskStatus: "DONE", allowedActions: ["REOPEN"] }));
  await view.wrapper.get('input[name="reopen-reason"]').setValue("first reason");
  await view.wrapper.get('[data-testid="task-reopen-submit"]').trigger("click"); await flush(25);
  await view.wrapper.get('input[name="reopen-reason"]').setValue("changed reason");
  await view.wrapper.get('[data-testid="task-reopen-submit"]').trigger("click"); await flush(25);

  expect(posted).toHaveLength(2);
  expect(posted[1]).toEqual(posted[0]);
  expect(posted[1]!.reason).toBe("first reason");
  expect(view.wrapper.get('[data-testid="task-reopen-pending"]').text()).toContain(String(posted[0]!.command_id));

  receiptReady = true;
  await view.wrapper.get('[data-testid="task-reopen-receipt-query"]').trigger("click"); await flush(25);
  expect(view.wrapper.find('[data-testid="task-reopen-pending"]').exists()).toBe(false);
  expect(view.wrapper.get('[data-testid="task-reopen-receipt"]').text()).toContain("回执确认已重开");
  expect(posted).toHaveLength(2);
});

it("422 明确拒绝释放冻结：可按新说明换新 ID 重发", async () => {
  const posted: Record<string, unknown>[] = [];
  let reject = true;
  vi.stubGlobal("fetch", vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
    posted.push(JSON.parse(String(init?.body)));
    if (reject) return { ok: false, status: 422, json: async () => ({ code: "VALIDATION_FAILED",
      detail: "说明不符合要求", field_errors: [], retryable: false }) } as Response;
    return response({ command_id: String(posted.at(-1)!.command_id), committed_at: "2026-10-24T00:00:00.000Z",
      result: completionResult() });
  }));
  const view = await mount();
  await view.wrapper.get('[data-testid="task-complete"]').trigger("click"); await flush(25);
  expect(posted).toHaveLength(1);
  expect(view.wrapper.find('[data-testid="task-complete-pending"]').exists()).toBe(false);
  expect(view.wrapper.text()).toContain("请求未通过服务端校验");

  // 明确拒绝后冻结已释放：编辑生效，下一次提交用新 ID 与新说明。
  reject = false;
  await view.wrapper.get('input[name="completion-statement"]').setValue("corrected statement");
  await view.wrapper.get('[data-testid="task-complete"]').trigger("click"); await flush(25);
  expect(posted).toHaveLength(2);
  expect(posted[1]!.command_id).not.toBe(posted[0]!.command_id);
  expect(posted[1]!.acceptance).toMatchObject({ statement: "corrected statement" });
});
