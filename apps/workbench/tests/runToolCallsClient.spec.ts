import { afterEach, expect, it, vi } from "vitest";
import { RelayApiClient } from "../src/api/relayClient";

const client = new RelayApiClient({ baseUrl: "http://127.0.0.1:8787",
  workspaceId: "11111111-1111-4111-8111-111111111111", bearerToken: "test-token" });
const runId = "22222222-2222-4222-8222-222222222222";

afterEach(() => vi.unstubAllGlobals());

function call(overrides: Record<string, unknown> = {}) {
  return { id: "33333333-3333-4333-8333-333333333333", round: 0, ordinal: 0,
    tool_name: "read_file", status: "SETTLED", arguments: { relative_path: "src/工具.ts" },
    arguments_sha256: "a".repeat(64), provider_tool_call_id: "call-0",
    operation_id: "44444444-4444-4444-8444-444444444444", result_ref: { content: "中文" },
    adaptation_of: null, adapted_path: null, created_at: "2026-10-04T01:00:00.000Z",
    updated_at: "2026-10-04T01:00:01.000Z",
    // 服务端把逐文件账本声明为必需数组（domain-schemas 的 RunToolCallSchema），空账本也要如实给。
    file_changes: [], ...overrides };
}

function reply(rounds: readonly unknown[], overrides: Record<string, unknown> = {}) {
  const body = { run_id: runId, run_status: "WAITING_APPROVAL", wait_reason: "HUMAN_TOOL",
    rounds, ...overrides };
  vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify(body), {
    status: 200, headers: { "content-type": "application/json" } })));
}

it("读取工具轨迹并保留服务端给出的轮次顺序", async () => {
  reply([{ round: 1, model_call_id: "55555555-5555-4555-8555-555555555555", calls: [call({ round: 1 })] },
    { round: 0, model_call_id: "66666666-6666-4666-8666-666666666666", calls: [call()] }]);

  const projection = await client.getRunToolCalls(runId);

  expect(projection.runId).toBe(runId);
  expect(projection.runStatus).toBe("WAITING_APPROVAL");
  expect(projection.waitReason).toBe("HUMAN_TOOL");
  // 服务端已按 (round, ordinal) 排好，客户端不重排：重排会掩盖服务端顺序错误。
  expect(projection.rounds.map((round) => round.round)).toEqual([1, 0]);
});

it("参数与结果原样透出，不在客户端加工", async () => {
  reply([{ round: 0, model_call_id: "55555555-5555-4555-8555-555555555555", calls: [call()] }]);

  const projected = (await client.getRunToolCalls(runId)).rounds[0]?.calls[0];

  expect(projected?.args).toEqual({ relative_path: "src/工具.ts" });
  expect(projected?.resultRef).toEqual({ content: "中文" });
  expect(projected?.argsSha256).toBe("a".repeat(64));
});

it("未派发行的 operationId 为 null，与空结果区分开", async () => {
  reply([{ round: 0, model_call_id: "55555555-5555-4555-8555-555555555555",
    calls: [call({ status: "REJECTED", operation_id: null, result_ref: { reason: "R", detail: "D" } })] }]);

  const rejected = (await client.getRunToolCalls(runId)).rounds[0]?.calls[0];

  expect(rejected?.operationId).toBeNull();
  expect(rejected?.resultRef).toEqual({ reason: "R", detail: "D" });
  expect(rejected?.status).toBe("REJECTED");
});

it("没有结果的行保持 null，不把缺结果当成空对象", async () => {
  reply([{ round: 0, model_call_id: "55555555-5555-4555-8555-555555555555",
    calls: [call({ status: "REQUESTED", operation_id: null, result_ref: null })] }]);

  expect((await client.getRunToolCalls(runId)).rounds[0]?.calls[0]?.resultRef).toBeNull();
});

it("没有工具请求的 Run 返回空轮次，不是读取失败", async () => {
  reply([]);
  expect((await client.getRunToolCalls(runId)).rounds).toEqual([]);
});

it.each(["ALMOST_SETTLED", "done", ""])("拒绝封闭词表以外的状态：%s", async (status) => {
  reply([{ round: 0, model_call_id: "55555555-5555-4555-8555-555555555555",
    calls: [call({ status })] }]);
  await expect(client.getRunToolCalls(runId)).rejects.toThrow("工具调用状态无效");
});

it("wait_reason 缺失时保持 null，不猜测原因", async () => {
  reply([], { wait_reason: null });
  expect((await client.getRunToolCalls(runId)).waitReason).toBeNull();
});

it("保留适配来源，让「这次写入是对哪次冲突的再适配」可查", async () => {
  reply([{ round: 1, model_call_id: "55555555-5555-4555-8555-555555555555",
    calls: [call({ round: 1, adaptation_of: "77777777-7777-4777-8777-777777777777",
      adapted_path: "src/工具.ts" })] }]);

  const adapted = (await client.getRunToolCalls(runId)).rounds[0]?.calls[0];

  expect(adapted?.adaptationOf).toBe("77777777-7777-4777-8777-777777777777");
  expect(adapted?.adaptedPath).toBe("src/工具.ts");
});
