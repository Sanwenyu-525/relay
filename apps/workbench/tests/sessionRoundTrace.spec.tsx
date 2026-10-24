import { afterEach, describe, expect, it, vi } from "vitest";
import { RelayApiClient, type RelayAssistMessage } from "../src/api/relayClient";
import { SessionRoundTrace } from "../src/components/SessionRoundTrace";
import { flush, mountReact } from "./mountApp";

/**
 * 这一轮做了什么（工作台 §18.10「原消息下展示读取中、执行中…实际阶段」）。
 *
 * 2026-10-21 用户指认「ai 的思考过程看不到」：工具轮次一直只写 `session_tool_calls`，
 * 没有 HTTP 读入口，界面上因此只剩三点动画。这里验的是这个入口能否把已落账的轮次如实摆出来，
 * 以及四种不能含糊的口径：
 *   * 在途才轮询，终态不预取（一整段历史不该为每条消息各发一次请求）。
 *   * 没有轮次就什么都不摆（2026-10-23 用户截图指令删掉解释段与脚注）：不显示成读取失败，
 *     也不补一句「没有调用工具」的说明——摘要行与在途三点已经足够。
 *   * 未结算／未知不写成已执行；被拒的那一行要带服务端的原因。
 *   * 用户消息没有这个入口。
 */

const baseUrl = "http://127.0.0.1:8787";
const workspaceId = "11111111-1111-4111-8111-111111111111";
const sessionId = "33333333-3333-4333-8333-333333333333";
const messageId = "44444444-4444-4444-8444-444444444444";
const client = new RelayApiClient({ baseUrl, workspaceId, bearerToken: "test-bearer-token-0123456789abcdef" });
let unmount: (() => void) | null = null;

afterEach(() => { unmount?.(); unmount = null; vi.unstubAllGlobals(); });

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function call(overrides: Record<string, unknown> = {}) {
  return { id: "55555555-5555-4555-8555-555555555555", round: 0, ordinal: 0,
    tool_name: "read_file", status: "SETTLED", arguments: { relative_path: "README.md" },
    arguments_sha256: "a".repeat(64), provider_tool_call_id: "call-1", operation_id: null,
    rejection_reason: null, rejection_detail: null, result_digest: null,
    requested_at: "2026-10-21T00:00:00.000Z", settled_at: "2026-10-21T00:00:01.250Z", ...overrides };
}

function trace(rounds: readonly unknown[], messageStatus = "RUNNING") {
  return { session_id: sessionId, message_id: messageId, message_status: messageStatus, rounds };
}

function round(index: number, calls: readonly unknown[]) {
  return { round: index, calls };
}

function message(overrides: Record<string, unknown> = {}): RelayAssistMessage {
  const base = { id: messageId, sessionId, status: "RUNNING", role: "ASSISTANT" };
  return { ...base, ...overrides } as unknown as RelayAssistMessage;
}

async function mount(target: RelayAssistMessage, pollIntervalMs = 10) {
  const mounted = await mountReact(<SessionRoundTrace client={client} message={target}
    pollIntervalMs={pollIntervalMs} />);
  unmount = mounted.unmount;
  await flush(20);
  return mounted;
}

