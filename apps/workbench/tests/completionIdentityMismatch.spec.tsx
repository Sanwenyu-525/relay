import { afterEach, expect, it, vi } from "vitest";
import { createElement } from "react";
import TaskCompletionPanel, { type CompletionTarget } from "../src/components/TaskCompletionPanel";
import { flush, mountReact } from "./mountApp";
import { activateRelayConnection, resetRelayConnectionForTest } from "../src/lib/relayConnection";

/**
 * 禅道 #28（DEV-0132）：完成回包与回执必须核对确切命令与确切 Task，并按原冻结请求
 * 核对验收版本、完成状态与产物集合。解析成功不代表关联正确：任何错配都保持待核对，
 * 不清原 command ID、不显示成功、不当作业务完成刷新；正确回包/回执可正常收口。
 */

const baseUrl = "http://127.0.0.1:8787";
const workspaceId = "11111111-1111-4111-8111-111111111111";
const taskId = "33333333-3333-4333-8333-333333333333";
const otherTaskId = "44444444-4444-4444-8444-444444444444";
const versionId = "55555555-5555-4555-8555-555555555555";
const otherVersionId = "66666666-6666-4666-8666-666666666666";
const root = `${baseUrl}/api/v1/workspaces/${workspaceId}`;

let cleanup: (() => void) | undefined;
afterEach(() => { cleanup?.(); cleanup = undefined; resetRelayConnectionForTest(); vi.unstubAllGlobals(); sessionStorage.clear(); localStorage.clear(); });

function connect() {
  activateRelayConnection({ baseUrl, workspaceId, bearerToken: "test-bearer-token-0123456789abcdef" });
}

function target(overrides: Partial<CompletionTarget> = {}): CompletionTarget {
  return { taskId, taskStatus: "IN_PROGRESS", taskRevision: "2", acceptanceRevision: "1",
    allowedActions: ["COMPLETE"], criteria: [], acceptedVersion: null, writeBlockedReason: null, ...overrides };
}

interface CompletionResultOverrides {
  readonly taskId?: string;
  readonly acceptanceRevision?: string;
  readonly status?: string;
  readonly artifactVersionIds?: readonly string[];
}

function completionResult(overrides: CompletionResultOverrides = {}) {
  return { task_id: overrides.taskId ?? taskId, status: overrides.status ?? "DONE", revision: "3",
    acceptance_revision: overrides.acceptanceRevision ?? "1",
    completion_id: "77777777-7777-4777-8777-777777777777",
    human_acceptance_id: "88888888-8888-4888-8888-888888888888",
    artifact_version_ids: overrides.artifactVersionIds ?? [], state_revision: null };
}

function response(body: unknown): Response { return { ok: true, status: 200, json: async () => body } as Response; }

async function mount(value = target()) {
  connect(); const onRefresh = vi.fn();
  const mounted = await mountReact(createElement(TaskCompletionPanel, { live: true, target: value, onRefresh }));
  cleanup = mounted.unmount;
  return { ...mounted, onRefresh };
}

async function queryReceipt(view: Awaited<ReturnType<typeof mount>>) {
  const button = view.wrapper.findAll("button").find((button) => button.text() === "查询本次完成回执");
  expect(button, "结果未知后应提供原 ID 回执查询入口").toBeDefined();
  await button!.trigger("click"); await flush(25);
}

it("直接回包任务错配：不显示成功不刷新，原 ID 保持待核对，回执可正常收口", async () => {
  const posted: Record<string, unknown>[] = [];
  let receiptTaskMatches = false;
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (init?.method === "POST" && url === `${root}/tasks/${taskId}/complete`) {
      const commandId = String(JSON.parse(String(init.body)).command_id);
      posted.push(JSON.parse(String(init.body)));
      // 回包 command_id 正确、但 result.task_id 属于另一任务：不能当作本次完成。
      return response({ command_id: commandId, committed_at: "2026-10-24T00:00:00.000Z",
        result: completionResult({ taskId: otherTaskId }) });
    }
    if (url.startsWith(`${root}/commands/`)) {
      const commandId = url.slice(`${root}/commands/`.length);
      return response({ command_id: commandId, command_type: "CompleteHumanTask",
        committed_at: "2026-10-24T00:00:05.000Z",
        result: completionResult(receiptTaskMatches ? {} : { taskId: otherTaskId }) });
    }
    throw new Error(`unexpected ${url}`);
  }));
  const view = await mount();
  await view.wrapper.get('[data-testid="task-complete"]').trigger("click"); await flush(25);

  expect(view.wrapper.find('[data-testid="task-complete-receipt"]').exists()).toBe(false);
  expect(view.wrapper.get('[role="alert"]').text()).toContain("不是本次任务");
  expect(view.onRefresh).not.toHaveBeenCalled();
  expect(view.wrapper.get('[data-testid="task-complete-pending"]').text()).toContain(String(posted[0]!.command_id));

  // 原命令实际已提交：按原 ID 查回执，任务匹配后才收口。
  receiptTaskMatches = true;
  await queryReceipt(view);
  expect(view.wrapper.get('[data-testid="task-complete-receipt"]').text()).toContain("回执确认已完成");
  expect(view.wrapper.find('[data-testid="task-complete-pending"]').exists()).toBe(false);
  expect(view.onRefresh).toHaveBeenCalledTimes(1);
});

