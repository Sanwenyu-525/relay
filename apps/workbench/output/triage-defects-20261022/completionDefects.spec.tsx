import { createElement } from "react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, expect, it, vi } from "vitest";
import TaskCompletionPanel, { type CompletionTarget } from "../../src/components/TaskCompletionPanel";
import ArtifactPanel from "../../src/components/ArtifactPanel";
import { flush, mountReact } from "../../tests/mountApp";
import { activateRelayConnection, resetRelayConnectionForTest } from "../../src/lib/relayConnection";

const wid = "11111111-1111-4111-8111-111111111111";
const tid = "33333333-3333-4333-8333-333333333333";
const otherTid = "44444444-4444-4444-8444-444444444444";
const vid = "55555555-5555-4555-8555-555555555555";
const otherVid = "66666666-6666-4666-8666-666666666666";
const root = `http://127.0.0.1:8787/api/v1/workspaces/${wid}`;
let cleanup: (() => void) | undefined;
afterEach(() => { cleanup?.(); cleanup = undefined; resetRelayConnectionForTest(); vi.unstubAllGlobals(); });
function connect() {
  activateRelayConnection({ baseUrl: "http://127.0.0.1:8787", workspaceId: wid, bearerToken: "probe-not-a-real-credential-token" });
}
function target(overrides: Partial<CompletionTarget> = {}): CompletionTarget {
  return { taskId: tid, taskStatus: "IN_PROGRESS", taskRevision: "2", acceptanceRevision: "1",
    allowedActions: ["COMPLETE"], criteria: [], acceptedVersion: null, writeBlockedReason: null, ...overrides };
}
function result(taskId = tid) {
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

it("unknown completion must freeze payload as well as command ID", async () => {
  const posted: Record<string, unknown>[] = [];
  vi.stubGlobal("fetch", vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
    posted.push(JSON.parse(String(init?.body))); throw new TypeError("lost completion response");
  }));
  const view = await mount();
  await view.wrapper.get('[data-testid="task-complete"]').trigger("click"); await flush(25);
  await view.wrapper.get('input[name="completion-statement"]').setValue("changed statement after unknown response");
  await view.wrapper.get('[data-testid="task-complete"]').trigger("click"); await flush(25);
  console.log("TRIAGE_COMPLETION_PAYLOAD", JSON.stringify(posted));
  expect(posted).toHaveLength(2);
  expect(posted[1], "retained ID must never be resubmitted with edited payload").toEqual(posted[0]);
});

it("unknown reopen must freeze reason as well as command ID", async () => {
  const posted: Record<string, unknown>[] = [];
  vi.stubGlobal("fetch", vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
    posted.push(JSON.parse(String(init?.body))); throw new TypeError("lost reopen response");
  }));
  const view = await mount(target({ taskStatus: "DONE", allowedActions: ["REOPEN"] }));
  await view.wrapper.get('input[name="reopen-reason"]').setValue("first reason");
  await view.wrapper.get('[data-testid="task-reopen-submit"]').trigger("click"); await flush(25);
  await view.wrapper.get('input[name="reopen-reason"]').setValue("changed reason");
  await view.wrapper.get('[data-testid="task-reopen-submit"]').trigger("click"); await flush(25);
  console.log("TRIAGE_REOPEN_PAYLOAD", JSON.stringify(posted));
  expect(posted).toHaveLength(2);
  expect(posted[1], "retained reopen ID must not acquire a different reason").toEqual(posted[0]);
});

it.each(["direct-wrong-task", "direct-wrong-command", "receipt-wrong-task"] as const)
  ("completion must reject unrelated confirmation: %s", async variant => {
    let commandId = "";
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === `${root}/tasks/${tid}/complete`) {
        commandId = String(JSON.parse(String(init?.body)).command_id);
        if (variant === "receipt-wrong-task") throw new TypeError("lost response");
        return response({ command_id: variant === "direct-wrong-command" ? "99999999-9999-4999-8999-999999999999" : commandId,
          committed_at: "2026-10-22T00:00:00.000Z", result: result(variant === "direct-wrong-task" ? otherTid : tid) });
      }
      if (url === `${root}/commands/${commandId}`) return response({ command_id: commandId,
        command_type: "CompleteHumanTask", scope_key: `http:${wid}`, committed_at: "2026-10-22T00:00:00.000Z", result: result(otherTid) });
      throw new Error(`unexpected ${url}`);
    }));
    const view = await mount();
    await view.wrapper.get('[data-testid="task-complete"]').trigger("click"); await flush(25);
    if (variant === "receipt-wrong-task") {
      const button = view.wrapper.findAll("button").find(button => button.text() === "查询本次完成回执");
      expect(button).toBeDefined(); await button!.trigger("click"); await flush(25);
    }
    const success = view.wrapper.find('[data-testid="task-complete-receipt"]');
    console.log("TRIAGE_COMPLETION_UNRELATED", JSON.stringify({ variant, successShown: success.exists(), message: success.text(), refreshes: view.onRefresh.mock.calls.length }));
    expect(success.exists(), "unrelated result cannot confirm current task completion").toBe(false);
  });

