import { afterEach, describe, expect, it, vi } from "vitest";
import { RelayApiClient } from "../src/api/relayClient";
import type { RelaySessionContextUsage } from "../src/api/dtos/assist";
import ContextUsagePanel from "../src/components/ContextUsagePanel";
import { flush, mountReact } from "./mountApp";
import { contextCompactionFixture } from "./contextUsageFixture";

/**
 * 档位保存幂等性与显示态收敛的验收用例（2026-10-30 复审；2026-10-31 改为档位点击即写）。
 * 八类场景：
 * ① 丢响应后重复点档位仍只有原命令；② 按原命令重试逐字复用 ID 与载荷；
 * ③ 原命令其实已提交 → 查回执确认；④ 409 不留待核对、换基线再写；
 * ⑤ 明确失败收口后可重新开始；⑥ A 在途时切到 B，迟到结果不写进 B；
 * ⑦ 回执对不上不算生效；⑧ 投影追上让位覆盖层、外部改动必须显示出来。
 */

const baseUrl = "http://127.0.0.1:8787";
const workspaceId = "11111111-1111-4111-8111-111111111111";
const A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const client = new RelayApiClient({ baseUrl, workspaceId,
  bearerToken: "test-bearer-token-0123456789abcdef" });

let mounted: Awaited<ReturnType<typeof mountReact>> | null = null;

afterEach(() => { mounted?.unmount(); mounted = null; vi.unstubAllGlobals(); });

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status,
    headers: { "content-type": "application/json" } });
}

function usage(id: string, tokens: 262_144 | 524_288 | 1_048_576,
  revision: string): RelaySessionContextUsage {
  return { sessionId: id, budget: { tokens, revision },
    nextCall: { reservationTokens: tokens, contextBudgetTokens: tokens,
      providerWindowTokens: null, windowSource: "UNKNOWN" }, lastCall: null,
    compaction: contextCompactionFixture({ targetWindowTokens: tokens,
      effectiveWindowTokens: tokens }) };
}

function receipt(commandId: string, id: string, tokens: number, revision: string): Response {
  return json({ command_id: commandId, command_type: "SetSessionContextBudget",
    committed_at: "2026-10-30T00:00:00Z",
    result: { session_id: id, context_budget_tokens: tokens, revision } });
}

/** 回执查询的 URL 末段就是命令 ID，服务端按同一 ID 返回原回执。 */
function receiptFrom(url: string, id: string, tokens: number, revision: string): Response {
  return receipt(url.split("/").pop() ?? "", id, tokens, revision);
}

/** fetch 桩；返回这次用例里全部**写命令**的载荷账。 */
function stubFetch(respond: (url: string, method: string,
  body: Record<string, unknown>) => Response | Promise<Response>) {
  const writes: Record<string, unknown>[] = [];
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = (init?.method ?? "GET").toUpperCase();
    const body: Record<string, unknown> = init?.body === undefined
      ? {} : JSON.parse(String(init.body)) as Record<string, unknown>;
    if (method !== "GET") writes.push(body);
    return respond(url, method, body);
  }));
  return writes;
}

function panel(id: string, data: RelaySessionContextUsage | null,
  handlers: { readonly onSaved?: () => void; readonly onReload?: () => void } = {}) {
  return <ContextUsagePanel client={client} sessionId={id} sessionRevision="7"
    usage={data} loading={false} error={null} onReload={handlers.onReload ?? (() => {})}
    onSaved={handlers.onSaved ?? (() => {})} />;
}

async function open(id: string, data: RelaySessionContextUsage | null,
  handlers: { readonly onSaved?: () => void; readonly onReload?: () => void } = {}) {
  mounted = await mountReact(panel(id, data, handlers));
  await flush();
}

/** 父组件把权威投影读回来（或换到另一条会话）。 */
async function resync(id: string, data: RelaySessionContextUsage | null) {
  await mounted!.rerender(panel(id, data));
  await flush();
}

async function pick(tokens: 262_144 | 524_288 | 1_048_576) {
  // 点档位就是一次写：没有第二枚「保存」按钮。
  await mounted!.wrapper.get(`[data-testid="context-budget-option-${tokens}"]`).setValue(true);
  await flush();
}

async function click(testid: string) {
  await mounted!.wrapper.get(`[data-testid="${testid}"]`).trigger("click");
  await flush();
  await flush();
}

