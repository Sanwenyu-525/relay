import { createElement } from "react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, expect, it, vi } from "vitest";
import { RelayApiClient } from "../../src/api/relayClient";
import ProjectKnowledgeGuide from "../../src/components/ProjectKnowledgeGuide";
import { flush, mountReact } from "../../tests/mountApp";
const wid = "11111111-1111-4111-8111-111111111111";
const pid = "22222222-2222-4222-8222-222222222222";
const kid = "88888888-8888-4888-8888-888888888888";
const taskId = (i: number) => `33333333-3333-4333-8333-${String(i).padStart(12, "0")}`;
let unmount: (() => void) | null = null;
afterEach(() => { unmount?.(); unmount = null; vi.unstubAllGlobals(); });
function response(body: unknown): Response { return { ok: true, status: 200, json: async () => body } as Response; }
it("导读不能忽略任务续页却声称项目成果版本都已收录", async () => {
  const taskCursors: (string | null)[] = [], artifactTasks: string[] = [];
  const task = (i: number) => ({ id: taskId(i), title: `任务${i}`, project_id: pid, status: "INBOX", mode: "ME", revision: "0", executor: { kind: "HUMAN", run_id: null }, current_completion_id: null, waiting_reason: null, blocking_task_ids: [], unresolved_blocker_ids: [], allowed_actions: [] });
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
    const url = new URL(String(input)); const path = url.pathname;
    if (path.endsWith("/tasks")) { const cursor = url.searchParams.get("cursor"); taskCursors.push(cursor); return response({ items: cursor === null ? Array.from({ length: 50 }, (_, i) => task(i + 1)) : [task(51)], next_cursor: cursor === null ? "next-tasks+51" : null }); }
    const artifacts = /\/tasks\/([^/]+)\/artifacts$/.exec(path);
    if (artifacts) {
      artifactTasks.push(artifacts[1]!);
      return response({ items: artifacts[1] === taskId(51) ? [{ id: "artifact-51", task_id: taskId(51), title: "TASK_51_ARTIFACT", revision: "1", latest_version_id: "av-51", version_count: 1,
        versions: [{ artifact_version_id: "av-51", version_number: "1", media_type: "text/markdown", sha256: "a".repeat(64), size: "10", source_kind: "HUMAN", created_at: "2026-10-22T00:00:00Z" }] }] : [], current_accepted_version_ids: [] });
    }
    if (path.endsWith("/knowledge-guide")) return response({ project_id: pid, exists: true, revision: "1", entry_count: 1, gaps: [], entries: [{ ordinal: 0, ref_kind: "KNOWLEDGE", reference_mode: "CURRENT", target_id: kid, label: null, title: "已收录资料", resolved_version_id: "known-v1", resolved_version_number: "1", target_status: "ACTIVE", is_current: true, resolution: "AVAILABLE", note: "" }] });
    if (path.endsWith("/knowledge")) return response([{ id: kid, project_id: pid, title: "已收录资料", status: "ACTIVE", revision: "1", current_version: "1", created_at: "2026-10-22T00:00:00Z", updated_at: "2026-10-22T00:00:00Z" }]);
    return response([]);
  }));
  const client = new RelayApiClient({ baseUrl: "http://127.0.0.1:8787", workspaceId: wid, bearerToken: "test-token" });
  const mounted = await mountReact(createElement(MemoryRouter, null, createElement(ProjectKnowledgeGuide, { client, projectId: pid, onOpen: vi.fn() })));
  unmount = mounted.unmount; await flush(); await flush();
  expect(artifactTasks.length).toBeGreaterThanOrEqual(50);
  const claimsComplete = mounted.wrapper.text().includes("本项目可收录的决定、规则、资料与成果版本都已在导读中。");
  const task51Selectable = mounted.wrapper.findAll('select option').some(option => option.text().includes("TASK_51_ARTIFACT"));
  console.log("TRIAGE_GUIDE_TASK_PAGINATION", JSON.stringify({ taskCursors, artifactReadCount: artifactTasks.length, task51Read: artifactTasks.includes(taskId(51)), task51Selectable, claimsComplete }));
  expect(taskCursors).toContain("next-tasks+51");
  expect(task51Selectable).toBe(true);
  expect(claimsComplete).toBe(false);
});