function stub(handler: (url: string) => Response) {
  const fetchMock = vi.fn(async (input: RequestInfo | URL) => handler(String(input)));
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

describe("在途轮次", () => {
  it("自动展开并按轮列出实际工具、对象与结算状态", async () => {
    stub(() => json(trace([round(0, [call()]),
      round(1, [call({ id: "66666666-6666-4666-8666-666666666666", ordinal: 0,
        tool_name: "list_directory", arguments: { relative_path: "src" }, settled_at: null,
        status: "REQUESTED" })])])));
    const { wrapper } = await mount(message());
    const details = wrapper.get(`[data-testid="session-round-trace-${messageId}"]`);
    expect(details.attributes("open")).toBeDefined();
    expect(details.text()).toContain("这一轮做了什么 · 2 步");
    expect(details.text()).toContain("第 1 轮");
    expect(details.text()).toContain("第 2 轮");
    expect(details.text()).toContain("read_file");
    expect(details.text()).toContain("README.md");
    // 未结算那行不能读成已执行。
    expect(details.find('[data-status="REQUESTED"]').text()).toContain("尚未结算");
  });

  it("轮询到消息终态后停止读取，并保留最后一次读数", async () => {
    let finished = false;
    const fetchMock = vi.fn(async () => json(trace(finished
      ? [round(0, [call(), call({ id: "88888888-8888-4888-8888-888888888888", ordinal: 1,
        tool_name: "search_text", arguments: { query: "claim" } })])]
      : [round(0, [call()])])));
    vi.stubGlobal("fetch", fetchMock);
    const mounted = await mountReact(<SessionRoundTrace client={client} message={message()}
      pollIntervalMs={10} />);
    unmount = mounted.unmount;
    await flush(40);
    expect(mounted.wrapper.text()).toContain("这一轮做了什么 · 1 步");
    const duringFlight = fetchMock.mock.calls.length;
    finished = true;
    await mounted.rerender(<SessionRoundTrace client={client}
      message={message({ status: "COMPLETED" })} pollIntervalMs={10} />);
    await flush(40);
    // 终态只补读收尾那一次，之后不再有定时器。
    expect(fetchMock.mock.calls.length).toBeLessThanOrEqual(duringFlight + 2);
    expect(mounted.wrapper.text()).toContain("这一轮做了什么 · 2 步");
    expect(mounted.wrapper.text()).not.toContain("进行中");
    const afterTerminal = fetchMock.mock.calls.length;
    await flush(40);
    expect(fetchMock.mock.calls.length).toBe(afterTerminal);
  });
});

describe("终态与缺口", () => {
  it("刷新后的终态消息不预取，首次展开才读一次", async () => {
    const fetchMock = stub(() => json(trace([round(0, [call({ status: "REJECTED",
      settled_at: "2026-10-21T00:00:00.500Z", rejection_reason: "OUTSIDE_SCOPE",
      rejection_detail: "目标不在本次绑定的目录内。" })])], "COMPLETED"), 200));
    const { wrapper } = await mount(message({ status: "COMPLETED" }), 2_000);
    expect(fetchMock.mock.calls.length).toBe(0);
    const details = wrapper.get(`[data-testid="session-round-trace-${messageId}"]`);
    expect(details.text()).toContain("这一轮做了什么");
    expect(details.text()).not.toContain("read_file");
    await wrapper.get("summary").trigger("click");
    await flush(20);
    expect(fetchMock.mock.calls.length).toBe(1);
    expect(details.text()).toContain("被拒绝，没有执行");
    expect(details.text()).toContain("OUTSIDE_SCOPE · 目标不在本次绑定的目录内。");
  });

  it("没有轮次就什么都不摆：不显示失败，也不补解释段", async () => {
    stub(() => json(trace([], "COMPLETED")));
    const { wrapper } = await mount(message({ status: "COMPLETED" }), 2_000);
    await wrapper.get("summary").trigger("click");
    await flush(20);
    const details = wrapper.get(`[data-testid="session-round-trace-${messageId}"]`);
    // 解释段与脚注已按用户指令删除：没有轮次时面板里不该出现任何说明文字。
    expect(details.text()).not.toContain("没有调用任何工具");
    expect(details.text()).not.toContain("已落账");
    expect(details.text()).not.toContain("read_file");
    expect(wrapper.find('[data-testid^="session-round-trace-error-"]').exists()).toBe(false);
    expect(wrapper.find('[data-testid^="session-round-trace-list-"]').exists()).toBe(false);
  });

  it("读取失败说明确切原因并给重新读取，点一次再读一次", async () => {
    // 404 是这台机器上最真实的一种失败：桌面 dev 窗口跑的是暂存 API 包，前端领先后端时
    // 这个新 GET 直接没有路由。这里要的是把确切状态摆出来，不是编一句「没有工具能力」。
    let missingRoute = true;
    const fetchMock = vi.fn(async () => missingRoute
      ? new Response("", { status: 404 })
      : json(trace([round(0, [call()])], "COMPLETED")));
    vi.stubGlobal("fetch", fetchMock);
    const { wrapper } = await mount(message({ status: "COMPLETED" }), 2_000);
    await wrapper.get("summary").trigger("click");
    await flush(20);
    expect(wrapper.get(`[data-testid^="session-round-trace-error-"]`).text())
      .toContain("HTTP 404");
    missingRoute = false;
    const before = fetchMock.mock.calls.length;
    await wrapper.get('[data-testid^="session-round-trace-retry-"]').trigger("click");
    await flush(20);
    expect(fetchMock.mock.calls.length).toBe(before + 1);
    expect(wrapper.find('[data-testid^="session-round-trace-error-"]').exists()).toBe(false);
    expect(wrapper.text()).toContain("read_file");
  });

  it("结果未知就写未知，不补出成功或失败", async () => {
    stub(() => json(trace([round(0, [call({ status: "UNKNOWN", settled_at: null,
      rejection_reason: "READ_TIMEOUT" })])], "COMPLETED")));
    const { wrapper } = await mount(message({ status: "COMPLETED" }), 2_000);
    await wrapper.get("summary").trigger("click");
    await flush(20);
    expect(wrapper.get('[data-status="UNKNOWN"]').text()).toContain("结果未知，需核对");
    expect(wrapper.text()).toContain("READ_TIMEOUT");
    expect(wrapper.text()).not.toContain("已结算");
  });

  it("用户消息没有这个入口", async () => {
    const fetchMock = stub(() => json(trace([])));
    const { wrapper } = await mount(message({ role: "USER", status: "COMPLETED" }), 2_000);
    expect(wrapper.find('[data-testid^="session-round-trace-"]').exists()).toBe(false);
    expect(fetchMock.mock.calls.length).toBe(0);
  });

  it("响应身份与请求消息不符时不采信，界面不显示别人的轮次", async () => {
    // 服务端不会给出这种响应；这里模拟的是「迟到的旧响应落到了另一条消息上」。
    vi.stubGlobal("fetch", vi.fn(async () => json({ session_id: sessionId,
      message_id: "99999999-9999-4999-8999-999999999999", message_status: "RUNNING", rounds: [] })));
    const mounted = await mountReact(<SessionRoundTrace client={client} message={message()}
      pollIntervalMs={10} />);
    unmount = mounted.unmount;
    await flush(20);
    expect(mounted.wrapper.text()).not.toContain("read_file");
    expect(mounted.wrapper.get(`[data-testid^="session-round-trace-error-"]`).text())
      .toContain("响应身份与请求的消息不符");
  });
});
