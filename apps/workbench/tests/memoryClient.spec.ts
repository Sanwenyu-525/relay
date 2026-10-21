import { afterEach, describe, expect, it, vi } from "vitest";
import { RelayApiError, RelayContractError, RelayTransportError } from "../src/api/core/errors";
import { RelayApiClient } from "../src/api/relayClient";
import { sha256Hex } from "../src/lib/sha256";

/**
 * 长短期记忆 client（HTTP §10.99）。
 *
 * 这里只断言「请求按契约形状发出、回执按原身份核对、畸形响应显式失败」。
 * 服务端是否允许这次整理、这次清除会不会撞在途消息，都不由客户端回答——
 * 那些断言写在集成测试里，前端不重复实现一份业务规则。
 */

const baseUrl = "http://127.0.0.1:8787";
const workspaceId = "11111111-1111-4111-8111-111111111111";
const projectId = "22222222-2222-4222-8222-222222222222";
const sessionId = "33333333-3333-4333-8333-333333333333";
const messageId = "44444444-4444-4444-8444-444444444444";
const memoryId = "55555555-5555-4555-8555-555555555555";
const requestId = "66666666-6666-4666-8666-666666666666";
const root = `${baseUrl}/api/v1/workspaces/${workspaceId}`;
const client = new RelayApiClient({ baseUrl, workspaceId, bearerToken: "test-bearer-token-0123456789abcdef" });
const contentSha256 = "a".repeat(64);

afterEach(() => vi.unstubAllGlobals());

function stub(body: unknown, status = 200): ReturnType<typeof vi.fn> {
  const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) =>
    new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } }));
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

function requestedUrl(fetchMock: ReturnType<typeof vi.fn>, index = 0): string {
  return String((fetchMock.mock.calls[index] as [RequestInfo | URL])[0]);
}

function requestedBody(fetchMock: ReturnType<typeof vi.fn>, index = 0): Record<string, unknown> {
  const init = (fetchMock.mock.calls[index] as [RequestInfo | URL, RequestInit])[1];
  return JSON.parse(String(init.body)) as Record<string, unknown>;
}

function envelope(commandId: string, result: Record<string, unknown>) {
  return { command_id: commandId, committed_at: "2026-10-20T00:00:00.000Z", result };
}

function settingsBody(overrides: Record<string, unknown> = {}) {
  return { workspace_id: workspaceId, revision: "3", recall_enabled: true,
    automatic_compaction: false, auto_capture: true, ...overrides };
}

function sessionMemoryBody(overrides: Record<string, unknown> = {}) {
  return { session_id: sessionId, session_revision: "7", revision: "2", remember: true,
    cleared_through_seq: "0", checkpoint: null, requests: [], ...overrides };
}

function sourceBody(overrides: Record<string, unknown> = {}) {
  return { kind: "MEMORY", root_id: memoryId, version: "2",
    source_ref: `memory:${memoryId}:v2`, status: "AVAILABLE", ...overrides };
}

