import { afterEach, describe, expect, it, vi } from "vitest";
import { RelayApiClient, type RelayAssistMessage } from "../src/api/relayClient";
import { SessionRoundTrace } from "../src/components/SessionRoundTrace";
import { DomWrapper, flush, mountReact } from "./mountApp";

/**
 * 执行过程（工作台 §18.10；2026-10-29 V3）。
 *
 * 这里验的是「点击一定有确定的反馈」，以及四条不能含糊的口径：
 *   * 入口对每条 AI 消息恒在——读到零条也不消失（V2 的 `return null` 缺陷的永久回归）。
 *   * 标题行的规模与状态由可验证的聚合状态派生：不知道总数不报 2/5，没读到不预判有没有工具。
 *   * 在途才轮询，终态不预取（一整段历史不该为每条消息各发一次请求）。
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

const entry = (wrapper: DomWrapper) =>
  wrapper.get(`[data-testid="session-round-trace-${messageId}"]`);

describe("在途轮次", () => {
  it("自动展开，标题行报规模与状态，并按轮列出实际工具、对象与结算状态", async () => {
    stub(() => json(trace([round(0, [call()]),
      round(1, [call({ id: "66666666-6666-4666-8666-666666666666", ordinal: 0,
        tool_name: "list_directory", arguments: { relative_path: "src" }, settled_at: null,
        status: "REQUESTED" })])])));
    // 这条用例不验轮询：用 2 秒间隔，避免 10ms 定时器在负载高的机器上把 act 拖到超时。
    const { wrapper } = await mount(message(), 2_000);
    const details = entry(wrapper);
    expect(details.attributes("open")).toBeDefined();
    expect(details.text()).toContain("执行过程");
    // 标题行只说「规模 + 状态」：总数未知（模型还可能继续调工具），因此不报 2/5。
    expect(details.text()).toContain("已结算 1 项 · 正在执行");
    expect(details.text()).not.toContain("预计还需");
    expect(details.text()).toContain("第 1 轮");
    expect(details.text()).toContain("第 2 轮");
    expect(details.text()).toContain("README.md");
    // 工具名不进可见行：展开这一行才看得到「模型到底调了什么」。
    await wrapper.get('[data-testid="session-round-call-55555555-5555-4555-8555-555555555555-toggle"]')
      .trigger("click");
    await flush(20);
    expect(details.text()).toContain("read_file");
    // 未结算那行不能读成已执行。
    expect(details.find('[data-status="REQUESTED"]').text()).toContain("尚未结算");
    // 整份列表只有一个「当前行」：它是唯一会转动的图标。
    expect(wrapper.findAll('[data-current="true"]')).toHaveLength(1);
  });

  it("轮询到消息终态后停止读取，标题行改报已结束", async () => {
    let finished = false;
    const fetchMock = vi.fn(async () => json(trace(finished
      ? [round(0, [call(), call({ id: "88888888-8888-4888-8888-888888888888", ordinal: 1,
        tool_name: "search_text", arguments: { query: "claim" } })])]
      : [round(0, [call()])])));
    vi.stubGlobal("fetch", fetchMock);
    // 50ms 一档而不是 10ms：这条用例只验「在途会轮询、终态会停」，不验轮询频率；
    // 更密的定时器会让 act 在本机负载高时迟迟收不拢，把用例拖成假超时。
    const mounted = await mountReact(<SessionRoundTrace client={client} message={message()}
      pollIntervalMs={50} />);
    unmount = mounted.unmount;
    await flush(150);
    expect(mounted.wrapper.text()).toContain("已结算 1 项 · 正在执行");
    expect(fetchMock.mock.calls.length).toBeGreaterThan(1);
    const duringFlight = fetchMock.mock.calls.length;
    finished = true;
    await mounted.rerender(<SessionRoundTrace client={client}
      message={message({ status: "COMPLETED" })} pollIntervalMs={50} />);
    await flush(150);
    // 终态只补读收尾那一次，之后不再有定时器。
    expect(fetchMock.mock.calls.length).toBeLessThanOrEqual(duringFlight + 2);
    expect(mounted.wrapper.text()).toContain("2 项操作 · 已结束");
    expect(mounted.wrapper.text()).not.toContain("进行中");
    const afterTerminal = fetchMock.mock.calls.length;
    await flush(200);
    expect(fetchMock.mock.calls.length).toBe(afterTerminal);
  }, 20_000);

  /**
   * 原生 `<details>` 在 React 改 `open` 属性时同样派发 toggle。此前那段回声被写进 touched，
   * 于是「完成时自动收起」只生效一次、之后永久失效——用户看到的是过程区在终态仍然大敞着，
   * 把正文顶到屏幕之外。这里钉住两条：程序化收起不算人工操作；人手展开过就尊重。
   */
  it("程序化收起不写成人工开合；人手展开过则完成时保持展开", async () => {
    stub(() => json(trace([round(0, [call()])])));
    const mounted = await mountReact(<SessionRoundTrace client={client} message={message()}
      pollIntervalMs={2_000} />);
    unmount = mounted.unmount;
    await flush(20);
    const details = () => mounted.wrapper.get(`[data-testid="session-round-trace-${messageId}"]`);
    expect(details().attributes("open")).toBeDefined();
    await mounted.rerender(<SessionRoundTrace client={client}
      message={message({ status: "COMPLETED" })} pollIntervalMs={2_000} />);
    await flush(20);
    expect(details().attributes("open")).toBeUndefined();

    await mounted.wrapper.get("summary").trigger("click");
    await flush(20);
    expect(details().attributes("open")).toBeDefined();

    await mounted.rerender(<SessionRoundTrace client={client} message={message()} pollIntervalMs={2_000} />);
    await flush(20);
    await mounted.rerender(<SessionRoundTrace client={client}
      message={message({ status: "COMPLETED" })} pollIntervalMs={2_000} />);
    await flush(20);
    expect(details().attributes("open")).toBeDefined();
  });

  it("被拒与未知分档：标题报未执行，轮次标题报待核对", async () => {
    stub(() => json(trace([round(0, [call({ status: "REJECTED", rejection_reason: "OUTSIDE_SCOPE" }),
      call({ id: "88888888-8888-4888-8888-888888888888", ordinal: 1, tool_name: "search_text",
        status: "UNKNOWN", settled_at: null })])], "COMPLETED")));
    const { wrapper } = await mount(message({ status: "COMPLETED" }), 2_000);
    await wrapper.get("summary").trigger("click");
    await flush(20);
    // 两种例外是两件事：被拒=根本没执行，未知=结果不明。它们不合并成一句「异常」。
    expect(wrapper.get("summary").text()).toContain("1 项未执行");
    expect(wrapper.get("summary").text()).not.toContain("已结束");
    const roundTitle = wrapper.get('[data-testid="session-round-0"]').text();
    expect(roundTitle).toContain("1 项待核对");
    expect(wrapper.get(`[data-testid="session-round-trace-${messageId}"]`).attributes("data-state"))
      .toBe("settled");
  });
});

