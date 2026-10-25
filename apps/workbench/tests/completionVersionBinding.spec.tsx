import { afterEach, expect, it, vi } from "vitest";
import { createElement } from "react";
import { MemoryRouter } from "react-router-dom";
import TaskCompletionPanel, { type CompletionTarget } from "../src/components/TaskCompletionPanel";
import ArtifactPanel from "../src/components/ArtifactPanel";
import { flush, mountReact, type DomWrapper } from "./mountApp";
import { activateRelayConnection, resetRelayConnectionForTest } from "../src/lib/relayConnection";

/**
 * 禅道 #27（DEV-0133）：人工条件勾选绑定 Task＋验收版本＋确切接受产物版本集合。
 * 从一个确切接受版本换到另一个不同版本、或退回未选，都要求重新确认；单纯阅读切换与
 * 同一确切版本的刷新不误清；首轮未选版本时的勾选不因 null→A 作废（那是 taskDetail
 * UI-11 锁住的“保存首个产物后自动选中”流）。已冻结的原完成载荷是独立快照，
 * 不随清勾选／换版被改写。
 */

const baseUrl = "http://127.0.0.1:8787";
const workspaceId = "11111111-1111-4111-8111-111111111111";
const taskId = "33333333-3333-4333-8333-333333333333";
const versionA = "55555555-5555-4555-8555-555555555555";
const versionB = "66666666-6666-4666-8666-666666666666";
const root = `${baseUrl}/api/v1/workspaces/${workspaceId}`;

let cleanup: (() => void) | undefined;
afterEach(() => { cleanup?.(); cleanup = undefined; resetRelayConnectionForTest(); vi.unstubAllGlobals(); sessionStorage.clear(); localStorage.clear(); });

function connect() {
  activateRelayConnection({ baseUrl, workspaceId, bearerToken: "test-bearer-token-0123456789abcdef" });
}

const criterion = { criterionId: "c1", statement: "I checked the selected version", required: true,
  method: "HUMAN", targetSpec: {} };

function target(overrides: Partial<CompletionTarget> = {}): CompletionTarget {
  return { taskId, taskStatus: "IN_PROGRESS", taskRevision: "2", acceptanceRevision: "1",
    allowedActions: ["COMPLETE"], criteria: [criterion], acceptedVersion: null,
    writeBlockedReason: null, ...overrides };
}

function completionResult(artifactVersionIds: readonly string[] = []) {
  return { task_id: taskId, status: "DONE", revision: "3", acceptance_revision: "1",
    completion_id: "77777777-7777-4777-8777-777777777777", human_acceptance_id: "88888888-8888-4888-8888-888888888888",
    artifact_version_ids: [...artifactVersionIds], state_revision: null };
}

function response(body: unknown): Response { return { ok: true, status: 200, json: async () => body } as Response; }

async function mount(value = target()) {
  connect(); const onRefresh = vi.fn();
  const mounted = await mountReact(createElement(TaskCompletionPanel, { live: true, target: value, onRefresh }));
  cleanup = mounted.unmount;
  return { ...mounted, onRefresh };
}

function tickChecked(wrapper: DomWrapper): boolean {
  return (wrapper.get('[data-testid="criterion-c1"]').element as HTMLInputElement).checked;
}

function canComplete(wrapper: DomWrapper): boolean {
  return wrapper.get('[data-testid="task-complete"]').attributes("disabled") === undefined;
}

it("接受版本 A→B：勾选清空、完成禁用，对新版本重新核对后才可完成", async () => {
  const base = target({ acceptedVersion: { artifactVersionId: versionA, versionNumber: "1" } });
  const view = await mount(base);
  await view.wrapper.get('[data-testid="criterion-c1"]').setValue(true);
  expect(tickChecked(view.wrapper)).toBe(true);
  expect(canComplete(view.wrapper)).toBe(true);

  await view.rerender(createElement(TaskCompletionPanel, { live: true,
    target: { ...base, acceptedVersion: { artifactVersionId: versionB, versionNumber: "2" } },
    onRefresh: view.onRefresh }));

  expect(tickChecked(view.wrapper), "对 v1 的人工判断不能迁移到 v2").toBe(false);
  expect(canComplete(view.wrapper)).toBe(false);
  await view.wrapper.get('[data-testid="criterion-c1"]').setValue(true);
  expect(canComplete(view.wrapper), "重新核对 v2 后才能完成").toBe(true);
});

