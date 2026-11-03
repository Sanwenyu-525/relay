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

it("选择已登记连接只提交 connection_id，并按连接身份核对回执", async () => {
  const posts: Record<string, unknown>[] = [];
  vi.stubGlobal("fetch", vi.fn(async (_url: string, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)); posts.push(body);
    return new Response(JSON.stringify({ command_id: body.command_id, committed_at: "2026-11-02T00:00:00Z",
      result: { kind: "MODEL_SELECTION", session_id: "s1", connection: "registered",
        connection_id: body.connection_id, model: "vendor/registered", free_only: false, revision: "3" } }));
  }));
  const selected = await api().selectSessionConnection({ sessionId: "s1", commandId: "choose-conn", connectionId: "conn-1" });
  expect(posts).toEqual([{ command_id: "choose-conn", connection_id: "conn-1" }]);
  expect(selected).toMatchObject({ connection: "registered", connectionId: "conn-1", model: "vendor/registered" });
});

it("另一条连接即使型号相同也不算本次选择成功", async () => {
  vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ command_id: "choose-conn",
    committed_at: "2026-11-02T00:00:00Z",
    result: { kind: "MODEL_SELECTION", session_id: "s1", connection: "registered",
      connection_id: "conn-2", model: "vendor/registered", free_only: false, revision: "3" } }))));
  await expect(api().selectSessionConnection({ sessionId: "s1", commandId: "choose-conn",
    connectionId: "conn-1" })).rejects.toBeInstanceOf(RelayTransportError);
});

it("清除会话选择返回服务端 cleared，不回推本地状态", async () => {
  vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ command_id: "clear-1",
    committed_at: "2026-11-02T00:00:00Z",
    result: { kind: "MODEL_SELECTION_CLEARED", session_id: "s1", cleared: true } }))));
  expect(await api().clearSessionModelSelection({ sessionId: "s1", commandId: "clear-1" })).toBe(true);
});

it("兼容旧服务的裸选择：缺 connection 按免费开关回推，空 model 视为未选择", async () => {
  let body: unknown = { session_id: "s1", model: "v/a:free", free_only: true, revision: "7" };
  vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify(body))));
  const client = api();
  expect(await client.getSessionModelSelection("s1")).toMatchObject({ connection: "openrouter",
    connectionId: null, model: "v/a:free" });
  body = { model: null, revision: "0" };
  expect(await client.getSessionModelSelection("s1")).toBeNull();
});
