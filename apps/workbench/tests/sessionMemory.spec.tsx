import { afterEach, describe, expect, it, vi } from "vitest";
import { RelayApiClient } from "../src/api/relayClient";
import SessionMemoryPanel from "../src/components/SessionMemoryPanel";
import { flush, mountReact } from "./mountApp";

/**
 * 会话短期记忆面板（工作台 §40 / HTTP §10.99）。
 *
 * 这里只验界面能分辨的事实：无摘要 / 有效 / 失效 / 读取失败四态、整理状态推进与轮询停止、
 * 取消意图与终态分离、清除与一次性开关提交的是两种修订。业务准入由服务端裁决，
 * 面板不预演一遍（在途拒绝用真实 409 文案验证）。
 */

const baseUrl = "http://127.0.0.1:8787";
const workspaceId = "11111111-1111-4111-8111-111111111111";
const sessionId = "33333333-3333-4333-8333-333333333333";
const messageId = "44444444-4444-4444-8444-444444444444";
const requestId = "66666666-6666-4666-8666-666666666666";
const root = `${baseUrl}/api/v1/workspaces/${workspaceId}`;
const client = new RelayApiClient({ baseUrl, workspaceId, bearerToken: "test-bearer-token-0123456789abcdef" });
let unmount: (() => void) | null = null;

afterEach(() => { unmount?.(); unmount = null; vi.unstubAllGlobals(); });

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function request(overrides: Record<string, unknown> = {}) {
  return { id: requestId, reason: "MANUAL", status: "PENDING", cancel_requested: false,
    error_code: null, checkpoint_id: null, model_call_id: null, through_seq: "12",
    created_at: "2026-10-20T00:00:00.000Z", updated_at: "2026-10-20T00:00:00.000Z", ...overrides };
}

function memory(overrides: Record<string, unknown> = {}) {
  return { session_id: sessionId, session_revision: "7", revision: "2", remember: true,
    cleared_through_seq: "0", checkpoint: null, requests: [], ...overrides };
}

type Handler = (url: string, init: RequestInit) => Response | Promise<Response>;