it("接受版本 A→null 要求重新确认；首轮未选版本时的勾选不因版本被选定而作废", async () => {
  const base = target();
  const view = await mount(base);
  await view.wrapper.get('[data-testid="criterion-c1"]').setValue(true);

  // null→A 不清：这些勾选是在还没有任何接受版本时做的（例如保存首个产物后该版被
  // 自动选中），不是为另一个版本做的判断；taskDetail UI-11 既有回归锁住这一行为。
  await view.rerender(createElement(TaskCompletionPanel, { live: true,
    target: { ...base, acceptedVersion: { artifactVersionId: versionA, versionNumber: "1" } },
    onRefresh: view.onRefresh }));
  expect(tickChecked(view.wrapper), "首轮勾选不因版本被选定而作废").toBe(true);

  // A→null 清：退回未选后旧判断不能继续用于完成。
  await view.rerender(createElement(TaskCompletionPanel, { live: true,
    target: { ...base, acceptedVersion: null }, onRefresh: view.onRefresh }));
  expect(tickChecked(view.wrapper), "退回未选须重新确认").toBe(false);
  expect(canComplete(view.wrapper)).toBe(false);
});

it("同一确切版本的刷新（新对象、仅属性相同）不误清勾选", async () => {
  const base = target({ acceptedVersion: { artifactVersionId: versionA, versionNumber: "1" } });
  const view = await mount(base);
  await view.wrapper.get('[data-testid="criterion-c1"]').setValue(true);

  // 父组件重读后传入属性相同的新对象：这不是新的接受对象，不能清用户的判断。
  await view.rerender(createElement(TaskCompletionPanel, { live: true,
    target: { ...base, acceptedVersion: { artifactVersionId: versionA, versionNumber: "1" } },
    onRefresh: view.onRefresh }));
  await flush(10);
  expect(tickChecked(view.wrapper), "相同确切版本不得被当成新一轮").toBe(true);
  expect(canComplete(view.wrapper)).toBe(true);
});

it("结果未知后接受版本切换清勾选，但冻结的原载荷原样重试不被改写", async () => {
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
        committed_at: "2026-10-24T00:00:05.000Z", result: completionResult([versionA]) });
    }
    throw new Error(`unexpected ${url}`);
  }));
  const base = target({ acceptedVersion: { artifactVersionId: versionA, versionNumber: "1" } });
  const view = await mount(base);
  await view.wrapper.get('[data-testid="criterion-c1"]').setValue(true);
  await view.wrapper.get('[data-testid="task-complete"]').trigger("click"); await flush(25);
  expect(view.wrapper.get('[data-testid="task-complete-pending"]').text()).toContain(String(posted[0]!.command_id));

  // 换接受版本：新勾选被清（#27），但冻结载荷不动；按钮因待核对保持可用。
  await view.rerender(createElement(TaskCompletionPanel, { live: true,
    target: { ...base, acceptedVersion: { artifactVersionId: versionB, versionNumber: "2" } },
    onRefresh: view.onRefresh }));
  expect(tickChecked(view.wrapper)).toBe(false);
  expect(canComplete(view.wrapper), "待核对的原命令允许原样重试").toBe(true);

  await view.wrapper.get('[data-testid="task-complete"]').trigger("click"); await flush(25);
  expect(posted).toHaveLength(2);
  expect(posted[1]!.command_id).toBe(posted[0]!.command_id);
  expect(posted[1]).toEqual(posted[0]);
  expect(posted[1]!.artifact_version_ids).toEqual([versionA]);

  // 原命令回执匹配后正常收口。
  receiptReady = true;
  const query = view.wrapper.findAll("button").find((button) => button.text() === "查询本次完成回执");
  await query!.trigger("click"); await flush(25);
  expect(view.wrapper.get('[data-testid="task-complete-receipt"]').text()).toContain("回执确认已完成");
  expect(posted).toHaveLength(2);
});

