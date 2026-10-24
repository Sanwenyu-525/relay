import { createElement } from "react";
import { afterEach, expect, it, vi } from "vitest";
import { RelayApiClient } from "../../src/api/relayClient";
import ArtifactTextLocksPanel from "../../src/components/ArtifactTextLocksPanel";
import { flush, mountReact } from "../../tests/mountApp";
let unmount: (() => void) | null = null;
afterEach(() => { unmount?.(); unmount = null; vi.unstubAllGlobals(); });
function response(status: number, body: unknown): Response {
  return { ok: status >= 200 && status < 300, status, json: async () => body, text: async () => String(body) } as Response;
}
it("锁定原文结果未知后刷新事实不能清原命令并允许新ID", async () => {
  const ids: string[] = []; let receiptReads = 0;
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (init?.method === "POST") { ids.push(JSON.parse(String(init.body)).command_id); throw new TypeError("response lost"); }
    if (url.includes("/commands/")) { receiptReads++; return response(404, { code: "COMMAND_NOT_FOUND" }); }
    if (url.endsWith("/artifacts/artifact")) return response(200, { id: "artifact", task_id: "task", title: "正文.md", revision: "1", latest_version_id: "v1", version_count: 1,
      versions: [{ artifact_version_id: "v1", version_number: "1", media_type: "text/markdown", sha256: "a".repeat(64), size: "10", source_kind: "HUMAN", created_at: "2026-10-22T00:00:00Z" }] });
    if (url.endsWith("/text-locks")) return response(200, { artifact_id: "artifact", locks: [] });
    if (url.endsWith("/content")) return response(200, "确切原文\n\n另一个段落");
    throw new Error(`unexpected ${url}`);
  }));
  const client = new RelayApiClient({ baseUrl: "http://127.0.0.1:8787", workspaceId: "workspace", bearerToken: "test-token" });
  const lineage = { artifactVersionId: "v1", artifactId: "artifact", versionNumber: "1", sha256: "a".repeat(64), sourceKind: "HUMAN", contentAvailability: "AVAILABLE" as const, directParents: [] };
  const mounted = await mountReact(createElement(ArtifactTextLocksPanel, { client, lineage })); unmount = mounted.unmount; await flush();
  const lock = () => mounted.wrapper.findAll("button").find(button => button.text() === "锁定所选原文")!;
  await lock().trigger("click"); await flush();
  expect(ids).toHaveLength(1);
  expect(lock().attributes("disabled")).toBeDefined();
  expect(mounted.wrapper.text()).toContain(ids[0]);
  await mounted.wrapper.findAll("button").find(button => button.text() === "刷新锁定事实")!.trigger("click"); await flush();
  await lock().trigger("click"); await flush();
  console.log("TRIAGE_TEXT_LOCK_RECOVERY", JSON.stringify({ ids, receiptReads }));
  expect(new Set(ids).size).toBe(1);
});