function stubSequence(handlers: readonly Handler[]) {
  let index = 0;
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const handler = handlers[Math.min(index, handlers.length - 1)]!;
    index += 1;
    return handler(String(input), init ?? {});
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

async function mount(options: { inflight?: boolean } = {}) {
  const mounted = await mountReact(<SessionMemoryPanel client={client} sessionId={sessionId}
    sessionRevision="7" inflight={options.inflight ?? false} writeBlocked={false}
    writeBlockedReason={null} pollIntervalMs={10} />);
  unmount = mounted.unmount;
  await flush();
  return mounted.wrapper;
}

describe("窗口四态", () => {
  it("没有检查点显示「无摘要」，不显示任何摘要正文", async () => {
    stubSequence([() => json(memory())]);
    const wrapper = await mount();
    expect(wrapper.get('[data-testid="session-memory-summary"]').text()).toContain("无摘要");
    expect(wrapper.get('[data-testid="session-memory-no-summary"]').exists()).toBe(true);
    expect(wrapper.find('[data-testid="session-memory-summary-text"]').exists()).toBe(false);
  });

  it("有效摘要显示正文与覆盖边界，并说明它不是已确认事实", async () => {
    stubSequence([() => json(memory({ checkpoint: { id: requestId, available: true, through_seq: "12",
      summary: "用户确认过采用 PostgreSQL。", model_call_id: null,
      created_at: "2026-10-20T00:00:00.000Z", source_message_ids: [messageId],
      sources: [{ kind: "MEMORY", root_id: messageId, version: "2",
        source_ref: `memory:${messageId}:v2`, status: "AVAILABLE" }] } }))]);
    const wrapper = await mount();
    expect(wrapper.get('[data-testid="session-memory-summary"]').text()).toContain("有摘要");
    expect(wrapper.get('[data-testid="session-memory-summary-text"]').text()).toContain("PostgreSQL");
    expect(wrapper.get('[data-testid="session-memory-checkpoint"]').text()).toContain("第 12 条");
    expect(wrapper.get('[data-testid="session-memory-checkpoint"]').text()).toContain("不是已确认事实");
  });

  it("失效摘要不显示旧正文，并说明不会被使用", async () => {
    stubSequence([() => json(memory({ checkpoint: { id: requestId, available: false, through_seq: "12",
      summary: null, model_call_id: null, created_at: "2026-10-20T00:00:00.000Z",
      source_message_ids: [], sources: [] } }))]);
    const wrapper = await mount();
    expect(wrapper.get('[data-testid="session-memory-summary"]').text()).toContain("摘要已失效");
    expect(wrapper.get('[data-testid="session-memory-unavailable"]').text()).toContain("回显旧正文");
    expect(wrapper.find('[data-testid="session-memory-summary-text"]').exists()).toBe(false);
  });

  it("读取失败与「没有摘要」分开：显示失败原因与重读入口", async () => {
    stubSequence([() => json({ code: "DATABASE_UNAVAILABLE", detail: "库不可用" }, 503)]);
    const wrapper = await mount();
    expect(wrapper.get('[data-testid="session-memory-read-error"]').text()).toContain("读取失败");
    expect(wrapper.get('[data-testid="session-memory-summary"]').text()).toContain("读取失败");
    expect(wrapper.find('[data-testid="session-memory-no-summary"]').exists()).toBe(false);
    expect(wrapper.find('[data-testid="session-memory-compact"]').exists()).toBe(false);
  });

  it("一次性模式显示为独立状态，并说明不沿用旧摘要", async () => {
    stubSequence([() => json(memory({ remember: false, checkpoint: null }))]);
    const wrapper = await mount();
    expect(wrapper.get('[data-testid="session-memory-summary"]').text()).toContain("一次性模式");
    expect(wrapper.get('[data-testid="session-memory-one-shot"]').text()).toContain("重新开启后从新边界开始");
  });
});

describe("整理状态", () => {
  it("202 受理后按 request_id 轮询，进入终态即停止", async () => {
    const commandId = "99999999-9999-4999-8999-999999999999";
    const fetchMock = stubSequence([
      () => json(memory()),
      (_url, init) => {
        const body = JSON.parse(String(init.body)) as Record<string, unknown>;
        expect(body).toMatchObject({ expected_revision: "7" });
        return json({ command_id: body.command_id, committed_at: "2026-10-20T00:00:00.000Z",
          result: { session_id: sessionId, request_id: requestId, status: "PENDING" } }, 202);
      },
      () => json(memory({ requests: [request({ status: "PENDING" })] })),
      () => json(memory({ requests: [request({ status: "RUNNING" })] })),
      () => json(memory({ revision: "3", requests: [request({ status: "COMPLETED",
        checkpoint_id: requestId })] })),
    ]);
    const wrapper = await mount();
    await wrapper.get('[data-testid="session-memory-compact"]').trigger("click");
    await flush(120);
    const callsAfterTerminal = fetchMock.mock.calls.length;
    expect(wrapper.get('[data-testid="session-memory-notice"]').text()).toContain("已受理整理请求");
    const requests = wrapper.get('[data-testid="session-memory-requests"]').text();
    expect(requests).toContain("已完成");
    // 终态之后不再继续轮询。
    await flush(120);
    expect(fetchMock.mock.calls.length).toBe(callsAfterTerminal);
    expect(commandId.length).toBe(36);
  });

  it("RUNNING 的取消只显示「取消中」，不立刻说已取消", async () => {
    /* 这条用例按路由而不是按调用顺序打桩：面板会轮询，按顺序的队列会被一次 GET 抢走位置。
       取消后 GET 返回 cancel_requested=true 且 status 仍是 RUNNING——这正是服务端的语义。 */
    let cancelRequested = false;
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if ((init?.method ?? "GET") === "POST" && url.includes("/cancel")) {
        cancelRequested = true;
        // 回执必须带本次命令的真实 command_id：客户端按原身份核对，硬编码会变成「无法核对」。
        const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
        return json({ command_id: body.command_id,
          committed_at: "2026-10-20T00:00:00.000Z",
          result: { session_id: sessionId, request_id: requestId, status: "RUNNING",
            cancel_requested: true } });
      }
      return json(memory({ requests: [request({ status: "RUNNING", cancel_requested: cancelRequested })] }));
    });
    vi.stubGlobal("fetch", fetchMock);
    const mounted = await mountReact(<SessionMemoryPanel client={client} sessionId={sessionId}
      sessionRevision="7" inflight={false} writeBlocked={false} writeBlockedReason={null}
      pollIntervalMs={60_000} />);
    unmount = mounted.unmount;
    await flush();
    await mounted.wrapper.get(`[data-testid="session-memory-cancel-${requestId}"]`).trigger("click");
    await flush(60);
    expect(mounted.wrapper.get('[data-testid="session-memory-notice"]').text()).toContain("仍在运行");
    expect(mounted.wrapper.get('[data-testid="session-memory-requests"]').text()).toContain("取消中（等待安全结束）");
    expect(mounted.wrapper.find(`[data-testid="session-memory-cancel-${requestId}"]`).exists()).toBe(false);
  });

  it("整理失败的 typed error 给可读原因，并保留原文", async () => {
    stubSequence([() => json(memory({ requests: [request({ status: "FAILED",
      error_code: "MEMORY_SOURCE_CHANGED" })] }))]);
    const wrapper = await mount();
    const text = wrapper.get('[data-testid="session-memory-requests"]').text();
    expect(text).toContain("来源、权限或范围在整理期间变化");
    expect(text).toContain("旧摘要保留");
  });

  it("整理请求响应丢失时保留原 command_id，重试不换新 ID", async () => {
    const posts: Record<string, unknown>[] = [];
    let failNext = true;
    vi.stubGlobal("fetch", vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      if ((init?.method ?? "GET") === "POST") {
        const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
        posts.push(body);
        if (failNext) throw new TypeError("Failed to fetch");
        return json({ command_id: body.command_id, committed_at: "2026-10-20T00:00:00.000Z",
          result: { session_id: sessionId, request_id: requestId, status: "PENDING" } }, 202);
      }
      return json(memory());
    }));
    const mounted = await mountReact(<SessionMemoryPanel client={client} sessionId={sessionId}
      sessionRevision="7" inflight={false} writeBlocked={false} writeBlockedReason={null}
      pollIntervalMs={60_000} />);
    unmount = mounted.unmount;
    await flush();
    await mounted.wrapper.get('[data-testid="session-memory-compact"]').trigger("click");
    await flush(60);
    const unresolved = mounted.wrapper.get('[data-testid="session-memory-unresolved"]').text();
    expect(unresolved).toContain("结果未核对");
    expect(unresolved).toContain(String(posts[0]!.command_id));
    failNext = false;
    await mounted.wrapper.get('[data-testid="session-memory-retry"]').trigger("click");
    await flush(60);
    expect(posts).toHaveLength(2);
    expect(posts[1]!.command_id).toBe(posts[0]!.command_id);
    expect(mounted.wrapper.find('[data-testid="session-memory-unresolved"]').exists()).toBe(false);
  });

  it("查回执类型不是本次控制时明确拒绝", async () => {
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if ((init?.method ?? "GET") === "POST") throw new TypeError("Failed to fetch");
      if (url.includes("/command-receipts/") || /\/commands\/[^/]+$/u.test(url)) {
        return json({ command_id: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
          committed_at: "2026-10-20T00:00:00.000Z", command_type: "CreateMemory",
          result: { memory_id: messageId } });
      }
      return json(memory());
    }));
    const mounted = await mountReact(<SessionMemoryPanel client={client} sessionId={sessionId}
      sessionRevision="7" inflight={false} writeBlocked={false} writeBlockedReason={null}
      pollIntervalMs={60_000} />);
    unmount = mounted.unmount;
    await flush();
    await mounted.wrapper.get('[data-testid="session-memory-clear"]').trigger("click");
    await mounted.wrapper.get('[data-testid="session-memory-clear-confirm-button"]').trigger("click");
    await flush(60);
    await mounted.wrapper.get('[data-testid="session-memory-receipt"]').trigger("click");
    await flush(60);
    expect(mounted.wrapper.get('[data-testid="session-memory-error"]').text()).toContain("不是清除工作记忆");
  });
});

