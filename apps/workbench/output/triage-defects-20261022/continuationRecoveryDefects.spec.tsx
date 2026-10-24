import { createElement } from "react";
import { afterEach, expect, it, vi } from "vitest";
import ContinuationPointPanel from "../../src/components/ContinuationPointPanel";
import { RelayApiClient } from "../../src/api/relayClient";
import { flush, mountReact } from "../../tests/mountApp";

const projectId = "22222222-2222-4222-8222-222222222222";
let unmount: (() => void) | null = null;
afterEach(() => { unmount?.(); unmount = null; sessionStorage.clear(); vi.unstubAllGlobals(); });
function response(status: number, body: unknown): Response {
  return { ok: status >= 200 && status < 300, status, json: async () => body } as Response;
}

for (const populated of [false, true]) {
  it(`接续点首次列表失败，父页重读成功${populated ? "有内容" : "空列表"}后应撤下旧错误`, async () => {
    const client = new RelayApiClient({ baseUrl: "http://127.0.0.1:8787", workspaceId: "11111111-1111-4111-8111-111111111111", bearerToken: "test-token" });
    let reads = 0;
    vi.stubGlobal("fetch", vi.fn(async () => {
      reads++;
      if (reads === 1) return response(503, { code: "DATABASE_UNAVAILABLE", detail: "temporary failure" });
      return response(200, { items: populated ? [{ id: "33333333-3333-4333-8333-333333333333", project_id: projectId, name: "已恢复接续点", note: null,
        captured_at: "2026-10-22T00:00:00.000Z", captured_state: { phase_key: "DISCOVERY", revision: "1", next_action_task_id: null }, ref_count: 0 }] : [] });
    }));
    const mounted = await mountReact(createElement(ContinuationPointPanel, { client, projectId, factsReadable: true }));
    unmount = mounted.unmount; await flush();
    expect(mounted.wrapper.text()).toContain("接续点没有读到");
    await mounted.rerender(createElement(ContinuationPointPanel, { client, projectId, factsReadable: false, captureBlockedReason: "正在重读项目事实" }));
    await mounted.rerender(createElement(ContinuationPointPanel, { client, projectId, factsReadable: true }));
    await flush();
    expect(reads).toBe(2);
    if (populated) expect(mounted.wrapper.text()).toContain("已恢复接续点");
    expect(mounted.wrapper.find('[role="alert"]').exists()).toBe(false);
    if (!populated) expect(mounted.wrapper.text()).toContain("还没有保存过接续点");
  });
}