describe("终态与缺口", () => {
  /**
   * X03 反例：正文已经结束，但这一轮仍有一项停在 REQUESTED、没有结算结果。
   * 消息终态不等于工具账本终态：标题行不许把这种情况概括成「已结束」。
   * 同时钉住「未结算」与被拒／未知是两回事：前者只能说仍有 N 项未结算。
   */
  it("正文已结束但仍有未结算的调用：标题不报「已结束」，改报未结算数", async () => {
    stub(() => json(trace([round(0, [call(), call({
      id: "99999999-9999-4999-8999-999999999999", ordinal: 1, tool_name: "search_text",
      arguments: { query: "claim" }, status: "REQUESTED", settled_at: null })])])));
    const mounted = await mount(message(), 50);
    await flush(150);
    await mounted.rerender(<SessionRoundTrace client={client}
      message={message({ status: "COMPLETED" })} pollIntervalMs={50} />);
    await flush(150);
    const text = mounted.wrapper.text();
    expect(text, "消息终态不能把未结算的工具说成已结束").not.toContain("已结束");
    expect(text).toContain("2 项操作");
    expect(text).toContain("1 项未结算");
  });

  it("刷新后的终态消息不预取，首次展开才读一次", async () => {
    const fetchMock = stub(() => json(trace([round(0, [call({ status: "REJECTED",
      settled_at: "2026-10-21T00:00:00.500Z", rejection_reason: "OUTSIDE_SCOPE",
      rejection_detail: "目标不在本次绑定的目录内。" })])], "COMPLETED"), 200));
    const { wrapper } = await mount(message({ status: "COMPLETED" }), 2_000);
    expect(fetchMock.mock.calls.length).toBe(0);
    const details = wrapper.get(`[data-testid="session-round-trace-${messageId}"]`);
    // 还没读到：只说「展开查看」，不预判有没有工具、也不报数字。
    expect(details.text()).toContain("执行过程");
    expect(details.text()).toContain("展开查看");
    expect(details.text()).not.toContain("read_file");
    await wrapper.get("summary").trigger("click");
    await flush(20);
    expect(fetchMock.mock.calls.length).toBe(1);
    expect(details.text()).toContain("被拒绝，没有执行");
    expect(details.text()).toContain("OUTSIDE_SCOPE · 目标不在本次绑定的目录内。");
  });

  /**
   * 永久回归（2026-10-29 V3 P0）：入口已经点开了，读回零条记录时**不能整块消失**。
   * V2 在这里 `return null`，用户看到的是「点了一下，然后入口没了」——既不知道是没有工具，
   * 还是读取失败。现在必须留下入口与一句确定的空态说明。
   */
  it("读回零条记录后入口不消失，改为显示空状态", async () => {
    const fetchMock = stub(() => json(trace([], "COMPLETED")));
    const { wrapper } = await mount(message({ status: "COMPLETED" }), 2_000);
    const before = wrapper.get(`[data-testid="session-round-trace-${messageId}"]`);
    expect(before.text()).toContain("展开查看");
    await wrapper.get("summary").trigger("click");
    await flush(20);
    expect(fetchMock.mock.calls.length).toBe(1);
    // 入口仍在，且仍是可开合的那一个。
    const after = wrapper.find(`[data-testid="session-round-trace-${messageId}"]`);
    expect(after.exists()).toBe(true);
    expect(after.attributes("data-phase")).toBe("EMPTY");
    expect(after.text()).toContain("执行过程");
    expect(after.text()).toContain("本轮没有调用工具");
    expect(wrapper.find(`[data-testid="session-round-trace-empty-${messageId}"]`).exists()).toBe(true);
    // 空态不是错误态，也不是「有轮次」。
    expect(wrapper.find('[data-testid^="session-round-trace-error-"]').exists()).toBe(false);
    expect(wrapper.find('[data-testid^="session-round-trace-list-"]').exists()).toBe(false);
    // 再点一次仍然可以收起，不会因为空而变成死入口。
    await wrapper.get("summary").trigger("click");
    await flush(20);
    expect(wrapper.find(`[data-testid="session-round-trace-${messageId}"]`).exists()).toBe(true);
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
    // 读取失败也不能被说成「本轮没有调用工具」。
    expect(wrapper.find(`[data-testid="session-round-trace-empty-${messageId}"]`).exists()).toBe(false);
    missingRoute = false;
    const before = fetchMock.mock.calls.length;
    await wrapper.get('[data-testid^="session-round-trace-retry-"]').trigger("click");
    await flush(20);
    expect(fetchMock.mock.calls.length).toBe(before + 1);
    expect(wrapper.find('[data-testid^="session-round-trace-error-"]').exists()).toBe(false);
    await wrapper.get('[data-testid="session-round-call-55555555-5555-4555-8555-555555555555-toggle"]')
      .trigger("click");
    await flush(20);
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
    expect(wrapper.text()).not.toContain("已结束");
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
      pollIntervalMs={2_000} />);
    unmount = mounted.unmount;
    await flush(20);
    expect(mounted.wrapper.text()).not.toContain("read_file");
    expect(mounted.wrapper.get(`[data-testid^="session-round-trace-error-"]`).text())
      .toContain("响应身份与请求的消息不符");
  });
});

