import { afterEach, expect, it, vi } from "vitest";
import { RelayApiClient } from "../src/api/relayClient";

const knowledgeId = "11111111-1111-4111-8111-111111111111";
const client = new RelayApiClient({ baseUrl: "http://127.0.0.1:8787",
  workspaceId: "22222222-2222-4222-8222-222222222222",
  bearerToken: "test-bearer-token-0123456789abcdef" });

afterEach(() => vi.unstubAllGlobals());

function respond(overrides: Record<string, unknown> = {}) {
  const body = { knowledge_id: knowledgeId, title: "已保存资料", project_id: null,
    current_version: "2", id: "33333333-3333-4333-8333-333333333333", version: "1",
    source_kind: "NOTE", media_type: "text/plain", content_sha256: "a".repeat(64),
    availability: "AVAILABLE", source_refs: {}, source_uri: null,
    created_at: "2026-09-27T00:00:00.000Z", content_status: "FULL", content: "历史正文",
    ...overrides };
  const fetchMock = vi.fn(async (_input: RequestInfo | URL) => new Response(JSON.stringify(body), {
    status: 200, headers: { "content-type": "application/json" } }));
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

it("reads the requested historical version while retaining the current version separately", async () => {
  const fetchMock = respond();
  const result = await client.getKnowledgeVersionContent(knowledgeId, "1");
  expect(result).toMatchObject({ knowledgeId, version: "1", currentVersion: "2",
    contentStatus: "FULL", content: "历史正文" });
  expect(String(fetchMock.mock.calls[0]?.[0])).toContain(`/knowledge/${knowledgeId}/versions/1/content`);
  expect(fetchMock).toHaveBeenCalledTimes(1);
});

it("rejects a latest-version substitution for a historical request", async () => {
  respond({ version: "2" });
  await expect(client.getKnowledgeVersionContent(knowledgeId, "1")).rejects.toThrow("所选资料版本");
});

it("does not expose a body when the server marks it unavailable", async () => {
  respond({ content_status: "UNAVAILABLE" });
  await expect(client.getKnowledgeVersionContent(knowledgeId, "1")).rejects.toThrow("可读内容不一致");
});

it("accepts an explicit unavailable state without substituting an excerpt", async () => {
  respond({ content_status: "UNAVAILABLE", content: null });
  expect(await client.getKnowledgeVersionContent(knowledgeId, "1")).toMatchObject({
    contentStatus: "UNAVAILABLE", content: null });
});

it("rejects readable content when the source is marked unavailable", async () => {
  respond({ availability: "UNAVAILABLE" });
  await expect(client.getKnowledgeVersionContent(knowledgeId, "1")).rejects.toThrow("来源可用性不一致");
});
