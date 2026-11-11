import { afterEach, describe, expect, it, vi } from "vitest";
import { RelayApiClient, type RelayAssistMessage } from "../src/api/relayClient";
import { SessionRoundTrace } from "../src/components/SessionRoundTrace";
import { DomWrapper, flush, mountReact } from "./mountApp";

/**
 * 工具活动（工作台 §18.10；2026-10-29 V3，2026-10-31 UI-08 收口）。
 *
 * 2026-10-31 UI-08 的产品语义：正文三点 = 回复还在等待/生成；工具活动 = 已落账的真实工具调用。
 * 两者不是同一种业务信息，因此等待阶段不再画一条「工具活动 · 等待处理」。
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
    expect(details.text()).toContain("工具活动");
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
   * 于是程序化开合只生效一次、之后永久失效。
   *
   * 2026-11-10 用户指令「调用工具、读取文件的过程看不了」：这条消息在本页里真实跑过工具时，
   * 完成态保持展开（过程跟着回复一起可读）；用户自己收起后不再被程序化弹开。
   */
  it("完成态保留过程展开；用户收起后不再被程序化打开", async () => {
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
    expect(details().attributes("open")).toBeDefined();

    // 用户主动收起：之后同一段消息即使再次经过在途→终态，也不再自动展开。
    await mounted.wrapper.get("summary").trigger("click");
    await flush(20);
    expect(details().attributes("open")).toBeUndefined();

    await mounted.rerender(<SessionRoundTrace client={client} message={message()} pollIntervalMs={2_000} />);
    await flush(20);
    await mounted.rerender(<SessionRoundTrace client={client}
      message={message({ status: "COMPLETED" })} pollIntervalMs={2_000} />);
    await flush(20);
    expect(details().attributes("open")).toBeUndefined();
  });

  it("历史消息（挂载时已是终态）不因有工具记录自动展开", async () => {
    stub(() => json(trace([round(0, [call()])])));
    const { wrapper } = await mount(message({ status: "COMPLETED" }), 2_000);
    // 终态入口先收起，点开才读取；读到工具有记录也不自动弹开。
    expect(entry(wrapper).attributes("open")).toBeUndefined();
    await wrapper.get("summary").trigger("click");
    await flush(20);
    expect(entry(wrapper).attributes("open")).toBeDefined();
    expect(entry(wrapper).text()).toContain("README.md");
  });

  it("被拒与未知分档：标题报整条的例外，多轮时每一轮只报自己那一轮的", async () => {
    stub(() => json(trace([round(0, [call({ status: "REJECTED", rejection_reason: "OUTSIDE_SCOPE" })]),
      round(1, [call({ id: "88888888-8888-4888-8888-888888888888", ordinal: 0,
        tool_name: "search_text", status: "UNKNOWN", settled_at: null })])], "COMPLETED")));
    const { wrapper } = await mount(message({ status: "COMPLETED" }), 2_000);
    await wrapper.get("summary").trigger("click");
    await flush(20);
    // 两种例外是两件事：被拒=根本没执行，未知=结果不明。它们不合并成一句「异常」。
    expect(wrapper.get("summary").text()).toContain("1 项未执行");
    expect(wrapper.get("summary").text()).not.toContain("已结束");
    const roundTitle = wrapper.get('[data-testid="session-round-1"]').text();
    expect(roundTitle).toContain("1 项待核对");
    // 组标题报的是**这一轮**的事实，不跟着整条消息染色：第 0 轮没有未知项。
    expect(wrapper.get('[data-testid="session-round-0"]').text()).not.toContain("待核对");
    expect(wrapper.get(`[data-testid="session-round-trace-${messageId}"]`).attributes("data-state"))
      .toBe("settled");
  });

  /**
   * 只有一轮时组标题整行都是重复信息（2026-11-01 P1-1）：「第 1 轮 · 2 项 · 1 项未执行」
   * 与标题行「工具活动 · 2 项操作 · 1 项未执行」是同一份聚合读两遍，而「第 1 轮」在只有
   * 一轮时不携带任何信息。收掉的是重复的聚合数字，不是失败本身——行内的状态词与常显原因
   * 句必须照旧可见，例外在任何折叠下都不藏。
   */
  it("只有一轮：不画组标题，聚合数字只在标题行说一遍，例外仍在行内可见", async () => {
    stub(() => json(trace([round(0, [call({ status: "REJECTED",
      rejection_reason: "SUBAGENT_PARENT_SCOPE_MISSING",
      rejection_detail: "主会话还没有绑定项目或工作目录，子 Agent 没有可读的范围。" })])], "COMPLETED")));
    const { wrapper } = await mount(message({ status: "COMPLETED" }), 2_000);
    await wrapper.get("summary").trigger("click");
    await flush(20);
    expect(wrapper.get("summary").text()).toContain("1 项未执行");
    expect(wrapper.find(".activity-panel-round-title").exists()).toBe(false);
    expect(wrapper.text()).toContain("被拒绝，没有执行");
    // 常显那一行说人话：截图里原先摊的是 `SUBAGENT_PARENT_SCOPE_MISSING · …` 一个枚举名。
    expect(wrapper.get('[data-testid="session-round-call-reason-55555555-5555-4555-8555-555555555555"]').text())
      .toBe("子任务未启动：主会话还没有绑定项目或工作目录，子 Agent 没有可读的范围。");
    // 机器码没有消失，只是退到展开层（核对「服务端记的到底是哪个码」时才需要）。
    expect(wrapper.text()).not.toContain("SUBAGENT_PARENT_SCOPE_MISSING");
    await wrapper.get('[data-testid="session-round-call-55555555-5555-4555-8555-555555555555-toggle"]')
      .trigger("click");
    await flush(20);
    expect(wrapper.get('[data-testid="session-round-call-55555555-5555-4555-8555-555555555555-detail"]').text())
      .toContain("SUBAGENT_PARENT_SCOPE_MISSING");
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
    expect(details.text()).toContain("工具活动");
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
    expect(after.text()).toContain("工具活动");
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

/**
 * 普通纯文本回复的过程入口（2026-10-31 UI-08）。
 * 默认视图只留正文：用户没主动展开、这一轮又确实零工具时，整条「工具活动」不在场；
 * 用户点开过的入口仍然保留，并且空状态收成一行结论，不再是一块技术说明卡。
 */
describe("纯文本回复的过程入口", () => {
  it("终态读到零条且用户没展开过：整行不常驻，正文不再跟着一条空说明", async () => {
    stub(() => json(trace([], "RUNNING")));
    const mounted = await mountReact(<SessionRoundTrace client={client} message={message()}
      pollIntervalMs={2_000} />);
    unmount = mounted.unmount;
    await flush(20);
    // 在途且零记录：这一段等待由正文三点独立承担，这里不摆一条空横条。
    expect(mounted.wrapper.find(`[data-testid="session-round-trace-${messageId}"]`).exists()).toBe(false);
    await mounted.rerender(<SessionRoundTrace client={client}
      message={message({ status: "COMPLETED" })} pollIntervalMs={2_000} />);
    await flush(20);
    expect(mounted.wrapper.find(`[data-testid="session-round-trace-${messageId}"]`).exists(),
      "终态零工具时普通回复不应常驻过程行").toBe(false);
  });

  it("用户主动展开过：读回零条后入口仍在，空状态只给一行结论", async () => {
    stub(() => json(trace([], "COMPLETED")));
    const { wrapper } = await mount(message({ status: "COMPLETED" }), 2_000);
    await wrapper.get("summary").trigger("click");
    await flush(20);
    expect(entry(wrapper).text()).toContain("本轮没有调用工具");
    const empty = wrapper.get(`[data-testid="session-round-trace-empty-${messageId}"]`);
    // 入口没有消失（V3 P0），但空状态从说明卡收成一行 caption。
    expect(empty.element?.tagName).toBe("P");
    expect(empty.text()).not.toContain("本次回复仅基于已有信息与上下文生成");
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
 * 等待阶段与首次工具活动（2026-10-31 UI-08）。
 *
 * 产品语义：三点动画表示 AI 回复处于等待或生成阶段，工具活动表示已落账的真实工具调用。
 * 两者不是同一种业务信息，所以等待阶段**不再**在正文上方画一条「工具活动 · 等待处理」；
 * 第一次真实工具活动到达时才长出入口。读数失败不等于「没有调用工具」，必须保留错误与重读；
 * 终态零工具不制造空的过程区域，但历史消息未读取时仍保留「展开查看」。
 */
describe("等待阶段不占位", () => {
  it("PENDING 且零记录：整块不渲染，等待只由正文三点表达", async () => {
    const fetchMock = stub(() => json(trace([], "PENDING")));
    const { wrapper } = await mount(message({ status: "PENDING" }), 2_000);
    expect(wrapper.find(`[data-testid="session-round-trace-${messageId}"]`).exists()).toBe(false);
    expect(wrapper.find('[data-testid^="session-round-trace-empty-"]').exists()).toBe(false);
    // 轮询仍在跑：等的是「第一批工具记录」，不是「面板有没有出现」。
    expect(fetchMock.mock.calls.length).toBeGreaterThan(0);
  });

  it("RUNNING 且零记录：同样不占位，也不宣布「没有调用工具」", async () => {
    stub(() => json(trace([], "RUNNING")));
    const { wrapper } = await mount(message({ status: "RUNNING" }), 2_000);
    expect(wrapper.find(`[data-testid="session-round-trace-${messageId}"]`).exists()).toBe(false);
    expect(wrapper.text()).not.toContain("没有调用工具");
  });

  it("第一次真实工具活动到达：入口出现、默认展开，标题是「工具活动」", async () => {
    stub(() => json(trace([round(0, [call({ status: "REQUESTED", settled_at: null })])], "RUNNING")));
    const { wrapper } = await mount(message({ status: "RUNNING" }), 2_000);
    const details = entry(wrapper);
    expect(details.attributes("open")).toBeDefined();
    expect(details.text()).toContain("工具活动");
    expect(details.text()).not.toContain("等待处理");
    expect(details.attributes("data-phase")).toBe("RUNNING");
    // 它接手主进度动效：行内旋转图标出现，标题图标不再重复转。
    expect(wrapper.findAll(".activity-item-spin")).toHaveLength(1);
    expect(wrapper.findAll(".activity-header-spin")).toHaveLength(0);
  });

  it("工具都结算完、正文还在生成：记录留着，标题图标接手唯一的主进度动效", async () => {
    stub(() => json(trace([round(0, [call()])], "RUNNING")));
    const { wrapper } = await mount(message({ status: "RUNNING" }), 2_000);
    // 在途的规模只报已结算数，不报总数（总数此刻未知）。
    expect(wrapper.text()).toContain("已结算 1 项 · 正在执行");
    expect(wrapper.findAll(".activity-item-spin")).toHaveLength(0);
    expect(wrapper.findAll(".activity-header-spin")).toHaveLength(1);
  });

  it("读数失败：错误与重读都在，失败不等于「没有调用工具」", async () => {
    let failing = true;
    const fetchMock = vi.fn(async () => failing ? new Response("", { status: 503 })
      : json(trace([], "RUNNING")));
    vi.stubGlobal("fetch", fetchMock);
    const mounted = await mountReact(<SessionRoundTrace client={client} message={message()}
      pollIntervalMs={2_000} />);
    unmount = mounted.unmount;
    await flush(20);
    expect(mounted.wrapper.get('[data-testid^="session-round-trace-error-"]').text())
      .toContain("过程读取失败");
    expect(mounted.wrapper.find('[data-testid^="session-round-trace-empty-"]').exists()).toBe(false);
    failing = false;
    await mounted.wrapper.get('[data-testid^="session-round-trace-retry-"]').trigger("click");
    await flush(20);
    // 恢复后确实读回零条：错误消失，入口按事实收起（事实变了，不是被遮住）。
    expect(mounted.wrapper.find('[data-testid^="session-round-trace-error-"]').exists()).toBe(false);
    expect(mounted.wrapper.find(`[data-testid="session-round-trace-${messageId}"]`).exists()).toBe(false);
  });

  it("主进度动效的 Owner 只在「在途 + 有真实记录」时交给工具活动", async () => {
    const seen: boolean[] = [];
    let rounds: readonly unknown[] = [];
    // 50ms 一档：需要轮询真的把「第一批记录」读回来，而不是只换了一个 prop。
    vi.stubGlobal("fetch", vi.fn(async () => json(trace(rounds, "RUNNING"))));
    const onOwn = (owns: boolean) => { seen.push(owns); };
    const mounted = await mountReact(<SessionRoundTrace client={client} message={message()}
      pollIntervalMs={50} onProgressOwnerChange={onOwn} />);
    unmount = mounted.unmount;
    await flush(60);
    expect(seen.at(-1)).toBe(false);
    rounds = [round(0, [call({ status: "REQUESTED", settled_at: null })])];
    await flush(250);
    expect(seen.at(-1)).toBe(true);
    await mounted.rerender(<SessionRoundTrace client={client} message={message({ status: "COMPLETED" })}
      pollIntervalMs={50} onProgressOwnerChange={onOwn} />);
    await flush(250);
    expect(seen.at(-1)).toBe(false);
  });
});
