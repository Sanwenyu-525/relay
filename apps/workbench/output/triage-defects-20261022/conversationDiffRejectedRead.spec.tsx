import { createElement } from "react";
import { afterEach, expect, it, vi } from "vitest";
import ConversationDiffSummary from "../../src/components/ConversationDiffSummary";
import { RelayApiClient, RelayApiError, RelayTransportError } from "../../src/api/relayClient";
import { flush, mountReact } from "../../tests/mountApp";
let unmount: (() => void) | null = null;
afterEach(() => { unmount?.(); unmount = null; vi.unstubAllGlobals(); });
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
it.each([403, 404])("会话diff明确拒读HTTP %s后应撤下旧路径/展开正文，不能伪装成暂时断网", async (failureStatus) => {
  let phase: "readable" | "rejected" | "unavailable" = "readable";
  const sid = "33333333-3333-4333-8333-333333333333";
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
    const url = new URL(String(input));
    if (phase === "rejected") return json({ code: failureStatus === 403 ? "PERMISSION_DENIED" : "RESOURCE_NOT_FOUND", detail: "current source access rejected" }, failureStatus);
    if (phase === "unavailable") return json({ available: false, reason: "RESOURCE_UNAVAILABLE" });
    if (url.pathname.endsWith("/file")) return json({ available: true, path: "confidential.txt", action: "MODIFY", added: 1, removed: 0, unavailable_reason: null, rows: [{ kind: "ADD", old_line: null, new_line: 1, text: "PREVIOUSLY_READ_BODY_MUST_HIDE_ON_REJECTION" }], rows_truncated: false, rows_unavailable_reason: null });
    return json({ available: true, scope: "SESSION", baseline_captured_at: "2026-10-23T00:00:00Z", baseline_revision: "3", root_path: "D:\\PRIVATE_ROOT_PROBE", resource_id: "resource-probe", incomplete: false, coverage: null, total_files: 1, total_added: 1, total_removed: 0, files: [{ path: "confidential.txt", action: "MODIFY", added: 1, removed: 0, unavailable_reason: null }] });
  }));
  const client = new RelayApiClient({ baseUrl: "http://127.0.0.1:8787", workspaceId: "11111111-1111-4111-8111-111111111111", bearerToken: "test-token" });
  const mounted = await mountReact(createElement(ConversationDiffSummary, { client, sessionId: sid, enabled: true, directoryBound: true })); unmount = mounted.unmount; await flush();
  await mounted.wrapper.get('[data-testid="conversation-diff-toggle"]').trigger("click"); await flush();
  await mounted.wrapper.get('[data-testid="conversation-diff-file-toggle-confidential.txt"]').trigger("click"); await flush();
  expect(mounted.wrapper.text()).toContain("PREVIOUSLY_READ_BODY_MUST_HIDE_ON_REJECTION");
  phase = "rejected";
  await mounted.wrapper.get('[data-testid="conversation-diff-refresh"]').trigger("click"); await flush();
  const oldRootVisible = mounted.wrapper.text().includes("PRIVATE_ROOT_PROBE");
  const oldBodyVisible = mounted.wrapper.text().includes("PREVIOUSLY_READ_BODY_MUST_HIDE_ON_REJECTION");
  const staleVisible = mounted.wrapper.find('[data-testid="conversation-diff-stale"]').exists();
  let errorClass = "";
  try { await client.getConversationDiff(sid); } catch (caught) { errorClass = caught instanceof RelayApiError ? "RelayApiError" : caught instanceof RelayTransportError ? "RelayTransportError" : "other"; }
  phase = "unavailable";
  await mounted.wrapper.get('[data-testid="conversation-diff-refresh"]').trigger("click"); await flush();
  const hidesOnUnavailableDto = !mounted.wrapper.text().includes("PREVIOUSLY_READ_BODY_MUST_HIDE_ON_REJECTION");
  console.log("TRIAGE_CONVERSATION_DIFF_REJECTED_READ", JSON.stringify({ failureStatus, errorClass, oldRootVisible, oldBodyVisible, staleVisible, hidesOnUnavailableDto }));
  expect(hidesOnUnavailableDto).toBe(true);
  expect(oldBodyVisible).toBe(false); expect(oldRootVisible).toBe(false);
});