describe("SHA256（保存来源的正文摘要）", () => {
  it("与标准向量逐字节一致，包含空串、ASCII、中文与跨分组长度", () => {
    expect(sha256Hex("")).toBe("e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
    expect(sha256Hex("abc")).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
    // 中文按 UTF-8 编码后哈希：这条用例挡住「按 UTF-16 或按字节长度错位补位」的实现。
    expect(sha256Hex("你好，世界")).toBe("46932f1e6ea5216e77f58b1908d72ec9322ed129318c6d4bd4450b5eaab9d7e7");
    expect(sha256Hex("a".repeat(200))).toBe("c2a908d98f5df987ade41b5fce213067efbcc21ef2240212a41e54b5e7c28ae5");
  });
});

describe("记忆设置 client", () => {
  it("读设置走 GET /memory-settings，并按服务端返回值解析", async () => {
    const fetchMock = stub(settingsBody());
    await expect(client.getMemorySettings()).resolves.toEqual({ workspaceId, revision: "3",
      recallEnabled: true, automaticCompaction: false, autoCapture: true });
    expect(requestedUrl(fetchMock)).toBe(`${root}/memory-settings`);
    expect((fetchMock.mock.calls[0]![1] as RequestInit | undefined)?.method ?? "GET").toBe("GET");
  });

  it("缺开关字段时显式失败，不按 false 兜底", async () => {
    stub({ workspace_id: workspaceId, revision: "0", recall_enabled: true });
    await expect(client.getMemorySettings()).rejects.toBeInstanceOf(RelayContractError);
  });

  it("保存必须同时提交三个开关与原修订，回执按 command_id 与 Workspace 核对", async () => {
    const commandId = "77777777-7777-4777-8777-777777777777";
    const fetchMock = stub(envelope(commandId, settingsBody({ revision: "4",
      recall_enabled: false, automatic_compaction: true, auto_capture: false })));
    await expect(client.saveMemorySettings({ commandId, expectedRevision: "3",
      recallEnabled: false, automaticCompaction: true, autoCapture: false })).resolves.toMatchObject({ revision: "4",
      recallEnabled: false, automaticCompaction: true, autoCapture: false });
    expect(requestedUrl(fetchMock)).toBe(`${root}/memory-settings`);
    expect(requestedBody(fetchMock)).toEqual({ command_id: commandId, expected_revision: "3",
      recall_enabled: false, automatic_compaction: true, auto_capture: false });
  });

  it("回执修订倒退或换 Workspace 都算无法核对，不当作保存成功", async () => {
    const commandId = "77777777-7777-4777-8777-777777777777";
    stub(envelope(commandId, settingsBody({ revision: "2" })));
    await expect(client.saveMemorySettings({ commandId, expectedRevision: "3",
      recallEnabled: true, automaticCompaction: true, autoCapture: true })).rejects.toBeInstanceOf(RelayTransportError);
    stub(envelope(commandId, settingsBody({ workspace_id: projectId, revision: "4" })));
    await expect(client.saveMemorySettings({ commandId, expectedRevision: "3",
      recallEnabled: true, automaticCompaction: true, autoCapture: true })).rejects.toBeInstanceOf(RelayTransportError);
  });

  it("409 冲突保留服务端给出的两个修订，供界面说明冲突", async () => {
    stub({ code: "REVISION_CONFLICT", detail: "配置已变更。", conflict: {
      expected_revision: "3", actual_revision: "5" } }, 409);
    const caught = await client.saveMemorySettings({ commandId: "77777777-7777-4777-8777-777777777777",
      expectedRevision: "3", recallEnabled: true, automaticCompaction: true,
      autoCapture: true }).catch((error: unknown) => error);
    expect(caught).toBeInstanceOf(RelayApiError);
    expect((caught as RelayApiError).problem).toMatchObject({ status: 409,
      expectedRevision: "3", actualRevision: "5" });
  });
});

describe("从消息保存长期记忆", () => {
  it("路径带会话与消息，正文 hash 是原消息摘要，confirmed 恒为 true", async () => {
    const commandId = "88888888-8888-4888-8888-888888888888";
    const fetchMock = stub(envelope(commandId, { memory_id: memoryId, revision: "0",
      version: "1", status: "ACTIVE" }), 201);
    await expect(client.createMemoryFromMessage({ sessionId, messageId, commandId,
      expectedSessionRevision: "7", contentSha256, projectId, title: "约定",
      text: "需要留存的事实" })).resolves.toEqual({ memoryId, revision: "0", version: "1", status: "ACTIVE" });
    expect(requestedUrl(fetchMock)).toBe(`${root}/assist-sessions/${sessionId}/messages/${messageId}/memories`);
    expect(requestedBody(fetchMock)).toEqual({ command_id: commandId, expected_session_revision: "7",
      content_sha256: contentSha256, project_id: projectId, title: "约定", text: "需要留存的事实",
      confirmed: true });
  });

  it("全局范围提交 null，不是缺字段", async () => {
    const commandId = "88888888-8888-4888-8888-888888888888";
    const fetchMock = stub(envelope(commandId, { memory_id: memoryId, revision: "0",
      version: "1", status: "ACTIVE" }), 201);
    await client.createMemoryFromMessage({ sessionId, messageId, commandId, expectedSessionRevision: "7",
      contentSha256, projectId: null, title: "约定", text: "事实" });
    expect(requestedBody(fetchMock).project_id).toBeNull();
  });

  it("回执不是 CreateMemory 的结果时失败，不把别的命令当作已保存", async () => {
    stub(envelope("88888888-8888-4888-8888-888888888888", { knowledge_id: memoryId }));
    await expect(client.createMemoryFromMessage({ sessionId, messageId,
      commandId: "88888888-8888-4888-8888-888888888888", expectedSessionRevision: "7",
      contentSha256, projectId: null, title: "约定", text: "事实" })).rejects.toBeInstanceOf(RelayTransportError);
  });
});

describe("长期记忆来源", () => {
  it("手工创建返回空来源是合法事实", async () => {
    const fetchMock = stub({ memory_id: memoryId, sources: [] });
    await expect(client.getMemoryProvenance(memoryId)).resolves.toEqual({ memoryId, sources: [] });
    expect(requestedUrl(fetchMock)).toBe(`${root}/memories/${memoryId}/provenance`);
  });

  it("来源身份按十进制版本解析；响应指向另一条记忆时失败", async () => {
    stub({ memory_id: memoryId, sources: [{ memory_version: "2", session_id: sessionId,
      message_id: messageId, content_sha256: contentSha256 }] });
    await expect(client.getMemoryProvenance(memoryId)).resolves.toEqual({ memoryId,
      sources: [{ memoryVersion: "2", sessionId, messageId, contentSha256 }] });
    stub({ memory_id: projectId, sources: [] });
    await expect(client.getMemoryProvenance(memoryId)).rejects.toBeInstanceOf(RelayContractError);
  });
});

describe("会话短期窗口", () => {
  it("没有检查点时 checkpoint 为 null；无摘要与读取失败在界面层分开", async () => {
    stub(sessionMemoryBody());
    await expect(client.getSessionMemory(sessionId)).resolves.toMatchObject({ sessionId,
      sessionRevision: "7", revision: "2", remember: true, checkpoint: null, requests: [] });
  });

  it("失效检查点必须 summary=null 且来源为空；同时给摘要正文算契约错误", async () => {
    stub(sessionMemoryBody({ checkpoint: { id: requestId, available: false, through_seq: "12",
      summary: null, model_call_id: null, created_at: "2026-10-20T00:00:00.000Z",
      source_message_ids: [], sources: [] } }));
    await expect(client.getSessionMemory(sessionId)).resolves.toMatchObject({ checkpoint: {
      available: false, summary: null, sources: [] } });
    stub(sessionMemoryBody({ checkpoint: { id: requestId, available: false, through_seq: "12",
      summary: "旧摘要正文", model_call_id: null, created_at: "2026-10-20T00:00:00.000Z",
      source_message_ids: [], sources: [] } }));
    await expect(client.getSessionMemory(sessionId)).rejects.toBeInstanceOf(RelayContractError);
  });

  it("未知整理状态或另一会话的响应都显式失败", async () => {
    stub(sessionMemoryBody({ requests: [{ id: requestId, reason: "MANUAL", status: "QUEUED",
      cancel_requested: false, error_code: null, checkpoint_id: null, model_call_id: null,
      through_seq: "9", created_at: "2026-10-20T00:00:00.000Z", updated_at: "2026-10-20T00:00:00.000Z" }] }));
    await expect(client.getSessionMemory(sessionId)).rejects.toBeInstanceOf(RelayContractError);
    stub(sessionMemoryBody({ session_id: projectId }));
    await expect(client.getSessionMemory(sessionId)).rejects.toBeInstanceOf(RelayContractError);
  });

  it("来源失效时只返回 status，不补造种类与版本", async () => {
    stub(sessionMemoryBody({ checkpoint: { id: requestId, available: true, through_seq: "12",
      summary: "摘要", model_call_id: null, created_at: "2026-10-20T00:00:00.000Z",
      source_message_ids: [messageId], sources: [sourceBody(), { status: "UNAVAILABLE" }] } }));
    const memory = await client.getSessionMemory(sessionId);
    expect(memory.checkpoint?.sources).toEqual([
      { status: "AVAILABLE", kind: "MEMORY", rootId: memoryId, version: "2",
        sourceRef: `memory:${memoryId}:v2`, selection: null, selectionBasis: null,
        origin: "HUMAN_CONFIRMED" },
      { status: "UNAVAILABLE", kind: null, rootId: null, version: null, sourceRef: null,
        selection: null, selectionBasis: null, origin: null }
    ]);
  });
});

describe("整理与取消", () => {
  it("手动整理提交会话修订，202 只接受 PENDING", async () => {
    const commandId = "99999999-9999-4999-8999-999999999999";
    const fetchMock = stub(envelope(commandId, { session_id: sessionId, request_id: requestId,
      status: "PENDING" }), 202);
    await expect(client.requestSessionMemoryCompaction({ sessionId, commandId,
      expectedRevision: "7" })).resolves.toEqual({ sessionId, requestId, status: "PENDING" });
    expect(requestedUrl(fetchMock)).toBe(`${root}/assist-sessions/${sessionId}/memory/compact`);
    expect(requestedBody(fetchMock)).toEqual({ command_id: commandId, expected_revision: "7" });
  });

  it("受理回执不是 PENDING 或指向别的会话时失败，不显示成已受理", async () => {
    stub(envelope("99999999-9999-4999-8999-999999999999", { session_id: sessionId,
      request_id: requestId, status: "RUNNING" }), 202);
    await expect(client.requestSessionMemoryCompaction({ sessionId,
      commandId: "99999999-9999-4999-8999-999999999999", expectedRevision: "7" }))
      .rejects.toBeInstanceOf(RelayTransportError);
    stub(envelope("99999999-9999-4999-8999-999999999999", { session_id: projectId,
      request_id: requestId, status: "PENDING" }), 202);
    await expect(client.requestSessionMemoryCompaction({ sessionId,
      commandId: "99999999-9999-4999-8999-999999999999", expectedRevision: "7" }))
      .rejects.toBeInstanceOf(RelayTransportError);
  });

  it("RUNNING 的取消只返回取消意图，status 仍是 RUNNING", async () => {
    const commandId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    const fetchMock = stub(envelope(commandId, { session_id: sessionId, request_id: requestId,
      status: "RUNNING", cancel_requested: true }));
    await expect(client.cancelMemoryCompaction({ sessionId, requestId, commandId }))
      .resolves.toEqual({ sessionId, requestId, status: "RUNNING", cancelRequested: true });
    expect(requestedUrl(fetchMock)).toBe(
      `${root}/assist-sessions/${sessionId}/memory/requests/${requestId}/cancel`);
  });
});

describe("清除与一次性模式", () => {
  it("清除同时提交窗口修订与会话修订", async () => {
    const commandId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
    const fetchMock = stub(envelope(commandId, { session_id: sessionId, revision: "3",
      session_revision: "7", remember: true, cleared_through_seq: "18" }));
    await expect(client.clearSessionMemory({ sessionId, commandId, expectedRevision: "2",
      expectedSessionRevision: "7" })).resolves.toEqual({ sessionId, revision: "3",
      sessionRevision: "7", remember: true, clearedThroughSeq: "18" });
    expect(requestedUrl(fetchMock)).toBe(`${root}/assist-sessions/${sessionId}/memory/clear`);
    expect(requestedBody(fetchMock)).toEqual({ command_id: commandId, expected_revision: "2",
      expected_session_revision: "7" });
  });

  it("一次性开关走 remember 路径；回执的 remember 与请求不一致时失败", async () => {
    const commandId = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
    const fetchMock = stub(envelope(commandId, { session_id: sessionId, revision: "4",
      session_revision: "8", remember: false, cleared_through_seq: "18" }));
    await expect(client.setSessionMemoryRemember({ sessionId, commandId, expectedRevision: "3",
      expectedSessionRevision: "7", remember: false })).resolves.toMatchObject({ remember: false,
      revision: "4", sessionRevision: "8" });
    expect(requestedUrl(fetchMock)).toBe(`${root}/assist-sessions/${sessionId}/memory/remember`);
    expect(requestedBody(fetchMock).remember).toBe(false);
    stub(envelope(commandId, { session_id: sessionId, revision: "4", session_revision: "8",
      remember: true, cleared_through_seq: "18" }));
    await expect(client.setSessionMemoryRemember({ sessionId, commandId, expectedRevision: "3",
      expectedSessionRevision: "7", remember: false })).rejects.toBeInstanceOf(RelayTransportError);
  });
});

describe("消息记忆足迹", () => {
  it("recorded=false 与 available=false 分别保留，不当成「没有使用记忆」", async () => {
    stub({ session_id: sessionId, message_id: messageId, recorded: false, available: false,
      checkpoint_id: null, sources: [] });
    await expect(client.getMessageMemoryUse(sessionId, messageId)).resolves.toEqual({ sessionId,
      messageId, recorded: false, available: false, checkpointId: null, sources: [] });
  });

  it("响应指向另一条消息时失败", async () => {
    stub({ session_id: sessionId, message_id: projectId, recorded: true, available: true,
      checkpoint_id: null, sources: [] });
    await expect(client.getMessageMemoryUse(sessionId, messageId)).rejects.toBeInstanceOf(RelayContractError);
  });
});

describe("聊天命令 /compact", () => {
  it("走 chat-commands 并接受带 kind 标签的 202 受理回执", async () => {
    const commandId = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
    const fetchMock = stub(envelope(commandId, { kind: "MEMORY_COMPACTION", system: "compact",
      session_id: sessionId, request_id: requestId, status: "PENDING" }), 202);
    await expect(client.compactAssistSession({ sessionId, commandId, text: "/compact" }))
      .resolves.toEqual({ sessionId, requestId, status: "PENDING" });
    expect(requestedUrl(fetchMock)).toBe(`${root}/assist-sessions/${sessionId}/chat-commands`);
    expect(requestedBody(fetchMock)).toEqual({ command_id: commandId, text: "/compact" });
  });

  it("底层 RequestMemoryCompaction 的原始结果也能核对，不要求前端包装 kind", async () => {
    stub(envelope("dddddddd-dddd-4ddd-8ddd-dddddddddddd", { session_id: sessionId,
      request_id: requestId, status: "PENDING" }), 202);
    await expect(client.compactAssistSession({ sessionId,
      commandId: "dddddddd-dddd-4ddd-8ddd-dddddddddddd", text: "/压缩" }))
      .resolves.toEqual({ sessionId, requestId, status: "PENDING" });
  });

  it("kind 明确不是记忆整理时失败", async () => {
    stub(envelope("dddddddd-dddd-4ddd-8ddd-dddddddddddd", { kind: "NEW_SESSION",
      system: "clear", session_id: sessionId, request_id: requestId, status: "PENDING" }), 202);
    await expect(client.compactAssistSession({ sessionId,
      commandId: "dddddddd-dddd-4ddd-8ddd-dddddddddddd", text: "/compact" }))
      .rejects.toBeInstanceOf(RelayTransportError);
  });
});
