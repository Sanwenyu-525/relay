import { afterEach, describe, expect, it, vi } from "vitest";
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

/** SELECT_ARTIFACT_VERSION 是 Project State 命令：2xx 响应也必须和冻结命令逐项对齐。 */
describe("selectArtifactVersion 响应核对", () => {
  const projectId = "44444444-4444-4444-8444-444444444444";
  const commandId = "55555555-5555-4555-8555-555555555555";
  const artifactVersionId = "66666666-6666-4666-8666-666666666666";

  function selectReply(result: Record<string, unknown>, commandIdOverride?: string) {
    const body = { command_id: commandIdOverride ?? commandId,
      committed_at: "2026-10-26T00:00:00Z", result };
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify(body), {
      status: 200, headers: { "content-type": "application/json" } })));
  }
  const validResult = { project_id: projectId, action: "SELECT_ARTIFACT_VERSION", revision: "4" };
  const call = () => client.selectArtifactVersion({ projectId, commandId,
    expectedRevision: "3", artifactVersionId, sourceRef: `human:workbench:task/${projectId}` });

  it("身份、Project、action 与修订都匹配时返回 State 变更", async () => {
    selectReply(validResult);
    await expect(call()).resolves.toMatchObject({ projectId, action: "SELECT_ARTIFACT_VERSION", revision: "4" });
  });

  it.each([
    ["command_id", validResult, "99999999-9999-4999-8999-999999999999"],
    ["Project", { ...validResult, project_id: "77777777-7777-4777-8777-777777777777" }, undefined],
    ["action", { ...validResult, action: "SET_PHASE" }, undefined],
    ["revision", { ...validResult, revision: "9" }, undefined],
  ])("回执 %s 与冻结命令不一致时拒绝并保留原命令可查", async (_name, result, idOverride) => {
    selectReply(result, idOverride);
    await expect(call()).rejects.toThrow(/无法核对|一致/);
  });
});
