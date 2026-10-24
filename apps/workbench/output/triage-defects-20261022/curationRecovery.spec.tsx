import { createElement } from "react";
import { afterEach, expect, it, vi } from "vitest";
import { RelayApiClient } from "../../src/api/relayClient";
import KnowledgeCurationPanel from "../../src/components/KnowledgeCurationPanel";
import { flush, mountReact } from "../../tests/mountApp";
let unmount: (() => void) | null = null;
afterEach(() => { unmount?.(); unmount = null; vi.unstubAllGlobals(); });
function response(status: number, body: unknown): Response { return { ok: status >= 200 && status < 300, status, json: async () => body } as Response; }
for (const action of ["propose", "accept", "reject"]) {
  it(`整理候选${action}响应丢失后不得丢原ID并允许新命令`, async () => {
    const ids: string[] = []; let receipts = 0;
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (init?.method === "POST") { ids.push(JSON.parse(String(init.body)).command_id); throw new TypeError("response lost"); }
      if (url.includes("/commands/")) { receipts++; return response(404, { code: "COMMAND_NOT_FOUND" }); }
      if (url.endsWith("/artifacts/artifact")) return response(200, { id: "artifact", task_id: "task", title: "来源", revision: "1", latest_version_id: "version", version_count: 0, versions: [] });
      if (url.endsWith("/tasks/task")) return response(200, { id: "task", project_id: "project", title: "Task", status: "IN_PROGRESS", mode: "ME", revision: "1", executor: { kind: "HUMAN", run_id: null, ownership_epoch: "0" }, current_completion_id: null, waiting_reason: null, blocking_task_ids: [], unresolved_blocker_ids: [], allowed_actions: [], acceptance: { acceptance_revision: "1", objective: "目标", source: "CREATE", criteria: [] }, dependencies: [] });
      if (url.endsWith("/knowledge-curation-candidates")) return response(200, { items: [{ id: "candidate", project_id: "project", source_artifact_version_id: "version", source_artifact_id: "artifact", source_version_number: "1", source_title: "来源", suggested_title: "知识候选", suggested_knowledge_id: null, suggested_knowledge_title: null, similar: [], status: "PROPOSED", accepted_knowledge_id: null, accepted_knowledge_version_id: null, stale_reason: null, rejected_at: null }] });
      throw new Error(`unexpected ${url}`);
    }));
    const client = new RelayApiClient({ baseUrl: "http://127.0.0.1:8787", workspaceId: "workspace", bearerToken: "test-token" });
    const mounted = await mountReact(createElement(KnowledgeCurationPanel, { client, artifactId: "artifact", artifactVersionId: "version", versionNumber: "1" })); unmount = mounted.unmount; await flush();
    const label = action === "propose" ? "把 v1 提为整理候选" : action === "accept" ? "接受为知识" : "拒绝";
    const button = () => mounted.wrapper.findAll("button").find(item => item.text() === label)!;
    await button().trigger("click"); await flush();
    expect(ids).toHaveLength(1);
    await button().trigger("click"); await flush();
    console.log("TRIAGE_CURATION_RECOVERY", JSON.stringify({ action, ids, receipts }));
    expect(new Set(ids).size).toBe(1);
  });
}