describe("清除与一次性开关", () => {
  it("清除要先确认，提交窗口修订与会话修订，并说明不删除历史", async () => {
    const fetchMock = stubSequence([
      () => json(memory()),
      (_url, init) => {
        const body = JSON.parse(String(init.body)) as Record<string, unknown>;
        expect(body).toMatchObject({ expected_revision: "2", expected_session_revision: "7" });
        return json({ command_id: body.command_id, committed_at: "2026-10-20T00:00:00.000Z",
          result: { session_id: sessionId, revision: "3", session_revision: "7",
            remember: true, cleared_through_seq: "18" } });
      },
      () => json(memory({ revision: "3", cleared_through_seq: "18" }))
    ]);
    const wrapper = await mount();
    expect(wrapper.find('[data-testid="session-memory-clear-confirm"]').exists()).toBe(false);
    await wrapper.get('[data-testid="session-memory-clear"]').trigger("click");
    expect(wrapper.get('[data-testid="session-memory-clear-confirm"]').text()).toContain("聊天记录、工具历史与长期记忆都保留");
    await wrapper.get('[data-testid="session-memory-clear-confirm-button"]').trigger("click");
    await flush();
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(wrapper.get('[data-testid="session-memory-notice"]').text()).toContain("已清除工作窗口");
  });

  it("有在途消息时提示会被拒绝，但仍由服务端裁决并如实显示", async () => {
    stubSequence([
      () => json(memory()),
      () => json({ code: "INVALID_TRANSITION", detail: "存在在途消息或记忆整理；先取消或等待安全结束，再清除工作窗口。" }, 409)
    ]);
    const mounted = await mountReact(<SessionMemoryPanel client={client} sessionId={sessionId}
      sessionRevision="7" inflight writeBlocked={false} writeBlockedReason={null} pollIntervalMs={10} />);
    unmount = mounted.unmount;
    await flush();
    await mounted.wrapper.get('[data-testid="session-memory-clear"]').trigger("click");
    expect(mounted.wrapper.get('[data-testid="session-memory-clear-inflight"]').text()).toContain("服务端会拒绝");
    await mounted.wrapper.get('[data-testid="session-memory-clear-confirm-button"]').trigger("click");
    await flush();
    expect(mounted.wrapper.get('[data-testid="session-memory-error"]').text()).toContain("在途消息");
  });

  it("切换一次性模式提交 remember=false，并通知上层重读会话修订", async () => {
    const onSessionRevisionChanged = vi.fn();
    stubSequence([
      () => json(memory()),
      (_url, init) => {
        const body = JSON.parse(String(init.body)) as Record<string, unknown>;
        expect(body).toMatchObject({ remember: false, expected_revision: "2", expected_session_revision: "7" });
        return json({ command_id: body.command_id, committed_at: "2026-10-20T00:00:00.000Z",
          result: { session_id: sessionId, revision: "3", session_revision: "8",
            remember: false, cleared_through_seq: "18" } });
      },
      () => json(memory({ remember: false, revision: "3", session_revision: "8", cleared_through_seq: "18" }))
    ]);
    const mounted = await mountReact(<SessionMemoryPanel client={client} sessionId={sessionId}
      sessionRevision="7" inflight={false} writeBlocked={false} writeBlockedReason={null}
      pollIntervalMs={10} onSessionRevisionChanged={onSessionRevisionChanged} />);
    unmount = mounted.unmount;
    await flush();
    await mounted.wrapper.get('[data-testid="session-memory-remember"]').trigger("click");
    await flush();
    expect(mounted.wrapper.get('[data-testid="session-memory-notice"]').text()).toContain("一次性模式");
    expect(onSessionRevisionChanged).toHaveBeenCalledTimes(1);
    // 重读后的窗口修订与会话修订都变了；双修订收在诊断里，普通视图只留可读状态。
    expect(mounted.wrapper.get('[data-testid="session-memory-diagnostics"]').text()).toContain("会话修订 v8");
    expect(mounted.wrapper.get('[data-testid="session-memory-mode"]').text()).not.toContain("会话修订");
    expect(root).toContain(workspaceId);
  });
});
