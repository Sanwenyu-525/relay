import { createElement } from "react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, expect, it, vi } from "vitest";
import ArtifactPanel from "../../src/components/ArtifactPanel";
import { activateRelayConnection, resetRelayConnectionForTest } from "../../src/lib/relayConnection";
import { flush, mountReact } from "../../tests/mountApp";
const wid = "11111111-1111-4111-8111-111111111111";
const pid = "22222222-2222-4222-8222-222222222222";
const tid = "33333333-3333-4333-8333-333333333333";
const aid = "44444444-4444-4444-8444-444444444444";
const v1 = "55555555-5555-4555-8555-555555555555";
const v2 = "66666666-6666-4666-8666-666666666666";
let unmount: (() => void) | null = null;
afterEach(() => { unmount?.(); unmount = null; resetRelayConnectionForTest(); vi.unstubAllGlobals(); });
const response = (body: unknown): Response => ({ ok: true, status: 200, json: async () => body, text: async () => "# immutable saved body" }) as Response;
it("产物当前选用响应未知后切换版本，不能用旧命令ID发送另一版本", async () => {
  const writes: Record<string, unknown>[] = [];
  activateRelayConnection({ baseUrl: "http://127.0.0.1:8787", workspaceId: wid, bearerToken: "test-token" });
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const pathname = new URL(String(input)).pathname;
    if (init?.method === "POST") { writes.push(JSON.parse(String(init.body))); throw new TypeError("lost selection response"); }
    if (pathname.endsWith(`/tasks/${tid}/artifacts`)) return response({ items: [{ id: aid, task_id: tid, project_id: pid, artifact_kind: "MARKDOWN_DOCUMENT", title: "version selection target", revision: "1", latest_version_id: v2, version_count: 2, created_at: "2026-10-23T00:00:00Z", updated_at: "2026-10-23T00:00:00Z", versions: [v1, v2].map((id, index) => ({ artifact_version_id: id, version_number: String(index + 1), media_type: "text/markdown", sha256: "a".repeat(64), size: "10", source_kind: "HUMAN", created_at: "2026-10-23T00:00:00Z" })) }], current_accepted_version_ids: [] });
    if (pathname.endsWith(`/projects/${pid}/state`)) return response({ project_id: pid, revision: "7", phase_key: "EXECUTION", next_action_task_id: tid, selected_artifact_version_refs: [], completed_highlight_refs: [] });
    return response({});
  }));
  const mounted = await mountReact(createElement(MemoryRouter, null, createElement(ArtifactPanel, { taskId: tid, projectId: pid, taskStatus: "IN_PROGRESS", taskRevision: "2", acceptanceRevision: "1", criteria: [], allowedActions: [], writeBlockedReason: null, onRefresh: vi.fn() }))); unmount = mounted.unmount; await flush();
  await mounted.wrapper.get('[data-testid="artifact-accept-version"]').setValue(v1);
  await mounted.wrapper.get('[data-testid="artifact-select-version"]').trigger("click"); await flush();
  expect(writes).toHaveLength(1);
  const canChooseAnother = mounted.wrapper.get('[data-testid="artifact-accept-version"]').attributes("disabled") === undefined;
  await mounted.wrapper.get('[data-testid="artifact-accept-version"]').setValue(v2);
  const canResubmit = mounted.wrapper.get('[data-testid="artifact-select-version"]').attributes("disabled") === undefined;
  if (canResubmit) { await mounted.wrapper.get('[data-testid="artifact-select-version"]').trigger("click"); await flush(); }
  console.log("TRIAGE_ARTIFACT_SELECTION_PENDING_PAYLOAD", JSON.stringify({ canChooseAnother, canResubmit, writes }));
  expect(writes.length === 1 || JSON.stringify(writes[1]) === JSON.stringify(writes[0]), "unknown selection must retain its entire original payload, not just command_id").toBe(true);
});
