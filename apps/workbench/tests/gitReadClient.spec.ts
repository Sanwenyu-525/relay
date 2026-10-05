import { afterEach, expect, it, vi } from "vitest";
import { RelayApiClient, RelayTransportError, managedGitReadOutcomeFrom } from "../src/api/relayClient";

const client = new RelayApiClient({ baseUrl: "http://127.0.0.1:8787",
  workspaceId: "11111111-1111-4111-8111-111111111111", bearerToken: "test-token" });
const input = { projectId: "project-1", resourceId: "resource-1", connectionId: "connection-1",
  commandId: "command-1", actionType: "GIT_STATUS" as const };
const status = { branch: "feature/中文", head_commit: "a".repeat(40), staged: ["src/已暂存.ts"],
  unstaged: ["src/修改.ts"], untracked: ["新文件.md"], limit: 1, truncated: true,
  totals: { staged: 2, unstaged: 1, untracked: 3 } };
const outcome = (overrides: Record<string, unknown> = {}) => ({ state: "SUCCEEDED", action_type: "GIT_STATUS",
  operation_id: "operation-1", invocation_id: "invocation-1", result: status, ...overrides });

afterEach(() => vi.unstubAllGlobals());

function reply(result: unknown, commandId = input.commandId) {
  const fetch = vi.fn(async (_url: string, _init?: RequestInit) => new Response(JSON.stringify({ command_id: commandId,
    committed_at: "2026-10-05T01:00:00Z", result }), { status: 200 }));
  vi.stubGlobal("fetch", fetch); return fetch;
}

it("状态读取只发既有 git-read 命令，保留完整状态、计数与动作身份", async () => {
  const fetch = reply(outcome());
  const response = await client.readManagedGitState({ ...input, limit: 1 });
  expect(fetch.mock.calls[0]?.[0]).toBe("http://127.0.0.1:8787/api/v1/workspaces/11111111-1111-4111-8111-111111111111/projects/project-1/managed-resources/resource-1/git-read");
  const init = fetch.mock.calls[0]?.[1] as RequestInit;
  expect(init.method).toBe("POST");
  expect(JSON.parse(String(init.body))).toEqual({ command_id: "command-1", connection_id: "connection-1",
    action_type: "GIT_STATUS", limit: 1 });
  expect(response.commandId).toBe("command-1");
  expect(response.outcome).toEqual({ state: "SUCCEEDED", actionType: "GIT_STATUS", operationId: "operation-1",
    invocationId: "invocation-1", result: { kind: "STATUS", branch: "feature/中文", headCommit: "a".repeat(40),
      staged: ["src/已暂存.ts"], unstaged: ["src/修改.ts"], untracked: ["新文件.md"], limit: 1,
      truncated: true, totals: { staged: 2, unstaged: 1, untracked: 3 } } });
});

it("diff 载荷含原相对路径、cached 与 limit，省略字节数不丢失", async () => {
  reply(outcome({ action_type: "GIT_DIFF", result: { diff: "+中文\n", limit_bytes: 8,
    truncated: true, returned_bytes: 8, omitted_bytes: 20 } }));
  const fetch = vi.mocked(globalThis.fetch);
  const response = await client.readManagedGitState({ ...input, actionType: "GIT_DIFF",
    relativePath: "src/中文.ts", cached: false, limit: 8 });
  expect(JSON.parse(String(fetch.mock.calls[0]?.[1]?.body))).toEqual({ command_id: "command-1",
    connection_id: "connection-1", action_type: "GIT_DIFF", path: "src/中文.ts", cached: false, limit: 8 });
  expect(response.outcome).toMatchObject({ result: { kind: "DIFF", diff: "+中文\n", omittedBytes: 20,
    returnedBytes: 8, limitBytes: 8, truncated: true } });
});

it.each(["WAITING_APPROVAL", "UNRESOLVED"])("%s 不产生空列表或差异冒充结果", async (state) => {
  reply({ state, action_type: "GIT_STATUS", operation_id: "operation-1", review_id: "review-1", reason: "R" });
  expect((await client.readManagedGitState(input)).outcome).toEqual({ state, actionType: "GIT_STATUS",
    operationId: "operation-1", reviewId: "review-1", reason: "R" });
});

it("非 Git 目录失败保持失败原因，不补三个空列表", async () => {
  reply(outcome({ state: "FAILED", result: { reason: "GIT_REPOSITORY_UNAVAILABLE", detail: "not a repository" } }));
  expect((await client.readManagedGitState(input)).outcome).toMatchObject({ state: "FAILED",
    result: { kind: "FAILURE", reason: "GIT_REPOSITORY_UNAVAILABLE", detail: "not a repository" } });
});

it.each([
  { state: "UNKNOWN" },
  { action_type: "GIT_DIFF" },
  { result: { staged: [], unstaged: [], untracked: [] } },
  { result: { ...status, truncated: undefined } },
  { state: "FAILED", result: status },
  { result: { ...status, totals: { staged: -1, unstaged: 0, untracked: 0 } } }
])("无法核对的响应保留为传输未决：%j", async (overrides) => {
  reply(outcome(overrides));
  await expect(client.readManagedGitState(input)).rejects.toBeInstanceOf(RelayTransportError);
});

it("返回另一 command_id 时不能接受结果", async () => {
  reply(outcome(), "another-command");
  await expect(client.readManagedGitState(input)).rejects.toBeInstanceOf(RelayTransportError);
});

it("回执与首次响应共用解析且校验原动作", () => {
  expect(managedGitReadOutcomeFrom(outcome(), "GIT_STATUS")).toMatchObject({ result: { kind: "STATUS" } });
  expect(() => managedGitReadOutcomeFrom(outcome(), "GIT_DIFF")).toThrow();
});