it("直接回包命令错配：client 丢弃错配结果并保持冻结，重试仍用原 ID 原载荷", async () => {
  const posted: Record<string, unknown>[] = [];
  let directMatches = false;
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (init?.method === "POST" && url === `${root}/tasks/${taskId}/complete`) {
      const body = JSON.parse(String(init.body));
      posted.push(body);
      return response({ command_id: directMatches ? body.command_id : "99999999-9999-4999-8999-999999999999",
        committed_at: "2026-10-24T00:00:00.000Z", result: completionResult() });
    }
    throw new Error(`unexpected ${url}`);
  }));
  const view = await mount();
  await view.wrapper.get('[data-testid="task-complete"]').trigger("click"); await flush(25);

  expect(view.wrapper.find('[data-testid="task-complete-receipt"]').exists()).toBe(false);
  expect(view.wrapper.get('[role="alert"]').text()).toContain("command_id");
  expect(view.wrapper.get('[data-testid="task-complete-pending"]').text()).toContain(String(posted[0]!.command_id));
  expect(view.onRefresh).not.toHaveBeenCalled();

  // 冻结未被打散：再次点击仍按原 command_id 与原载荷原样重发。
  directMatches = true;
  await view.wrapper.get('[data-testid="task-complete"]').trigger("click"); await flush(25);
  expect(posted).toHaveLength(2);
  expect(posted[1]!.command_id).toBe(posted[0]!.command_id);
  expect(posted[1]).toEqual(posted[0]);
  expect(view.wrapper.get('[data-testid="task-complete-receipt"]').text()).toContain("已完成本轮");
});

it("回执任务错配：保持待核对且冻结载荷不被改写，正确回执才收口", async () => {
  const posted: Record<string, unknown>[] = [];
  let receiptTaskMatches = false;
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (init?.method === "POST") {
      posted.push(JSON.parse(String(init.body)));
      throw new TypeError("lost completion response");
    }
    if (url.startsWith(`${root}/commands/`)) {
      const commandId = url.slice(`${root}/commands/`.length);
      return response({ command_id: commandId, command_type: "CompleteHumanTask",
        committed_at: "2026-10-24T00:00:05.000Z",
        result: completionResult(receiptTaskMatches ? {} : { taskId: otherTaskId }) });
    }
    throw new Error(`unexpected ${url}`);
  }));
  const view = await mount();
  await view.wrapper.get('[data-testid="task-complete"]').trigger("click"); await flush(25);
  await queryReceipt(view);
  expect(view.wrapper.get('[role="alert"]').text()).toContain("不是本次任务");
  expect(view.wrapper.get('[data-testid="task-complete-pending"]').exists()).toBe(true);
  expect(view.onRefresh).not.toHaveBeenCalled();

  receiptTaskMatches = true;
  await queryReceipt(view);
  expect(view.wrapper.get('[data-testid="task-complete-receipt"]').text()).toContain("回执确认已完成");
  expect(posted).toHaveLength(1);
  expect(view.onRefresh).toHaveBeenCalledTimes(1);
});

it.each([
  { key: "验收版本", overrides: { acceptanceRevision: "2" }, fragment: "验收版本" },
  { key: "完成状态", overrides: { status: "IN_PROGRESS" }, fragment: "不是完成" },
  { key: "产物集合", overrides: { artifactVersionIds: [otherVersionId] }, fragment: "产物版本集合" }
])("回执 $key 错配被拒绝并保持待核对", async ({ overrides, fragment }) => {
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (init?.method === "POST") throw new TypeError("lost completion response");
    if (url.startsWith(`${root}/commands/`)) {
      const commandId = url.slice(`${root}/commands/`.length);
      return response({ command_id: commandId, command_type: "CompleteHumanTask",
        committed_at: "2026-10-24T00:00:05.000Z", result: completionResult(overrides) });
    }
    throw new Error(`unexpected ${url}`);
  }));
  const view = await mount(target({ acceptanceRevision: "1",
    acceptedVersion: { artifactVersionId: versionId, versionNumber: "1" } }));
  await view.wrapper.get('[data-testid="task-complete"]').trigger("click"); await flush(25);
  await queryReceipt(view);

  expect(view.wrapper.find('[data-testid="task-complete-receipt"]').exists()).toBe(false);
  expect(view.wrapper.get('[role="alert"]').text()).toContain(fragment);
  expect(view.wrapper.get('[data-testid="task-complete-pending"]').exists()).toBe(true);
  expect(view.onRefresh).not.toHaveBeenCalled();
});

it("正确直接回包与正确回执均正常收口（健康对照）", async () => {
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (init?.method === "POST" && url === `${root}/tasks/${taskId}/complete`) {
      const commandId = String(JSON.parse(String(init.body)).command_id);
      return response({ command_id: commandId, committed_at: "2026-10-24T00:00:00.000Z", result: completionResult() });
    }
    if (url.startsWith(`${root}/commands/`)) {
      const commandId = url.slice(`${root}/commands/`.length);
      return response({ command_id: commandId, command_type: "CompleteHumanTask",
        committed_at: "2026-10-24T00:00:05.000Z", result: completionResult() });
    }
    throw new Error(`unexpected ${url}`);
  }));
  const direct = await mount();
  await direct.wrapper.get('[data-testid="task-complete"]').trigger("click"); await flush(25);
  expect(direct.wrapper.get('[data-testid="task-complete-receipt"]').text()).toContain("已完成本轮");
  expect(direct.onRefresh).toHaveBeenCalledTimes(1);
});
