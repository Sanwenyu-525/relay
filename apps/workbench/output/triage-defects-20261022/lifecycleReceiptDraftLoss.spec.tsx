import { afterEach, expect, it, vi } from "vitest";
import { activateRelayConnection, resetRelayConnectionForTest } from "../../src/lib/relayConnection";
import { flush, mountWorkbench } from "../../tests/mountApp";
const wid = "11111111-1111-4111-8111-111111111111";
const mid = "33333333-3333-4333-8333-333333333333";
let unmount: (() => void) | null = null;
afterEach(() => { unmount?.(); unmount = null; resetRelayConnectionForTest(); vi.unstubAllGlobals(); });
function response(body: unknown, status = 200): Response { return { ok: status < 400, status, json: async () => body } as Response; }
it.each([false, true])("恢复记忆直接成功/补查回执成功均须保留无关新建草稿，丢响应=%s", async (loseResponse) => {
  let active = false;
  let commandId = "";
  let writes = 0;
  const memory = () => ({ id: mid, project_id: null, title: "原停用记忆", status: active ? "ACTIVE" : "RETIRED", revision: active ? "1" : "0", current_version: "1", text: "旧内容", confirmed_by: "local-user", confirmed_at: "2026-09-23T00:00:00Z", expires_at: null, created_at: "2026-09-23T00:00:00Z", updated_at: "2026-09-23T00:00:00Z" });
  const envelope = () => ({ command_id: commandId, command_type: "ReactivateMemory", committed_at: "2026-10-23T00:00:00Z", result: { memory_id: mid, revision: "1", status: "ACTIVE" } });
  activateRelayConnection({ baseUrl: "http://127.0.0.1:8787", workspaceId: wid, bearerToken: "test-token" });
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    if (url.pathname.endsWith(`/memories/${mid}/reactivate`)) {
      writes++; commandId = JSON.parse(String(init?.body)).command_id; active = true;
      if (loseResponse) throw new TypeError("response lost after commit");
      return response(envelope());
    }
    if (url.pathname.includes("/commands/")) return response(envelope());
    if (url.pathname.endsWith("/memories")) return response([memory()]);
    if (url.pathname.endsWith(`/memories/${mid}`)) return response(memory());
    if (url.pathname.endsWith(`/memories/${mid}/revisions`)) return response([]);
    if (url.pathname.endsWith("/attention/interventions")) return response({ items: [] });
    if (url.pathname.endsWith("/projects")) return response({ items: [], next_cursor: null });
    return response([]);
  }));
  const mounted = await mountWorkbench(`/knowledge?kind=MEMORY&item=${mid}`); unmount = mounted.unmount; await flush();
  expect(mounted.wrapper.find('[data-testid="knowledge-restore"]').exists()).toBe(true);
  await mounted.wrapper.get('[data-testid="knowledge-create"]').trigger("click");
  await mounted.wrapper.get('[data-testid="knowledge-title"]').setValue("未提交的新记忆标题");
  await mounted.wrapper.get('[data-testid="memory-text"]').setValue("独立的新草稿正文，恢复旧记忆不能删除它");
  await mounted.wrapper.get('[data-testid="knowledge-restore"]').trigger("click"); await flush();
  if (loseResponse) { expect(mounted.wrapper.find('[data-testid="knowledge-pending-receipt"]').exists()).toBe(true); await mounted.wrapper.get('[data-testid="knowledge-check-receipt"]').trigger("click"); await flush(); }
  const form = mounted.wrapper.find('[data-testid="knowledge-form"]');
  const formPresentAfterRecovery = form.exists();
  if (!formPresentAfterRecovery) { await mounted.wrapper.get('[data-testid="knowledge-create"]').trigger("click"); await flush(); }
  const title = (mounted.wrapper.find('[data-testid="knowledge-title"]').element as HTMLInputElement | null)?.value ?? null;
  const text = (mounted.wrapper.find('[data-testid="memory-text"]').element as HTMLTextAreaElement | null)?.value ?? null;
  console.log("TRIAGE_LIFECYCLE_RECEIPT_DRAFT", JSON.stringify({ loseResponse, writes, active, formPresentAfterRecovery, titleAfterReopenIfNeeded: title, textAfterReopenIfNeeded: text }));
  expect(writes).toBe(1); expect(active).toBe(true);
  expect(title).toBe("未提交的新记忆标题");
  expect(text).toBe("独立的新草稿正文，恢复旧记忆不能删除它");
});