describe("长轮次收敛", () => {
  it("单轮超过阈值时先显示前若干项与全部例外，展开后完整可见", async () => {
    const calls = Array.from({ length: 12 }, (_, index) => call({
      id: `77777777-7777-4777-8777-77777777777${String(index).padStart(1, "0")}`,
      ordinal: index, arguments: { relative_path: `src/f${index}.ts` } }));
    // 第 11 项被拒：它落在收敛区之外，但仍必须可见。
    calls[11] = call({ id: "77777777-7777-4777-8777-777777777799", ordinal: 11, status: "REJECTED",
      rejection_reason: "OUTSIDE_SCOPE", arguments: { relative_path: "etc/hosts" } });
    stub(() => json(trace([round(0, calls)], "COMPLETED")));
    const { wrapper } = await mount(message({ status: "COMPLETED" }), 2_000);
    await wrapper.get("summary").trigger("click");
    await flush(20);
    // 前 6 项 + 末尾那条被拒 = 7；其余 5 项收在「展开其余」里。
    expect(wrapper.findAll(".activity-item")).toHaveLength(7);
    expect(wrapper.text()).toContain("被拒绝，没有执行");
    await wrapper.get('[data-testid="session-round-more-0"]').trigger("click");
    await flush(20);
    expect(wrapper.findAll(".activity-item")).toHaveLength(12);
  });
});

