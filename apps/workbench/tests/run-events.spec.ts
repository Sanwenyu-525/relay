import { act } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { RelayApiClient, RelayRunEventHttpError } from "../src/api/relayClient";
import { readRunEventHints } from "../src/api/runEvents";
import { activateRelayConnection, resetRelayConnectionForTest } from "../src/lib/relayConnection";
import { flush, mountWorkbench } from "./mountApp";

const baseUrl = "http://127.0.0.1:8787";
const workspaceId = "11111111-1111-4111-8111-111111111111";
const taskId = "22222222-2222-4222-8222-222222222222";
const runId = "33333333-3333-4333-8333-333333333333";
const prefix = `${baseUrl}/api/v1/workspaces/${workspaceId}`;
const runUrl = `${prefix}/runs/${runId}`;
const eventsUrl = `${runUrl}/events`;
const encode = (value: string) => new TextEncoder().encode(value);
let unmount: (() => void) | null = null;

afterEach(() => {
  unmount?.();
  unmount = null;
  resetRelayConnectionForTest();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function bytesStream(chunks: readonly Uint8Array[]): ReadableStream<Uint8Array> {
  return new ReadableStream({ start(controller) { chunks.forEach((chunk) => controller.enqueue(chunk)); controller.close(); } });
}

function sseResponse(body: ReadableStream<Uint8Array>): Response {
  return { ok: true, status: 200, headers: { get: () => "text/event-stream; charset=utf-8" }, body } as unknown as Response;
}

function jsonResponse(body: unknown): Response {
  return { ok: true, status: 200, json: async () => body } as Response;
}

function task() {
  return {
    id: taskId, project_id: null, title: "事件订阅任务", status: "IN_PROGRESS", mode: "DELEGATE_AI",
    revision: "4", executor: { kind: "AI", run_id: runId, ownership_epoch: "1" },
    current_completion_id: null, waiting_reason: null, blocking_task_ids: [], unresolved_blocker_ids: [], allowed_actions: [],
    acceptance: { acceptance_revision: "1", objective: "交付可核对结果", source: "CREATE", criteria: [] }, dependencies: []
  };
}

function run(revision: string) {
  return {
    id: runId, task_id: taskId, status: "RUNNING", revision, ownership_epoch: "1", retry_of_run_id: null,
    current_step_id: null, wait_reason: null, created_at: "2026-09-24T00:00:00.000Z",
    updated_at: "2026-09-24T00:01:00.000Z", terminal_at: null,
    contract: { workflow_key: "markdown-deliverable-v1", workflow_version: "1", execution_config_version: "1", acceptance_revision: "1", contract_hash: "a".repeat(64) },
    current_step: null, steps: [], recent_attempts: [], result_refs: [], blocking_review_ids: [],
    pending_control_request: null, unresolved_operation_ids: []
  };
}

describe("Run SSE 仅作重新读取提示", () => {
  it("Bearer fetch 使用 after 游标，分片 UTF-8/CRLF 正确去重且大输出不进入业务状态", async () => {
    const client = new RelayApiClient({ baseUrl, workspaceId, bearerToken: "private-test-token" });
    const first = "9007199254740993";
    const second = "9007199254740994";
    const content = `: heartbeat\r\nid: ${first}\r\ndata: {"title":"中文"}\r\n\r\nid: ${first}\r\ndata: {"duplicate":true}\r\n\r\nid: ${second}\r\ndata: {"output":"${"x".repeat(300_000)}"}\r\n\r\n`;
    const bytes = encode(content);
    const chinese = encode("中");
    const split = bytes.findIndex((byte, index) => byte === chinese[0] && bytes[index + 1] === chinese[1]);
    expect(split).toBeGreaterThan(0);
    const fetchStub = vi.fn(async () => sseResponse(bytesStream([bytes.slice(0, split + 1), bytes.slice(split + 1)])));
    vi.stubGlobal("fetch", fetchStub);
    const seen: string[] = [];
    let opened = 0;
    await client.readRunEvents(runId, "9007199254740992", new AbortController().signal, (seq) => seen.push(seq), () => { opened++; });
    expect(seen).toEqual([first, second]);
    expect(opened).toBe(1);
    const [url, init] = fetchStub.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(`${eventsUrl}?after=9007199254740992`);
    expect(url).not.toContain("private-test-token");
    expect(init.headers).toMatchObject({ Accept: "text/event-stream", Authorization: "Bearer private-test-token" });
  });

  it("缺号和截断帧不推进游标；401 不暴露响应正文", async () => {
    const signal = new AbortController().signal;
    const seen: string[] = [];
    await expect(readRunEventHints(bytesStream([encode('id: 3\ndata: {"changed":true}\n\n')]), "1", signal, (seq) => seen.push(seq)))
      .rejects.toThrow("序号不连续");
    await expect(readRunEventHints(bytesStream([encode('id: 2\ndata: {"title":"中文"}')]), "1", signal, (seq) => seen.push(seq)))
      .rejects.toThrow("帧尚未完整");
    await expect(readRunEventHints(bytesStream([encode(`id: ${"9".repeat(65_535)}\ndata: {}\n\n`)]), "1", signal, (seq) => seen.push(seq)))
      .rejects.toThrow("行超出限制");
    await expect(readRunEventHints(bytesStream([encode('id: 9223372036854775808\ndata: {}\n\n')]), "1", signal, (seq) => seen.push(seq)))
      .rejects.toThrow("有效序号");
    await expect(readRunEventHints(bytesStream([]), "9223372036854775808", signal, (seq) => seen.push(seq)))
      .rejects.toThrow("游标无效");
    expect(seen).toEqual([]);
    const client = new RelayApiClient({ baseUrl, workspaceId, bearerToken: "private-test-token" });
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: false, status: 401, text: async () => "secret should not be read" }) as Response));
    await expect(client.readRunEvents(runId, "0", signal, () => undefined, () => undefined))
      .rejects.toBeInstanceOf(RelayRunEventHttpError);
  });

  it("断线以已消费 seq 补历史，重复事件不刷新；页面卸载只 Abort", async () => {
    activateRelayConnection({ baseUrl, workspaceId, bearerToken: "private-test-token" });
    let revision = "3";
    let runReads = 0;
    let taskReads = 0;
    let reviewReads = 0;
    let sourceReads = 0;
    const subscriptions: { after: string; signal: AbortSignal; controller: ReadableStreamDefaultController<Uint8Array> }[] = [];
    vi.stubGlobal("fetch", vi.fn(async (input: string, init?: RequestInit) => {
      const url = String(input);
      if (url.startsWith(`${eventsUrl}?after=`)) {
        const stream = new ReadableStream<Uint8Array>({ start(controller) {
          subscriptions.push({ after: new URL(url).searchParams.get("after") ?? "", signal: init?.signal as AbortSignal, controller });
        } });
        return sseResponse(stream);
      }
      if (url === runUrl) { runReads++; return jsonResponse(run(revision)); }
      if (url === `${prefix}/tasks/${taskId}`) { taskReads++; return jsonResponse(task()); }
      if (url === `${runUrl}/reviews`) { reviewReads++; return jsonResponse({ items: [] }); }
      if (url === `${runUrl}/context-manifests`) { sourceReads++; return jsonResponse({ items: [], build: { status: "NOT_STARTED", reason_code: null, message: null } }); }
      throw new Error(`unexpected request ${url}`);
    }));
    const mounted = await mountWorkbench(`/runs/${runId}`);
    unmount = mounted.unmount;
    expect(subscriptions.map((item) => item.after)).toEqual(["0"]);
    revision = "4";
    await act(async () => { subscriptions[0].controller.enqueue(encode('id: 1\ndata: {"changed":true}\n\n')); });
    await flush(260);
    expect(mounted.wrapper.get('[data-testid="run-detail"]').text()).toContain("Run 修订 v4");
    const afterFirst = runReads;
    await act(async () => {
      subscriptions[0].controller.enqueue(encode('id: 2\ndata: {"partial":'));
      subscriptions[0].controller.close();
    });
    await flush(1_100);
    expect(subscriptions.map((item) => item.after)).toEqual(["0", "1"]);
    const afterDisconnect = runReads;
    expect(afterDisconnect).toBeGreaterThanOrEqual(afterFirst);
    await act(async () => { subscriptions[1].controller.enqueue(encode('id: 1\ndata: {"duplicate":true}\n\n')); });
    await flush(30);
    expect(runReads).toBe(afterDisconnect);
    revision = "5";
    await act(async () => { subscriptions[1].controller.enqueue(encode(`id: 2\ndata: {"large_output":"${"x".repeat(300_000)}"}\n\n`)); });
    await flush(260);
    expect(mounted.wrapper.get('[data-testid="run-detail"]').text()).toContain("Run 修订 v5");
    expect(taskReads).toBeGreaterThan(1);
    expect(reviewReads).toBeGreaterThan(1);
    const beforeBurst = runReads;
    const beforeSources = sourceReads;
    revision = "6";
    for (let seq = 3; seq <= 12; seq++) {
      await act(async () => { subscriptions[1].controller.enqueue(encode(`id: ${seq}\ndata: {"changed":true}\n\n`)); });
      await flush(10);
    }
    await flush(260);
    expect(mounted.wrapper.get('[data-testid="run-detail"]').text()).toContain("Run 修订 v6");
    expect(runReads - beforeBurst).toBeLessThanOrEqual(2);
    expect(sourceReads).toBe(beforeSources);
    mounted.unmount(); unmount = null;
    expect(subscriptions[1].signal.aborted).toBe(true);
    expect((fetch as ReturnType<typeof vi.fn>).mock.calls.some(([, init]) => init?.method === "POST")).toBe(false);
  });

  it("订阅鉴权失效显示错误并停止用旧 Bearer 重连", async () => {
    activateRelayConnection({ baseUrl, workspaceId, bearerToken: "private-test-token" });
    let eventRequests = 0;
    vi.stubGlobal("fetch", vi.fn(async (input: string) => {
      const url = String(input);
      if (url.startsWith(`${eventsUrl}?after=`)) { eventRequests++; return { ok: false, status: 401 } as Response; }
      if (url === runUrl) return jsonResponse(run("3"));
      if (url === `${prefix}/tasks/${taskId}`) return jsonResponse(task());
      if (url === `${runUrl}/reviews`) return jsonResponse({ items: [] });
      if (url === `${runUrl}/context-manifests`) return jsonResponse({ items: [], build: { status: "NOT_STARTED", reason_code: null, message: null } });
      throw new Error(`unexpected request ${url}`);
    }));
    const mounted = await mountWorkbench(`/runs/${runId}`);
    unmount = mounted.unmount;
    expect(mounted.wrapper.get('[data-testid="run-events-status"]').text()).toContain("无权访问");
    await flush(1_100);
    expect(eventRequests).toBe(1);
  });

  it("安静的事件流也按周期重读权威 Run/Task/Reviews", async () => {
    activateRelayConnection({ baseUrl, workspaceId, bearerToken: "private-test-token" });
    let revision = "3";
    let periodic: (() => void) | null = null;
    const nativeSetInterval = window.setInterval.bind(window);
    vi.spyOn(window, "setInterval").mockImplementation((handler, timeout, ...args) => {
      if (timeout === 15_000) { periodic = handler as () => void; return 987654 as unknown as ReturnType<typeof setInterval>; }
      return nativeSetInterval(handler, timeout, ...args) as unknown as ReturnType<typeof setInterval>;
    });
    let taskReads = 0;
    let reviewReads = 0;
    vi.stubGlobal("fetch", vi.fn(async (input: string) => {
      const url = String(input);
      if (url.startsWith(`${eventsUrl}?after=`)) return sseResponse(new ReadableStream<Uint8Array>());
      if (url === runUrl) return jsonResponse(run(revision));
      if (url === `${prefix}/tasks/${taskId}`) { taskReads++; return jsonResponse(task()); }
      if (url === `${runUrl}/reviews`) { reviewReads++; return jsonResponse({ items: [] }); }
      if (url === `${runUrl}/context-manifests`) return jsonResponse({ items: [], build: { status: "NOT_STARTED", reason_code: null, message: null } });
      throw new Error(`unexpected request ${url}`);
    }));
    const mounted = await mountWorkbench(`/runs/${runId}`);
    unmount = mounted.unmount;
    expect(periodic).not.toBeNull();
    revision = "4";
    await act(async () => { periodic?.(); });
    await flush(260);
    expect(mounted.wrapper.get('[data-testid="run-detail"]').text()).toContain("Run 修订 v4");
    expect(taskReads).toBeGreaterThan(1);
    expect(reviewReads).toBeGreaterThan(1);
  });
});
