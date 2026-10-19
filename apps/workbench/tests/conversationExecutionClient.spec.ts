import { afterEach, expect, it, vi } from "vitest";
import { RelayApiClient } from "../src/api/relayClient";
import { conversationExecutionSummaryFrom } from "../src/api/parse/assist";

afterEach(() => { vi.unstubAllGlobals(); });

it("从后端执行回执的 result 读出原请求、Task 与 Run", async () => {
  const requestId = "execution-1";
  const stage = { request_id: requestId, status: "DELEGATED", task_id: "task-1",
    run_id: "run-1", revision: "3" };
  const fetch = vi.fn(async (_input: string, _init?: RequestInit) => new Response(JSON.stringify({
    command_id: requestId, committed_at: "2026-10-14T00:00:00Z", result: stage,
    links: { resource: "" },
  }), { status: 200, headers: { "Content-Type": "application/json" } }));
  vi.stubGlobal("fetch", fetch);
  const client = new RelayApiClient({ baseUrl: "http://127.0.0.1:8787",
    workspaceId: "workspace-1", bearerToken: "test-token" });

  await expect(client.applyConversationExecution(requestId)).resolves.toEqual({
    requestId, status: "DELEGATED", taskId: "task-1", runId: "run-1", revision: "3",
  });
  expect(fetch).toHaveBeenCalledTimes(1);
  expect(fetch.mock.calls[0]?.[0]).toBe(
    "http://127.0.0.1:8787/api/v1/workspaces/workspace-1/conversation-execution-requests/execution-1/applications");
});

const baseRequest = { request_id: "execution-1", session_id: "session-1",
  source_message_id: "message-1", decision: "PREPARE", status: "READY",
  candidate_status: "READY", root_path: "D:\\repo", questions: [],
  task_id: null, run_id: null, revision: "2" };

it("候选声明的文件动作被完整读出", () => {
  const parsed = conversationExecutionSummaryFrom({ ...baseRequest,
    candidate: { title: "改文件", objective: "新建与删除",
      file_changes: [{ path: "docs/new.md", action: "CREATE" },
        { path: "src/old.ts", action: "DELETE" }] } });
  expect(parsed.fileChanges).toEqual([{ path: "docs/new.md", action: "CREATE" },
    { path: "src/old.ts", action: "DELETE" }]);
});

it("旧服务端没有 file_changes 时按空数组解析，不影响其余字段", () => {
  const parsed = conversationExecutionSummaryFrom({ ...baseRequest,
    candidate: { title: "改文件", objective: "旧投影" } });
  expect(parsed.fileChanges).toEqual([]);
  expect(parsed.title).toBe("改文件");
  expect(parsed.status).toBe("READY");
});

it("file_changes 形状非法时显式报错，不静默丢路径", () => {
  expect(() => conversationExecutionSummaryFrom({ ...baseRequest,
    candidate: { file_changes: [{ path: "a.txt", action: "MOVE" }] } }))
    .toThrow(/无法识别/u);
  expect(() => conversationExecutionSummaryFrom({ ...baseRequest,
    candidate: { file_changes: "a.txt" } })).toThrow(/响应格式无效/u);
});
