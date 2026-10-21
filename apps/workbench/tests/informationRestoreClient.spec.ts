import { afterEach, expect, it, vi } from "vitest";
import { RelayTransportError } from "../src/api/core/errors";
import { RelayApiClient } from "../src/api/relayClient";

const baseUrl = "http://127.0.0.1:8787";
const workspaceId = "11111111-1111-4111-8111-111111111111";
const knowledgeId = "22222222-2222-4222-8222-222222222222";
const memoryId = "33333333-3333-4333-8333-333333333333";
const ruleId = "44444444-4444-4444-8444-444444444444";
const root = `${baseUrl}/api/v1/workspaces/${workspaceId}`;
const client = new RelayApiClient({ baseUrl, workspaceId, bearerToken: "test-bearer-token-0123456789abcdef" });

afterEach(() => vi.unstubAllGlobals());

function stub(result: Record<string, unknown>, overrides: Record<string, unknown> = {}): ReturnType<typeof vi.fn> {
  const body = { command_id: "command-1", committed_at: "2026-10-19T00:00:00.000Z", result, ...overrides };
  const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => new Response(JSON.stringify(body), {
    status: 200, headers: { "content-type": "application/json" } }));
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

it("三条反向命令各走自己的路径，请求体只带 command_id 与 expected_revision", async () => {
  for (const [invoke, path, key, id] of [
    [() => client.unarchiveKnowledge(knowledgeId, "command-1", "2"), `/knowledge/${knowledgeId}/unarchive`, "knowledge_id", knowledgeId],
    [() => client.reactivateMemory(memoryId, "command-1", "3"), `/memories/${memoryId}/reactivate`, "memory_id", memoryId],
    [() => client.reactivateRule(ruleId, "command-1", "4"), `/rules/${ruleId}/reactivate`, "rule_id", ruleId]
  ] as const) {
    const fetchMock = stub({ [key]: id, revision: "9", status: "ACTIVE" });
    const envelope = await invoke();
    expect(envelope.result).toMatchObject({ [key]: id, revision: "9", status: "ACTIVE" });
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(`${root}${path}`);
    expect(init.method).toBe("POST");
    expect(Object.keys(JSON.parse(String(init.body)) as Record<string, unknown>).sort())
      .toEqual(["command_id", "expected_revision"]);
    expect(JSON.parse(String(init.body))).toMatchObject({ command_id: "command-1" });
  }
});

it("回执指向别的对象时不能当作本次恢复成功", async () => {
  stub({ knowledge_id: memoryId, revision: "3", status: "ACTIVE" });
  await expect(client.unarchiveKnowledge(knowledgeId, "command-1", "2")).rejects.toBeInstanceOf(RelayTransportError);
});

it("回执状态仍不是 ACTIVE 时不能当作恢复成功", async () => {
  stub({ memory_id: memoryId, revision: "3", status: "RETIRED" });
  await expect(client.reactivateMemory(memoryId, "command-1", "2")).rejects.toBeInstanceOf(RelayTransportError);
});

it("回执修订早于本次基线时按结果不明处理，不返回可用的信封", async () => {
  stub({ rule_id: ruleId, revision: "1", status: "ACTIVE" });
  await expect(client.reactivateRule(ruleId, "command-1", "2")).rejects.toThrow("无法核对");
});

it("命令 ID 不一致或回执形状不可读时按结果不明处理", async () => {
  stub({ knowledge_id: knowledgeId, revision: "3", status: "ACTIVE" }, { command_id: "另一个命令" });
  await expect(client.unarchiveKnowledge(knowledgeId, "command-1", "2")).rejects.toBeInstanceOf(RelayTransportError);

  stub({ knowledge_id: knowledgeId, revision: "3" });
  await expect(client.unarchiveKnowledge(knowledgeId, "command-1", "2")).rejects.toBeInstanceOf(RelayTransportError);
});
