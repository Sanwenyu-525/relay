import { afterEach, expect, it, vi } from "vitest";
import { activateRelayConnection, resetRelayConnectionForTest } from "../../src/lib/relayConnection";
import { flush, mountWorkbench } from "../../tests/mountApp";
const pid = "22222222-2222-4222-8222-222222222222";
const kid = "88888888-8888-4888-8888-888888888888";
let unmount: (() => void) | null = null;
afterEach(() => { unmount?.(); unmount = null; resetRelayConnectionForTest(); vi.unstubAllGlobals(); });
function response(body: unknown): Response { return { ok: true, status: 200, json: async () => body } as Response; }
it("点击导读钉住v1的资料应读取v1，不能默认读取当前v2", async () => {
  activateRelayConnection({ baseUrl: "http://127.0.0.1:8787", workspaceId: "11111111-1111-4111-8111-111111111111", bearerToken: "test-token" });
  const contentReads: string[] = [];
  const root = { id: kid, project_id: pid, title: "PINNED_GUIDE_TITLE", status: "ACTIVE", revision: "2", current_version: "2", created_at: "2026-10-01T00:00:00Z", updated_at: "2026-10-22T00:00:00Z" };
  const version = (v: string) => ({ id: `version-${v}`, knowledge_id: kid, version: v, source_kind: "NOTE", media_type: "text/markdown", content_sha256: "a".repeat(64), availability: "AVAILABLE", excerpt: null, source_refs: {}, created_at: "2026-10-01T00:00:00Z" });
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
    const url = new URL(String(input)); const path = url.pathname;
    const content = /\/knowledge\/[^/]+\/versions\/(\d+)\/content$/.exec(path);
    if (content) { contentReads.push(content[1]); return response({ ...version(content[1]), title: root.title, project_id: pid, current_version: "2", source_uri: null, content_status: "FULL", content: content[1] === "1" ? "PINNED_BODY_v1" : "CURRENT_BODY_v2" }); }
    if (path.endsWith(`/knowledge/${kid}/versions`)) return response([version("2"), version("1")]);
    if (path.endsWith(`/knowledge/${kid}`)) return response(root);
    if (path.endsWith("/knowledge")) return response([root]);
    if (path.endsWith("/knowledge-guide")) return response({ project_id: pid, exists: true, revision: "1", entry_count: 1, gaps: [], entries: [{ ordinal: 0, ref_kind: "KNOWLEDGE", reference_mode: "PINNED", target_id: kid, label: null, title: root.title,
      resolved_version_id: "version-1", resolved_version_number: "1", target_status: "ACTIVE", is_current: false, resolution: "STALE", note: "仍按固定版本阅读" }] });
    if (path.endsWith(`/projects/${pid}`)) return response({ id: pid, title: "项目", project_type: "GENERAL", revision: "1", state_revision: "1", archived_at: null });
    if (path.endsWith("/tasks") || path.endsWith("/projects") || path.endsWith("/attention/interventions")) return response({ items: [], next_cursor: null });
    return response([]);
  }));
  const mounted = await mountWorkbench(`/projects/${pid}/knowledge`); unmount = mounted.unmount; await flush();
  await mounted.wrapper.get('[data-testid="knowledge-guide-toggle"]').trigger("click"); await flush();
  expect(mounted.wrapper.get('[data-testid="project-knowledge-guide"]').text()).toContain("已钉住");
  contentReads.length = 0;
  await mounted.wrapper.get('[data-testid="guide-entry-KNOWLEDGE"] button').trigger("click"); await flush();
  console.log("TRIAGE_GUIDE_PINNED_READ", JSON.stringify({ contentReads, reading: mounted.wrapper.get('[data-testid="knowledge-reader"]').text().includes("CURRENT_BODY_v2") }));
  expect(contentReads).toContain("1");
  expect(mounted.wrapper.get('[data-testid="knowledge-reader"]').text()).toContain("PINNED_BODY_v1");
});
