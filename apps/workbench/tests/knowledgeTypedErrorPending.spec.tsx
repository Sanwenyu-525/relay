import { afterEach, describe, expect, it, vi } from "vitest";
import { activateRelayConnection, resetRelayConnectionForTest } from "../src/lib/relayConnection";
import { flush, mountWorkbench } from "./mountApp";

/**
 * 禅道 #32（DEV-0128）：资料写入遇到 typed 503（CHECK_RECEIPT_THEN_RETRY）时，
 * submit 的 catch 只把传输错误留在 UNCERTAIN，其余异常一律清 pending 按 REJECTED 释放，
 * 于是 503 被当成明确拒绝：保存按钮重新可用、重按保存换新 command_id。
 *
 * 修复口径（契约 §7 错误表 + lib/liveErrors needsReceiptCheck）：
 * - 传输失败、5xx、retry_action 要求核对回执 ⇒ 保留原命令与草稿，只按原 command_id 核对；
 * - 服务端明确业务拒绝（422、409 等）⇒ 释放 pending，允许修正后换新命令重发。
 * submit 是 Knowledge／Memory／Decision／Rule 共用入口，这里覆盖 Knowledge 创建与
 * Memory 修订两条调用点；Decision／Rule 走同一 catch，不另设用例。
 */

const baseUrl = "http://127.0.0.1:8787";
const workspaceId = "11111111-1111-4111-8111-111111111111";
const base = `${baseUrl}/api/v1/workspaces/${workspaceId}`;
const knowledgeId = "33333333-3333-4333-8333-333333333333";
const memoryId = "55555555-5555-4555-8555-555555555555";

let unmount: (() => void) | null = null;

function response(status: number, body: unknown): Response {
  return { ok: status >= 200 && status < 300, status, json: async () => body } as Response;
}

function activate(): void {
  activateRelayConnection({ baseUrl, workspaceId, bearerToken: "test-token" });
}

function knowledgeRow(id = knowledgeId) {
  return { id, project_id: null, title: "typed 503 probe", status: "ACTIVE", revision: "1",
    current_version: "1", created_at: "2026-10-24T00:00:00.000Z", updated_at: "2026-10-24T00:00:00.000Z" };
}

function memoryRow() {
  return { id: memoryId, project_id: null, title: "expiring fact", status: "ACTIVE", revision: "1",
    current_version: "1", text: "original text", confirmed_by: "local-user",
    confirmed_at: "2026-10-01T00:00:00.000Z", expires_at: "2026-12-31T00:00:00.000Z",
    effective_status: "ACTIVE", created_at: "2026-10-01T00:00:00.000Z", updated_at: "2026-10-01T00:00:00.000Z" };
}

/** 空列表等常规读取，避免噪声请求干扰被断言的写路径。 */
function common(url: string): Response {
  if (url.endsWith("/attention/interventions")) return response(200, { items: [] });
  if (url.endsWith("/tasks?scope=all")) return response(200, { items: [], next_cursor: null });
  if (url.includes("/assist-sessions")) return response(200, { items: [] });
  if (url.includes("/projects?")) return response(200, { items: [], next_cursor: null });
  return response(200, []);
}

afterEach(() => {
  unmount?.(); unmount = null;
  resetRelayConnectionForTest();
  vi.unstubAllGlobals();
});