/**
 * 在途零记录（2026-10-30 验收整改的永久回归）。
 *
 * 独立验收发现的缺陷：消息还在跑、工具还没开始时，面板被判成 EMPTY 并写
 * 「本轮没有调用工具」——那是替模型提前下结论。现在这种情况是 RUNNING_NO_TOOLS：
 * 只报「正在执行」，不报规模、不给空态块。
 */
describe("在途零记录", () => {
  it("运行中且尚无工具记录：不宣布「没有调用工具」", async () => {
    stub(() => json(trace([], "RUNNING")));
    const { wrapper } = await mount(message({ status: "RUNNING" }), 2_000);
    const details = entry(wrapper);
    expect(details.attributes("data-phase")).toBe("RUNNING_NO_TOOLS");
    expect(details.attributes("data-tone")).toBe("running");
    expect(details.text()).toContain("正在执行");
    expect(details.text()).not.toContain("没有调用工具");
    expect(details.text()).not.toContain("本轮");
    expect(wrapper.find(`[data-testid="session-round-trace-empty-${messageId}"]`).exists()).toBe(false);
  });

  it("已提交但 Worker 尚未领取：说「等待处理」，不说正在执行", async () => {
    stub(() => json(trace([], "PENDING")));
    const { wrapper } = await mount(message({ status: "PENDING" }), 2_000);
    expect(wrapper.get("summary").text()).toContain("等待处理");
    expect(wrapper.get("summary").text()).not.toContain("没有调用工具");
  });

  it("同样的零记录在消息结束后才变成「没有调用工具」", async () => {
    stub(() => json(trace([], "COMPLETED")));
    const { wrapper } = await mount(message({ status: "COMPLETED" }), 2_000);
    // 终态不预取：先只说「展开查看」。
    expect(wrapper.get("summary").text()).toContain("展开查看");
    await wrapper.get("summary").trigger("click");
    await flush(20);
    expect(entry(wrapper).attributes("data-phase")).toBe("EMPTY");
    expect(wrapper.get(`[data-testid="session-round-trace-empty-${messageId}"]`).exists()).toBe(true);
  });
});
