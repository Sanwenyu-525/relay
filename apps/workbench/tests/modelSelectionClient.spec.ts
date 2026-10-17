import { afterEach, expect, it, vi } from "vitest";
import { RelayApiClient, RelayTransportError } from "../src/api/relayClient";

afterEach(() => vi.unstubAllGlobals());
const api = () => new RelayApiClient({ baseUrl: "http://127.0.0.1:8787", workspaceId: "w1", bearerToken: "synthetic" });
const selection = { session_id: "s1", connection: "openrouter", model: "vendor/model:free", free_only: true, revision: "7" };

it("模型选择沿原聊天命令提交并核对确切会话/型号，首条消息携带原 revision", async () => {
  const posts: Record<string, unknown>[] = [];
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)); posts.push(body);
    return new Response(JSON.stringify({ command_id: body.command_id, committed_at: "2026-10-17T00:00:00Z",
      result: url.endsWith("/chat-commands") ? { kind: "MODEL_SELECTION", ...selection }
        : { session_id: "s1", user_message_id: "u1", assistant_message_id: "a1" } }), { status: url.endsWith("/messages") ? 202 : 200 });
  }));
  const client = api();
  const selected = await client.selectSessionModel({ sessionId: "s1", commandId: "choose1", model: selection.model });
  await client.requestAssistMessage({ sessionId: "s1", commandId: "send1", content: "synthetic", sourceRefs: [],
    expectedModelSelectionRevision: selected.revision });
  expect(posts).toEqual([{ command_id: "choose1", text: "/model vendor/model:free" },
    { command_id: "send1", content: "synthetic", source_refs: [], expected_model_selection_revision: "7" }]);
});

it("成功状态的错配选择回执仍是待核对，不假报保存成功", async () => {
  vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ command_id: "choose1",
    committed_at: "2026-10-17T00:00:00Z", result: { kind: "MODEL_SELECTION", ...selection, session_id: "other" } }))));
  await expect(api().selectSessionModel({ sessionId: "s1", commandId: "choose1", model: selection.model })).rejects.toBeInstanceOf(RelayTransportError);
});

it("读取目录不推理，不选随机路由，未知生成配置保持不可调用", async () => {
  const fetcher = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => new Response(JSON.stringify({ configured: true, snapshot_seq: "9",
    last_success_at: null, last_failure_reason: null, cache_stale: true, free_count: 2,
    entries: [selection.model, "openrouter/free"].map((id) => ({ source_model_id: id, display_name: id,
      context_window: null, is_free: true, capabilities: { tools: null, text_input: true, text_output: true } })) })));
  vi.stubGlobal("fetch", fetcher);
  const catalog = await api().getModelCatalog();
  expect(catalog.chatConfigured).toBe(false);
  expect(catalog.models.map((model) => model.id)).toEqual([selection.model]);
  expect(catalog.models[0]?.tools).toBeNull();
  expect(fetcher).toHaveBeenCalledTimes(1);
  expect(fetcher.mock.calls[0]?.[1]).not.toHaveProperty("method", "POST");
});
