import { afterEach, expect, it, vi } from "vitest";
import { RelayApiClient } from "../src/api/relayClient";

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