describe("资料提交的结果未知分类", () => {
  it("typed 503 保留原命令与草稿：重复提交不换 ID，回执核对后恢复且不产生第二个资料", async () => {
    activate();
    const posted: Record<string, unknown>[] = [];
    let receiptFound = false;
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === `${base}/knowledge` && init?.method === "POST") {
        posted.push(JSON.parse(String(init.body)));
        // 提交成功但回包 503：服务端可能已入库，浏览器无法区分。
        return response(503, { code: "DATABASE_UNAVAILABLE", detail: "response uncertain",
          retryable: true, retry_action: "CHECK_RECEIPT_THEN_RETRY" });
      }
      if (url.startsWith(`${base}/commands/`)) {
        const commandId = url.slice(`${base}/commands/`.length);
        if (!receiptFound) return response(404, { code: "COMMAND_NOT_FOUND", detail: "尚未提交", retryable: true });
        return response(200, { command_id: commandId, command_type: "CreateKnowledge",
          committed_at: "2026-10-24T00:01:00.000Z",
          result: { knowledge_id: knowledgeId, revision: "1", status: "ACTIVE", version: "1" } });
      }
      if (url === `${base}/knowledge`) return response(200, receiptFound ? [knowledgeRow()] : []);
      if (url === `${base}/knowledge/${knowledgeId}`) return response(200, knowledgeRow());
      if (url === `${base}/knowledge/${knowledgeId}/versions`) return response(200, []);
      return common(url);
    }));
    const mounted = await mountWorkbench("/knowledge"); unmount = mounted.unmount;
    await mounted.wrapper.get('[data-testid="knowledge-create"]').trigger("click");
    await mounted.wrapper.get('[data-testid="knowledge-title"]').setValue("typed 503 probe");
    await mounted.wrapper.get('[data-testid="knowledge-text"]').setValue("typed 503 content");
    await mounted.wrapper.get('[data-testid="knowledge-form"]').trigger("submit");
    await flush(30);

    // 503 后原命令与草稿都保留：保存不再可用，未决面板给出原 ID，输入值未被清掉。
    expect(posted).toHaveLength(1);
    const pending = mounted.wrapper.get('[data-testid="knowledge-pending-receipt"]');
    expect(pending.text()).toContain(String(posted[0]!.command_id));
    expect(mounted.wrapper.get('[data-testid="knowledge-save"]').attributes("disabled")).toBeDefined();
    expect((mounted.wrapper.get('[data-testid="knowledge-title"]').element as HTMLInputElement).value).toBe("typed 503 probe");
    expect((mounted.wrapper.get('[data-testid="knowledge-text"]').element as HTMLTextAreaElement).value).toBe("typed 503 content");

    // 再次提交不得换新命令：submit 在未决期间直接拦下，不产生第二个 POST。
    await mounted.wrapper.get('[data-testid="knowledge-form"]').trigger("submit");
    await flush(30);
    expect(posted).toHaveLength(1);
    expect(new Set(posted.map((item) => item.command_id)).size).toBe(1);

    // 回执还没出现（数据库不可用时回执查询也可能失败）：保持未知，继续保留原 ID。
    await mounted.wrapper.get('[data-testid="knowledge-check-receipt"]').trigger("click");
    await flush(30);
    expect(mounted.wrapper.get('[data-testid="knowledge-pending-receipt"]').text()).toContain(String(posted[0]!.command_id));
    expect(mounted.wrapper.text()).toContain("请稍后仍用同一个 command_id 核对");

    // 回执出现且目标匹配：原 ID 恢复收口，列表重读，全程只有一次创建命令。
    receiptFound = true;
    await mounted.wrapper.get('[data-testid="knowledge-check-receipt"]').trigger("click");
    await flush(60);
    expect(mounted.wrapper.find('[data-testid="knowledge-pending-receipt"]').exists()).toBe(false);
    expect(posted).toHaveLength(1);
    expect(mounted.wrapper.text()).toContain("已核对原命令回执");
  });

  it("422 明确拒绝释放 pending：可修正后换新命令重发", async () => {
    activate();
    const posted: Record<string, unknown>[] = [];
    let reject = true;
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === `${base}/knowledge` && init?.method === "POST") {
        posted.push(JSON.parse(String(init.body)));
        if (reject) return response(422, { code: "VALIDATION_FAILED", detail: "标题不符合要求",
          field_errors: [], retryable: false });
        return response(201, { command_id: String(posted.at(-1)!.command_id), committed_at: "2026-10-24T00:01:00.000Z",
          result: { knowledge_id: knowledgeId, revision: "1", status: "ACTIVE", version: "1" } });
      }
      if (url === `${base}/knowledge`) return response(200, reject ? [] : [knowledgeRow()]);
      if (url === `${base}/knowledge/${knowledgeId}`) return response(200, knowledgeRow());
      if (url === `${base}/knowledge/${knowledgeId}/versions`) return response(200, []);
      return common(url);
    }));
    const mounted = await mountWorkbench("/knowledge"); unmount = mounted.unmount;
    await mounted.wrapper.get('[data-testid="knowledge-create"]').trigger("click");
    await mounted.wrapper.get('[data-testid="knowledge-title"]').setValue("rejected title");
    await mounted.wrapper.get('[data-testid="knowledge-text"]').setValue("rejected content");
    await mounted.wrapper.get('[data-testid="knowledge-form"]').trigger("submit");
    await flush(30);

    // 明确业务拒绝：没有未决面板，错误可读，保存按钮回到可用状态。
    expect(posted).toHaveLength(1);
    expect(mounted.wrapper.find('[data-testid="knowledge-pending-receipt"]').exists()).toBe(false);
    expect(mounted.wrapper.text()).toContain("请求未通过服务端校验");
    expect(mounted.wrapper.get('[data-testid="knowledge-save"]').attributes("disabled")).toBeUndefined();

    // 修正后可以换新命令重发：新 ID、新内容，不再被旧命令拦住。
    reject = false;
    await mounted.wrapper.get('[data-testid="knowledge-title"]').setValue("fixed title");
    await mounted.wrapper.get('[data-testid="knowledge-form"]').trigger("submit");
    await flush(60);
    expect(posted).toHaveLength(2);
    expect(posted[1]!.command_id).not.toBe(posted[0]!.command_id);
    expect(posted[1]!.title).toBe("fixed title");
  });

  it("MEMORY 修订提交遇 typed 503 同样保留 pending 与草稿", async () => {
    activate();
    const posted: Record<string, unknown>[] = [];
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === `${base}/memories`) return response(200, [memoryRow()]);
      if (url === `${base}/memories/${memoryId}`) return response(200, memoryRow());
      if (url === `${base}/memories/${memoryId}/revisions` && init?.method === "POST") {
        posted.push(JSON.parse(String(init.body)));
        return response(503, { code: "DATABASE_UNAVAILABLE", detail: "response uncertain",
          retryable: true, retry_action: "CHECK_RECEIPT_THEN_RETRY" });
      }
      if (url === `${base}/memories/${memoryId}/revisions`) return response(200, []);
      return common(url);
    }));
    const mounted = await mountWorkbench("/knowledge?kind=MEMORY"); unmount = mounted.unmount;
    await flush(30);
    await mounted.wrapper.get('[data-testid="knowledge-new-version"]').trigger("click");
    await mounted.wrapper.get('[data-testid="memory-text"]').setValue("edited text only");
    await mounted.wrapper.get('[data-testid="memory-confirmed"]').setValue(true);
    await mounted.wrapper.get('[data-testid="knowledge-form"]').trigger("submit");
    await flush(30);

    expect(posted).toHaveLength(1);
    expect(mounted.wrapper.get('[data-testid="knowledge-pending-receipt"]').text()).toContain(String(posted[0]!.command_id));
    expect(mounted.wrapper.get('[data-testid="knowledge-save"]').attributes("disabled")).toBeDefined();
    expect((mounted.wrapper.get('[data-testid="memory-text"]').element as HTMLTextAreaElement).value).toBe("edited text only");
    await mounted.wrapper.get('[data-testid="knowledge-form"]').trigger("submit");
    await flush(30);
    expect(posted).toHaveLength(1);
  });
});
