import { createElement } from "react";
import { afterEach, expect, it, vi } from "vitest";
import AssistSourcePicker from "../../src/components/AssistSourcePicker";
import { activateRelayConnection, resetRelayConnectionForTest } from "../../src/lib/relayConnection";
import { flush, mountReact } from "../../tests/mountApp";
const pid = "22222222-2222-4222-8222-222222222222";
let unmount: (() => void) | null = null;
afterEach(() => { unmount?.(); unmount = null; resetRelayConnectionForTest(); vi.unstubAllGlobals(); });
it("记录资料选择器当前只展示首20项且无续页入口的功能边界", async () => {
  const reads: (string | null)[] = [];
  activateRelayConnection({ baseUrl: "http://127.0.0.1:8787", workspaceId: "11111111-1111-4111-8111-111111111111", bearerToken: "test-token" });
  const source = (i: number) => ({ type: "KNOWLEDGE", id: `33333333-3333-4333-8333-${String(i).padStart(12, "0")}`, version: "1", title: `资料${i}`, snippet: "项目资料", matched_fields: ["title"], source_ref: `knowledge-${i}:v1`, status: "ACTIVE", project_id: pid });
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
    const url = new URL(String(input)); const cursor = url.searchParams.get("cursor"); reads.push(cursor);
    return { ok: true, status: 200, json: async () => ({ items: cursor === null ? Array.from({ length: 20 }, (_, i) => source(i + 1)) : [source(21)], next_cursor: cursor === null ? "source-page+21" : null }) } as Response;
  }));
  const mounted = await mountReact(createElement(AssistSourcePicker, { projectId: pid, selectedRefs: [], onChange: vi.fn() })); unmount = mounted.unmount;
  await mounted.wrapper.get('#assist-source-query').setValue("资料");
  await mounted.wrapper.get('form').trigger('submit'); await flush();
  const visibleCount = mounted.wrapper.findAll('input[type="checkbox"]').length;
  const offersMore = mounted.wrapper.findAll('button').some(button => /更多|下一页|继续读取/.test(button.text()));
  console.log("TRIAGE_SOURCE_PICKER_PAGINATION_GAP", JSON.stringify({ reads, visibleCount, offersMore, item21Visible: mounted.wrapper.text().includes("资料21") }));
  expect(visibleCount).toBe(20); expect(reads).toEqual([null]); expect(offersMore).toBe(false);
});
