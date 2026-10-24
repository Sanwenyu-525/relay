import { afterEach, expect, it, vi } from "vitest";
import { activateRelayConnection, resetRelayConnectionForTest } from "../../src/lib/relayConnection";
import { flush, mountWorkbench } from "../../tests/mountApp";
const wid = "11111111-1111-4111-8111-111111111111";
const pid = "33333333-3333-4333-8333-333333333333";
let unmount: (() => void) | null = null;
afterEach(() => { unmount?.(); unmount = null; resetRelayConnectionForTest(); vi.unstubAllGlobals(); });
function response(body: unknown): Response { return { ok: true, status: 200, json: async () => body } as Response; }
it("把默认目录从A改成B后，读回与成功提示必须同指B", async () => {
  let changed = false;
  const writes: Record<string, unknown>[] = [];
  activateRelayConnection({ baseUrl: "http://127.0.0.1:8787", workspaceId: wid, bearerToken: "test-token" });
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = new URL(String(input)).pathname;
    const body = init?.body ? JSON.parse(String(init.body)) : null;
    if (path.endsWith("/model-port")) return response({ provider: "fake", configured: false, model: null, base_url: null, max_call_tokens: null });
    if (path.endsWith("/model-port/verification")) return response({ current_config_fingerprint: null, last: null, matches_current_config: false, worker_startup_validation: "NOT_CONFIGURED" });
    if (path.endsWith("/default-working-directory")) {
      if (init?.method === "POST") { changed = true; writes.push(body); return response({ command_id: body.command_id, committed_at: "2026-10-22T00:00:00Z", result: { workspace_id: wid, resource_id: "res-B", revision: "2" } }); }
      return response({ resource_id: changed ? "res-B" : "res-A", canonical_root: changed ? "D:\\ProjectB" : "D:\\ProjectA", display_name: changed ? "ProjectB" : "ProjectA", write_tier: "READ_ONLY", default_write_tier: null, status: "READY", reason: null, revision: changed ? "2" : "1" });
    }
    if (path.endsWith("/working-directories/open")) return response({ command_id: body.command_id, committed_at: "2026-10-22T00:00:00Z", result: { canonical_root: "D:\\ProjectB", display_name: "ProjectB", status: "READY", reason: null, association: { project_id: pid, project_title: "ProjectB", project_archived: false, resource_id: "res-B", resource_status: "ACTIVE", file_write_identity_bound: true }, created_project: false, created_resource: false, candidates: [], write_readiness: { status: "READY", detail: "ready" } } });
    if (path.endsWith("/memory-settings")) return response({ workspace_id: wid, revision: "0", recall_enabled: true, automatic_compaction: true, auto_capture: true });
    if (path.endsWith("/attention/interventions")) return response({ items: [] });
    return response([]);
  }));
  const mounted = await mountWorkbench("/settings"); unmount = mounted.unmount; await flush();
  expect(mounted.wrapper.get('[data-testid="settings-default-directory-value"]').text()).toContain("ProjectA");
  await mounted.wrapper.get('[data-testid="settings-default-directory-manual"]').setValue("D:\\ProjectB");
  await mounted.wrapper.get('[data-testid="settings-default-directory-manual-submit"]').trigger("click"); await flush();
  const value = mounted.wrapper.get('[data-testid="settings-default-directory-value"]').text();
  const notice = mounted.wrapper.get('[data-testid="settings-default-directory-notice"]').text();
  expect(writes[0]?.resource_id).toBe("res-B"); expect(value).toContain("ProjectB");
  console.log("TRIAGE_DEFAULT_DIRECTORY_NOTICE", JSON.stringify({ value, notice, writes }));
  expect(notice).toContain("ProjectB");
});
