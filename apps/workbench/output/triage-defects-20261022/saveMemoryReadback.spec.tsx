import { createElement } from "react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, expect, it, vi } from "vitest";
import { RelayApiClient } from "../../src/api/relayClient";
import SaveMemoryDialog from "../../src/components/SaveMemoryDialog";
import { DomWrapper, flush, mountReact } from "../../tests/mountApp";
const wid = "11111111-1111-4111-8111-111111111111";
const sid = "33333333-3333-4333-8333-333333333333";
const mid = "44444444-4444-4444-8444-444444444444";
const memoryId = "55555555-5555-4555-8555-555555555555";
let unmount: (() => void) | null = null;
afterEach(() => { unmount?.(); unmount = null; vi.unstubAllGlobals(); document.body.innerHTML = ""; });
function json(body: unknown, status = 200) { return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } }); }
it("记忆创建201后读回503，应重试读取已知memoryId而不能再创建", async () => {
  const posts: Record<string, unknown>[] = [];
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.endsWith("/messages?limit=200")) return json({ items: [{ id: mid, session_id: sid, seq: "4", role: "USER", status: "COMPLETED", intent: "DISCUSS", content: "后续任务都需要保留证据", error_code: null, sources: [], usage: { input_tokens: null, output_tokens: null }, cancel_requested: false, steer_requested: false, attachments: [], created_at: "2026-10-20T00:00:00.000Z" }] });
    if (init?.method === "POST") {
      const body = JSON.parse(String(init.body)); posts.push(body);
      return json({ command_id: body.command_id, committed_at: "2026-10-22T00:00:00.000Z", result: { memory_id: memoryId, revision: "0", version: "1", status: "ACTIVE" } }, 201);
    }
    if (url.endsWith("/provenance")) return json({ memory_id: memoryId, sources: [] });
    if (url.endsWith(`/memories/${memoryId}`)) return json({ code: "DATABASE_UNAVAILABLE", detail: "read unavailable" }, 503);
    throw new Error(`unexpected ${url}`);
  }));
  const client = new RelayApiClient({ baseUrl: "http://127.0.0.1:8787", workspaceId: wid, bearerToken: "test-token" });
  const mounted = await mountReact(createElement(MemoryRouter, null, createElement(SaveMemoryDialog, { client, sessionId: sid, sessionRevision: "7", sessionProjectId: null, messageId: mid, onClose: vi.fn() })));
  unmount = mounted.unmount; await flush();
  const portal = new DomWrapper(document.body);
  await portal.get('[data-testid="save-memory-confirm"]').trigger("click"); await flush();
  expect(posts.length).toBe(1);
  expect(portal.get('[data-testid="save-memory-error"]').text()).toContain("数据库不可达");
  const disabled = portal.get('[data-testid="save-memory-confirm"]').attributes("disabled") !== undefined;
  const pending = portal.find('[data-testid="save-memory-pending"]').exists();
  if (!disabled) { await portal.get('[data-testid="save-memory-confirm"]').trigger("click"); await flush(); }
  console.log("TRIAGE_SAVE_MEMORY_READBACK", JSON.stringify({ disabled, pending, ids: posts.map(p => p.command_id), knownCreatedMemoryVisible: portal.text().includes(memoryId) }));
  expect(posts.length).toBe(1);
});