function textOf(testid: string): string {
  return mounted!.wrapper.get(`[data-testid="${testid}"]`).text();
}

function has(testid: string): boolean {
  return mounted!.wrapper.find(`[data-testid="${testid}"]`).exists();
}

describe("P0 幂等性：一次只允许一条未确认的写", () => {
  it("丢响应后重复点档位：账上仍只有原命令，选择器锁住", async () => {
    const writes = stubFetch((_url, method) => {
      if (method === "POST") throw new TypeError("Failed to fetch");
      return json({});
    });
    await open(A, usage(A, 524_288, "3"));
    await pick(1_048_576);
    await flush();
    expect(writes).toHaveLength(1);
    const commandId = String(writes[0]!.command_id);
    expect(textOf("context-budget-pending")).toContain(commandId);
    // 待核对期间单选组禁用：再点另一档不会发出第二条写命令。
    await pick(262_144);
    expect(writes, "待核对期间不得生成新命令").toHaveLength(1);
    expect(mounted!.wrapper.get('[data-testid="context-budget-option-262144"]')
      .attributes("disabled")).toBeDefined();
  });

  it("按原命令重试：ID、会话、档位、基线逐字相同", async () => {
    let down = true;
    const writes = stubFetch((_url, method, body) => {
      if (method !== "POST") return json({});
      if (down) throw new TypeError("Failed to fetch");
      return receipt(String(body.command_id), A, 1_048_576, "4");
    });
    await open(A, usage(A, 524_288, "3"));
    await pick(1_048_576);
    await flush();
    down = false;
    await click("context-budget-retry");
    expect(writes).toHaveLength(2);
    expect(writes[1], "重放必须与首写逐字相同").toEqual(writes[0]);
    expect(textOf("context-budget-notice")).toContain("原命令已重放");
    expect(has("context-budget-pending")).toBe(false);
  });

  it("原命令其实已提交：查回执就确认生效，不写第二遍", async () => {
    const writes = stubFetch((url, method) => {
      if (method === "POST") throw new TypeError("Failed to fetch");
      return receiptFrom(url, A, 1_048_576, "4");
    });
    const onSaved = vi.fn();
    await open(A, usage(A, 524_288, "3"), { onSaved });
    await pick(1_048_576);
    await flush();
    await click("context-budget-receipt");
    expect(textOf("context-budget-notice")).toContain("回执已核对");
    expect(has("context-budget-pending")).toBe(false);
    expect(writes, "查回执不算一次写").toHaveLength(1);
    expect(onSaved).toHaveBeenCalledTimes(1);
  });

  it("409：命令没被提交，不留待核对；重读后按新基线再写新命令", async () => {
    const writes = stubFetch((_url, method, body) => {
      if (method !== "POST") return json({});
      if (writes.length === 1)
        return json({ code: "REVISION_CONFLICT", detail: "档位已变化。",
          conflict: { expected_revision: "3", actual_revision: "7" } }, 409);
      return receipt(String(body.command_id), A, 1_048_576, "8");
    });
    const onReload = vi.fn();
    await open(A, usage(A, 524_288, "3"), { onReload });
    await pick(1_048_576);
    await flush();
    expect(textOf("context-budget-conflict")).toContain("已被其他操作改动");
    expect(has("context-budget-pending"), "409 不留待核对").toBe(false);
    expect(onReload).toHaveBeenCalledTimes(1);
    await resync(A, usage(A, 262_144, "7"));
    await pick(1_048_576);
    await flush();
    expect(writes).toHaveLength(2);
    expect(writes[1], "409 之后是新的一次写，不是重放").not.toEqual(writes[0]);
    expect(textOf("context-budget-notice")).toContain("已保存");
  });

  it("明确失败：说明原因并收口，之后可以重新发起一次新写", async () => {
    const writes = stubFetch((_url, method) => {
      if (method !== "POST") return json({});
      return json({ code: "VALIDATION_FAILED", detail: "档位取值不在允许范围。" }, 400);
    });
    await open(A, usage(A, 524_288, "3"));
    await pick(1_048_576);
    await flush();
    expect(textOf("context-usage-action-error").length).toBeGreaterThan(0);
    expect(has("context-budget-pending")).toBe(false);
    expect(writes).toHaveLength(1);
    // 失败后选择退回生效值，所以再点同一档仍然是一次新的写。
    await pick(1_048_576);
    expect(writes, "收口之后是新的一次写").toHaveLength(2);
  });
});

