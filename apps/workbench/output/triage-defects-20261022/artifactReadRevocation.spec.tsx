import { createElement } from "react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, expect, it, vi } from "vitest";
import { RelayApiClient } from "../../src/api/relayClient";
import ArtifactReaderPanel from "../../src/components/ArtifactReaderPanel";
import { flush, mountReact } from "../../tests/mountApp";
let unmount: (() => void) | null = null;
afterEach(() => { unmount?.(); unmount = null; vi.unstubAllGlobals(); });
function response(status: number, body: unknown): Response {
  return { ok: status >= 200 && status < 300, status, json: async () => body, text: async () => String(body) } as Response;
}
it("版本比较重读当前正文收到403后，应撤下当前已读受限正文", async () => {
  let denied = false; const reads: string[] = [];
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.endsWith("/tasks/task/artifacts")) return response(200, { current_accepted_version_ids: [], items: [{ id: "artifact", task_id: "task", title: "资料.md", revision: "2", latest_version_id: "v2", version_count: 2,
      versions: ["v2", "v1"].map(id => ({ artifact_version_id: id, version_number: id.slice(1), media_type: "text/markdown", sha256: "a".repeat(64), size: "10", source_kind: "HUMAN", created_at: "2026-10-22T00:00:00Z" })) }] });
    if (url.endsWith("/content")) {
      reads.push(url);
      if (denied && url.endsWith("/v2/content")) return response(403, { code: "FORBIDDEN", detail: "当前版本读取权限已撤销" });
      return response(200, url.endsWith("/v2/content") ? "revoked-private-body-sentinel" : "baseline body");
    }
    throw new Error(`unexpected ${url}`);
  }));
  const client = new RelayApiClient({ baseUrl: "http://127.0.0.1:8787", workspaceId: "workspace", bearerToken: "test-token" });
  const mounted = await mountReact(createElement(MemoryRouter, null, createElement(ArtifactReaderPanel, { client, taskId: "task", projectId: null, selectedVersionId: "v2", draft: null })));
  unmount = mounted.unmount; await flush();
  expect(mounted.wrapper.get('[data-testid="collab-reading"]').text()).toContain("revoked-private-body-sentinel");
  denied = true;
  await mounted.wrapper.get('[data-testid="collab-compare-base"]').setValue("v1");
  await mounted.wrapper.get('[data-testid="collab-compare-open"]').trigger("click"); await flush();
  expect(reads.filter(url => url.endsWith("/v2/content"))).toHaveLength(2);
  expect(mounted.wrapper.text()).toContain("当前版本读取权限已撤销");
  expect(mounted.wrapper.find('[data-testid="collab-compare"]').exists()).toBe(false);
  expect(mounted.wrapper.text()).not.toContain("revoked-private-body-sentinel");
});
