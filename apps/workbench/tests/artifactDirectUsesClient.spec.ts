import { afterEach, expect, it, vi } from "vitest";
import { RelayApiClient } from "../src/api/relayClient";

const workspaceId = "11111111-1111-4111-8111-111111111111";
const versionId = "22222222-2222-4222-8222-222222222222";
const childId = "33333333-3333-4333-8333-333333333333";
const client = new RelayApiClient({ baseUrl: "http://127.0.0.1:8787", workspaceId,
  bearerToken: "test-bearer-token-0123456789abcdef" });

afterEach(() => vi.unstubAllGlobals());

function reply(overrides: Record<string, unknown> = {}) {
  const body = { source_artifact_version_id: versionId,
    source_content_availability: "AVAILABLE", scope: "RECORDED_DIRECT_ONLY",
    complete: false, has_more: false, direct_uses: [], ...overrides };
  const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => new Response(JSON.stringify(body), {
    status: 200, headers: { "content-type": "application/json" } }));
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

it("reads a scoped exact-version endpoint without inferring complete impact", async () => {
  const fetchMock = reply({ has_more: true });
  const result = await client.getArtifactDirectUses(versionId);
  expect(result).toMatchObject({ sourceArtifactVersionId: versionId,
    scope: "RECORDED_DIRECT_ONLY", complete: false, hasMore: true, directUses: [] });
  expect(String(fetchMock.mock.calls[0]?.[0])).toBe(
    `http://127.0.0.1:8787/api/v1/workspaces/${workspaceId}/artifact-versions/${versionId}/direct-uses`);
});

it("rejects a response claiming unproven complete analysis", async () => {
  reply({ complete: true });
  await expect(client.getArtifactDirectUses(versionId)).rejects.toThrow("分析范围");
});

it("rejects unavailable content that still exposes child identity", async () => {
  reply({ direct_uses: [{ relation: "DERIVED_FROM", child_artifact_version_id: childId,
    child_artifact_id: childId, child_version_number: "1", availability: "UNAVAILABLE",
    created_at: "2026-09-27T00:00:00.000Z" }] });
  await expect(client.getArtifactDirectUses(versionId)).rejects.toThrow("可用性与版本身份");
});