it("changing the accepted artifact version must invalidate prior human criterion ticks", async () => {
  const criterion = { criterionId: "c1", statement: "I checked the selected version", required: true,
    method: "HUMAN", targetSpec: {} };
  const before = target({ criteria: [criterion], acceptedVersion: { artifactVersionId: vid, versionNumber: "1" } });
  const view = await mount(before);
  await view.wrapper.get('[data-testid="criterion-c1"]').setValue(true);
  expect(view.wrapper.get('[data-testid="task-complete"]').attributes("disabled")).toBeUndefined();
  await view.rerender(createElement(TaskCompletionPanel, { live: true,
    target: { ...before, acceptedVersion: { artifactVersionId: otherVid, versionNumber: "2" } }, onRefresh: view.onRefresh }));
  const stillChecked = (view.wrapper.get('[data-testid="criterion-c1"]').element as HTMLInputElement).checked;
  console.log("TRIAGE_COMPLETION_VERSION_CHANGE", JSON.stringify({ oldVersion: vid, nextVersion: otherVid,
    stillChecked, canComplete: view.wrapper.get('[data-testid="task-complete"]').attributes("disabled") === undefined }));
  expect(stillChecked, "acceptance for one immutable version cannot migrate to another").toBe(false);
});

it("real ArtifactPanel version selector must invalidate previous human ticks", async () => {
  connect(); const aid = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    if (init?.method === "POST") throw new Error("version selection must not write");
    if (String(input) === `${root}/tasks/${tid}/artifacts`) return response({ items: [{
      id: aid, task_id: tid, project_id: null, artifact_kind: "MARKDOWN_DOCUMENT", title: "two versions", revision: "1",
      latest_version_id: otherVid, version_count: 2, created_at: "2026-10-22T00:00:00.000Z", updated_at: "2026-10-22T00:00:00.000Z",
      versions: [{ id: vid, number: "1" }, { id: otherVid, number: "2" }].map(v => ({ artifact_version_id: v.id,
        version_number: v.number, media_type: "text/markdown", sha256: "a".repeat(64), size: "10", source_kind: "HUMAN", created_at: "2026-10-22T00:00:00.000Z" }))
    }], current_accepted_version_ids: [] });
    return { ok: true, status: 200, json: async () => ({}), text: async () => "# saved version body" } as Response;
  }));
  const criterion = { criterionId: "c1", statement: "I checked this version", required: true, method: "HUMAN", targetSpec: {} };
  const view = await mountReact(createElement(MemoryRouter, {}, createElement(ArtifactPanel, {
    taskId: tid, projectId: null, taskStatus: "IN_PROGRESS", taskRevision: "2", acceptanceRevision: "1",
    criteria: [criterion], allowedActions: ["COMPLETE"], writeBlockedReason: null, onRefresh: () => undefined
  }))); cleanup = view.unmount;
  await flush(30);
  await view.wrapper.get('[data-testid="artifact-accept-version"]').setValue(vid);
  await view.wrapper.get('[data-testid="criterion-c1"]').setValue(true);
  await view.wrapper.get('[data-testid="artifact-accept-version"]').setValue(otherVid); await flush(25);
  const stillChecked = (view.wrapper.get('[data-testid="criterion-c1"]').element as HTMLInputElement).checked;
  console.log("TRIAGE_ARTIFACT_SELECTOR", JSON.stringify({ selected: (view.wrapper.get('[data-testid="artifact-accept-version"]').element as HTMLSelectElement).value,
    stillChecked, canComplete: view.wrapper.get('[data-testid="task-complete"]').attributes("disabled") === undefined }));
  expect(stillChecked, "actual dropdown must not inherit prior artifact acceptance").toBe(false);
});