describe("P0 显示态按会话归属", () => {
  it("A 在途时切到 B：A 的迟到回执不写进 B，切回 A 仍在", async () => {
    const gate: { release: (() => void) | null } = { release: null };
    const writes = stubFetch(async (_url, method, body) => {
      if (method !== "POST") return json({});
      await new Promise<void>((resolve) => { gate.release = resolve; });
      return receipt(String(body.command_id), A, 1_048_576, "4");
    });
    await open(A, usage(A, 524_288, "3"));
    await pick(1_048_576);
    await flush();
    expect(writes).toHaveLength(1);
    await resync(B, usage(B, 262_144, "11"));
    gate.release?.();
    await flush();
    await flush();
    expect(has("context-budget-notice"), "A 的回执不得出现在 B").toBe(false);
    expect(has("context-budget-pending")).toBe(false);
    // B 的单选态仍按 B 自己的服务端档位（256K）；A 的待核对选择不得画过来。
    expect((mounted!.wrapper.get('[data-testid="context-budget-option-262144"]')
      .element as HTMLInputElement).checked).toBe(true);
    await resync(A, usage(A, 524_288, "3"));
    expect(textOf("context-budget-notice")).toContain("已保存");
  });
});

describe("P0 回执核对要与命令逐字对上", () => {
  it("回执写着别的档位：不算生效，继续待核对", async () => {
    const writes = stubFetch((url, method) => {
      if (method === "POST") throw new TypeError("Failed to fetch");
      return receiptFrom(url, A, 262_144, "9");
    });
    await open(A, usage(A, 524_288, "3"));
    await pick(1_048_576);
    await flush();
    await click("context-budget-receipt");
    expect(textOf("context-usage-action-error")).toContain("对不上");
    expect(has("context-budget-pending"), "核对不上就继续待核对").toBe(true);
    expect(writes).toHaveLength(1);
  });

  it("回执属于另一条会话：同样不算生效", async () => {
    const writes = stubFetch((url, method) => {
      if (method === "POST") throw new TypeError("Failed to fetch");
      return receiptFrom(url, B, 1_048_576, "4");
    });
    await open(A, usage(A, 524_288, "3"));
    await pick(1_048_576);
    await flush();
    await click("context-budget-receipt");
    expect(textOf("context-usage-action-error")).toContain("对不上");
    expect(has("context-budget-pending")).toBe(true);
    expect(writes).toHaveLength(1);
  });
});

describe("P1 显示态收敛", () => {
  const okSave = (_url: string, method: string, body: Record<string, unknown>) =>
    method === "POST" ? receipt(String(body.command_id), A, 1_048_576, "4") : json({});

  it("投影追上：覆盖层让位，显示服务端值", async () => {
    stubFetch(okSave);
    await open(A, usage(A, 524_288, "3"));
    await pick(1_048_576);
    await flush();
    await resync(A, usage(A, 1_048_576, "4"));
    expect((mounted!.wrapper.get('[data-testid="context-budget-option-1048576"]')
      .element as HTMLInputElement).checked).toBe(true);
  });

  it("外部改动必须显示出来：修订推进但值被别人写走，界面不顶旧值", async () => {
    stubFetch(okSave);
    await open(A, usage(A, 524_288, "3"));
    await pick(1_048_576);
    await flush();
    await resync(A, usage(A, 262_144, "4"));
    expect((mounted!.wrapper.get('[data-testid="context-budget-option-262144"]')
      .element as HTMLInputElement).checked).toBe(true);
  });

  it("待核对期间外部改动：选择器停在待核对档位，但状态行只承认最后确认生效的值", async () => {
    const writes = stubFetch((_url, method) => {
      if (method === "POST") throw new TypeError("Failed to fetch");
      return json({});
    });
    await open(A, usage(A, 524_288, "3"));
    await pick(1_048_576);
    await flush();
    await resync(A, usage(A, 262_144, "7"));
    expect(has("context-budget-pending"), "结果未决仍待核对").toBe(true);
    expect(textOf("context-usage-tier-state")).toContain("最后一次确认生效：256K");
    expect(textOf("context-usage-tier-state")).not.toContain("1024K");
    expect((mounted!.wrapper.get('[data-testid="context-budget-option-1048576"]')
      .element as HTMLInputElement).checked).toBe(true);
    expect(writes).toHaveLength(1);
  });
});
