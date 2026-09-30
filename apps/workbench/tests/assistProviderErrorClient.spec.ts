import { afterEach, expect, it, vi } from "vitest";
import { RelayApiClient } from "../src/api/relayClient";

const client = new RelayApiClient({ baseUrl: "http://127.0.0.1:8787",
  workspaceId: "11111111-1111-4111-8111-111111111111", bearerToken: "test-token" });
const sessionId = "22222222-2222-4222-8222-222222222222";

afterEach(() => vi.unstubAllGlobals());

function reply(overrides: Record<string, unknown> = {}) {
  const message = { id: "33333333-3333-4333-8333-333333333333", session_id: sessionId,
    seq: "1", role: "ASSISTANT", status: "FAILED", intent: "DISCUSS", content: null,
    error_code: "MODEL_FAILED", sources: [], usage: { input_tokens: null, output_tokens: null },
    cancel_requested: false, ...overrides };
  vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ items: [message] }), {
    status: 200, headers: { "content-type": "application/json" } })));
}

it.each(["AUTH", "RATE_LIMIT", "TIMEOUT", "STREAM_BROKEN", "PROTOCOL", "NETWORK"])(
  "保留 Provider 类别 %s 与原 Relay 错误码", async (category) => {
    reply({ provider_error_kind: category });
    expect((await client.getAssistMessages(sessionId))[0]).toMatchObject({
      errorCode: "MODEL_FAILED", providerErrorKind: category });
  });

it.each([{}, { provider_error_kind: null }])("旧响应或未知历史不猜测失败类别：%j", async (fields) => {
  reply(fields);
  expect((await client.getAssistMessages(sessionId))[0]?.providerErrorKind).toBeNull();
});

it.each(["OTHER", 401, "secret-provider-body"])("拒绝封闭词表以外的类别：%s", async (category) => {
  reply({ provider_error_kind: category });
  await expect(client.getAssistMessages(sessionId)).rejects.toThrow("Provider 失败类别无效");
});

it.each(["COMPLETED", "CANCELLED", "RUNNING", "PENDING"])("%s 消息不能冒充 Provider 失败", async (status) => {
  reply({ status, provider_error_kind: "TIMEOUT" });
  await expect(client.getAssistMessages(sessionId)).rejects.toThrow("Provider 失败类别无效");
});