it("真实 ArtifactPanel 分开管理当前选用候选、阅读版本和本轮接受", async () => {
  connect();
  const artifactId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    if (init?.method === "POST") throw new Error("version switching must not write");
    if (String(input) === `${root}/tasks/${taskId}/artifacts`) return response({ items: [{
      id: artifactId, task_id: taskId, project_id: null, artifact_kind: "MARKDOWN_DOCUMENT",
      title: "two versions", revision: "1", latest_version_id: versionB, version_count: 2,
      created_at: "2026-10-24T00:00:00.000Z", updated_at: "2026-10-24T00:00:00.000Z",
      versions: [{ id: versionA, number: "1" }, { id: versionB, number: "2" }].map((v) => ({
        artifact_version_id: v.id, version_number: v.number, media_type: "text/markdown",
        sha256: "a".repeat(64), size: "10", source_kind: "HUMAN", created_at: "2026-10-24T00:00:00.000Z" }))
    }], current_accepted_version_ids: [] });
    return { ok: true, status: 200, json: async () => ({}), text: async () => "# saved version body" } as Response;
  }));
  const view = await mountReact(createElement(MemoryRouter, {}, createElement(ArtifactPanel, {
    taskId, projectId: null, taskStatus: "IN_PROGRESS", taskRevision: "2", acceptanceRevision: "1",
    criteria: [criterion], allowedActions: ["COMPLETE"], writeBlockedReason: null, onRefresh: () => undefined
  }))); cleanup = view.unmount;
  await flush(30);

  await view.wrapper.get(`[data-testid="completion-artifact-${versionA}"]`).setValue(true);
  await view.wrapper.get('[data-testid="criterion-c1"]').setValue(true);
  expect(tickChecked(view.wrapper)).toBe(true);

  // 阅读切换（看 v2 正文）不是接受版本变化：勾选保留。
  await view.wrapper.get(`[data-testid="artifact-read-${versionB}"]`).trigger("click");
  await flush(10);
  expect(tickChecked(view.wrapper),
    "单纯阅读切换不能清掉人工判断").toBe(true);

  // 本轮接受集合从 {v1} 变为 {v1, v2}：旧人工判断作废。
  await view.wrapper.get(`[data-testid="completion-artifact-${versionB}"]`).setValue(true);
  await flush(10);
  expect(tickChecked(view.wrapper), "接受集合变化后必须重新确认").toBe(false);
  expect(canComplete(view.wrapper)).toBe(false);
  expect((view.wrapper.get(`[data-testid="completion-artifact-${versionA}"]`).element as HTMLInputElement).checked).toBe(true);
  expect((view.wrapper.get(`[data-testid="completion-artifact-${versionB}"]`).element as HTMLInputElement).checked).toBe(true);

  // 当前选用候选是独立 Project State 输入，不会改写本轮接受集合。
  await view.wrapper.get('[data-testid="criterion-c1"]').setValue(true);
  await view.wrapper.get('[data-testid="artifact-accept-version"]').setValue(versionA);
  await flush(10);
  expect(tickChecked(view.wrapper)).toBe(true);
  expect(view.wrapper.get('[data-testid="completion-artifact-summary"]').text()).toContain(versionA);
  expect(view.wrapper.get('[data-testid="completion-artifact-summary"]').text()).toContain(versionB);
});

it("可以接受多个 Artifact 与同一 Artifact 的多个历史版本，并冻结完整集合", async () => {
  const artifactA = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
  const artifactB = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
  const versionC = "99999999-9999-4999-8999-999999999999";
  const options: NonNullable<CompletionTarget["availableArtifactVersions"]> = [
    { artifactId: artifactA, artifactTitle: "规格", artifactVersionId: versionA, versionNumber: "1", isLatest: false },
    { artifactId: artifactA, artifactTitle: "规格", artifactVersionId: versionB, versionNumber: "2", isLatest: true },
    { artifactId: artifactB, artifactTitle: "实现说明", artifactVersionId: versionC, versionNumber: "1", isLatest: true }
  ];
  const posted: Record<string, unknown>[] = [];
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    if (init?.method === "POST") {
      const body = JSON.parse(String(init.body)) as Record<string, unknown>;
      posted.push(body);
      return response({ command_id: body.command_id, command_type: "CompleteHumanTask",
        committed_at: "2026-10-24T00:00:05.000Z",
        result: completionResult(body.artifact_version_ids as string[]) });
    }
    throw new Error(`unexpected ${String(input)}`);
  }));
  const view = await mount(target({ availableArtifactVersions: options }));
  for (const id of [versionA, versionB, versionC]) {
    await view.wrapper.get(`[data-testid="completion-artifact-${id}"]`).setValue(true);
  }
  await view.wrapper.get('[data-testid="criterion-c1"]').setValue(true);
  expect(canComplete(view.wrapper)).toBe(true);
  await view.wrapper.get('[data-testid="task-complete"]').trigger("click");
  await flush(25);
  expect(posted).toHaveLength(1);
  expect(posted[0]!.artifact_version_ids).toEqual([versionA, versionB, versionC]);
  const receipt = view.wrapper.get('[data-testid="task-complete-receipt"]').text();
  expect(receipt).toContain("规格 v1");
  expect(receipt).toContain("规格 v2");
  expect(receipt).toContain("实现说明 v1");
  expect(receipt).toContain(artifactA);
  expect(receipt).toContain(versionC);
});
