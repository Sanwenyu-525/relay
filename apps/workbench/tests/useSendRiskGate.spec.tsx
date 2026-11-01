import { act, createElement } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { activateRelayConnection, liveClient, resetRelayConnectionForTest } from "../src/lib/relayConnection";
import type { SendSnapshot } from "../src/lib/sendRiskGate";
import { useSendRiskGate, type SendRiskGateController } from "../src/lib/useSendRiskGate";
import { flush, mountReact } from "./mountApp";

/**
 * 发送前预检的快照失效保护（P0-2，2026-10-31）。
 *
 * 这一层钉的是纯函数覆盖不到的部分：审计在途时事实变了会怎样。每条用例都只回答一件事——
 * 旧读数有没有被拿去发送。命令与正文不经过这里，所以「没有发送」= 没有任何 POST。
 */

const baseUrl = "http://127.0.0.1:8787";
const workspaceId = "11111111-1111-4111-8111-111111111111";
const resourceA = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const resourceB = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

function auditBody(severity: "NONE" | "SEVERE", fingerprint: string): unknown {
  return {
    state: "OK", detail: "1 份必读文件已计入预计加载量。",
    agent: { id: "relay", label: "Relay 内置 Agent" }, root: "D:\\Work\\Research",
    scanned_at: "2026-10-31T04:00:00.000Z", fingerprint, severity,
    files: severity === "NONE" ? [] : [{ path: "AGENTS.md", category: "TASK_REQUIRED", scope: "ROOT",
      reason: "项目规则入口", bytes: 540_000, estimated_tokens: 180_000,
      modified_at: "2026-10-31T03:59:00.000Z", share: 0.78, severity }],
    budget: { provider_window_tokens: 256_000, provider_window_known: true,
      call_budget_tokens: 256_000, call_budget_source: "WORKSPACE_TIER",
      effective_input_tokens: 231_000, effective_basis: "PROVIDER_WINDOW",
      reserves: { output_tokens: 8_192, system_prompt_tokens: 2_000,
        tool_definition_tokens: 4_096, history_tokens: 0 },
      estimated_total_input_tokens: 189_688, required_total_tokens: severity === "NONE" ? 0 : 180_000,
      required_total_share: severity === "NONE" ? 0 : 0.78, confidence: "EXACT_WINDOW",
      estimate: { method: "ESTIMATED_UTF8_BYTES_DIV_3", bytes_per_token: 3, note: "估算" } },
    reasons: [], suggestions: [], skipped: [], access: null,
    thresholds: { single_file: { notice: 0.15, high: 0.30, severe: 0.50 },
      total_files: { notice: 0.30, high: 0.50, severe: 0.75 } },
  };
}

function snapshot(overrides: { readonly resourceId?: string; readonly model?: string;
  readonly content?: string; readonly attachment?: string } = {}): SendSnapshot {
  return { scope: { resourceId: overrides.resourceId ?? resourceA, sessionId: null,
      model: overrides.model ?? "model-a", budgetTokens: 262_144 },
    intent: { content: overrides.content ?? "整理实验评价指标", chatMode: null,
      ...(overrides.attachment === undefined ? {} : { attachments: [overrides.attachment] }) } };
}

interface AuditCall { readonly resourceId: string; readonly model: string | null;
  readonly release: () => void }

/** 每次审计都挂住，由用例决定什么时候、按什么结论放行——这才测得出「在途时事实变了」。 */
function stubAudits(): { readonly calls: AuditCall[] } {
  const calls: AuditCall[] = [];
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
    const url = new URL(String(input));
    const match = /\/working-directories\/([^/]+)\/required-context-audit/u.exec(url.pathname);
    if (match === null) throw new Error(`unexpected request ${url.pathname}`);
    const model = url.searchParams.get("model");
    const severity = model === "model-b" || match[1] === resourceB ? "SEVERE" : "NONE";
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    calls.push({ resourceId: match[1] ?? "", model, release: () => {
      release();
    } });
    await gate;
    return new Response(JSON.stringify(auditBody(severity, `fp-${model ?? "none"}-${match[1] ?? ""}`)),
      { status: 200, headers: { "content-type": "application/json" } });
  }));
  return { calls };
}

const holder: { controller: SendRiskGateController | null } = { controller: null };

function Harness(): ReturnType<typeof createElement> {
  const risk = useSendRiskGate(liveClient());
  holder.controller = risk;
  return createElement("div", { "data-testid": "gate" },
    risk.gate === null ? "" : `${risk.gate.kind}:${risk.gate.code ?? ""}`);
}

async function mount(): Promise<{ unmount: () => void }> {
  activateRelayConnection({ baseUrl, workspaceId, bearerToken: "risk-gate-token" });
  const mounted = await mountReact(createElement(Harness));
  return { unmount: mounted.unmount };
}

afterEach(() => {
  resetRelayConnectionForTest();
  vi.unstubAllGlobals();
  holder.controller = null;
});

describe("预检期间事实变化（P0-2）", () => {
  it("模型在审计途中被切换：旧的低风险结果不放行，按新模型重查后才拦住", async () => {
    const audits = stubAudits();
    const { unmount } = await mount();
    const state = { snapshot: snapshot({ model: "model-a" }) };
    let outcome: Awaited<ReturnType<SendRiskGateController["check"]>> | null = null;
    await act(async () => {
      void holder.controller!.check(snapshot({ model: "model-a" }), () => state.snapshot)
        .then((value) => { outcome = value; });
    });
    expect(audits.calls).toHaveLength(1);
    // 审计还没回来就换了模型：旧读数只代表 model-a。
    state.snapshot = snapshot({ model: "model-b" });
    await act(async () => { audits.calls[0]!.release(); await flush(10); });
    // 第二次审计按新模型发出，且以高风险拦住——没有拿旧的低风险结果发送。
    expect(audits.calls).toHaveLength(2);
    expect(audits.calls[1]!.model).toBe("model-b");
    await act(async () => { audits.calls[1]!.release(); await flush(10); });
    expect(outcome).toEqual({ kind: "BLOCKED" });
    expect(holder.controller!.gate?.kind).toBe("CONFIRM");
    unmount();
  });

  it("目录在审计途中被切换：按新目录重查，放行的是新目录那份快照", async () => {
    const audits = stubAudits();
    const { unmount } = await mount();
    // 新目录在夹具里是 SEVERE；为了验证「放行的是新目录」，这里让新目录走 NONE。
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(String(input));
      const match = /\/working-directories\/([^/]+)\/required-context-audit/u.exec(url.pathname);
      if (match === null) throw new Error(`unexpected request ${url.pathname}`);
      audits.calls.push({ resourceId: match[1] ?? "", model: url.searchParams.get("model"),
        release: () => undefined });
      return new Response(JSON.stringify(auditBody("NONE", `fp-${match[1] ?? ""}`)),
        { status: 200, headers: { "content-type": "application/json" } });
    }));
    const state = { snapshot: snapshot({ resourceId: resourceA }) };
    const pending = act(async () => holder.controller!.check(snapshot({ resourceId: resourceA }),
      () => state.snapshot));
    state.snapshot = snapshot({ resourceId: resourceB });
    const outcome = await pending;
    expect(audits.calls.map((call) => call.resourceId)).toEqual([resourceA, resourceB]);
    expect(outcome.kind).toBe("SEND");
    if (outcome.kind === "SEND") expect(outcome.snapshot.scope.resourceId).toBe(resourceB);
    unmount();
  });

  it("正文或附件在审计途中变化：不沿用旧读数，按新载荷重查", async () => {
    const audits = stubAudits();
    const { unmount } = await mount();
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(String(input));
      const match = /\/working-directories\/([^/]+)\/required-context-audit/u.exec(url.pathname);
      if (match === null) throw new Error(`unexpected request ${url.pathname}`);
      audits.calls.push({ resourceId: match[1] ?? "", model: url.searchParams.get("model"),
        release: () => undefined });
      return new Response(JSON.stringify(auditBody("NONE", "fp-plain")),
        { status: 200, headers: { "content-type": "application/json" } });
    }));
    const state = { snapshot: snapshot({}) };
    const pending = act(async () => holder.controller!.check(snapshot({}), () => state.snapshot));
    state.snapshot = snapshot({ attachment: "baseline.png:2048:image/png" });
    const outcome = await pending;
    expect(audits.calls).toHaveLength(2);
    expect(outcome.kind).toBe("SEND");
    if (outcome.kind === "SEND") {
      expect(outcome.snapshot.intent.attachments).toEqual(["baseline.png:2048:image/png"]);
    }
    unmount();
  });

  it("连续双击：第二次直接拒绝，只发一次审计", async () => {
    const audits = stubAudits();
    const { unmount } = await mount();
    const state = { snapshot: snapshot({}) };
    let second: Awaited<ReturnType<SendRiskGateController["check"]>> | null = null;
    let first: Awaited<ReturnType<SendRiskGateController["check"]>> | null = null;
    await act(async () => {
      void holder.controller!.check(state.snapshot, () => state.snapshot)
        .then((value) => { first = value; });
      void holder.controller!.check(state.snapshot, () => state.snapshot)
        .then((value) => { second = value; });
    });
    expect(second).toEqual({ kind: "BLOCKED" });
    expect(audits.calls).toHaveLength(1);
    await act(async () => { audits.calls[0]!.release(); await flush(10); });
    expect(first!.kind).toBe("SEND");
    unmount();
  });

  it("迟到响应：调用方判定已失效（切换会话/卸载）时不放行、也不写屏上状态", async () => {
    const audits = stubAudits();
    const { unmount } = await mount();
    const state = { snapshot: snapshot({}) };
    let outcome: Awaited<ReturnType<SendRiskGateController["check"]>> | null = null;
    await act(async () => {
      void holder.controller!.check(state.snapshot, () => state.snapshot, () => false)
        .then((value) => { outcome = value; });
    });
    await act(async () => { audits.calls[0]!.release(); await flush(10); });
    expect(outcome).toEqual({ kind: "BLOCKED" });
    expect(holder.controller!.gate).toBeNull();
    unmount();
  });

  it("当前快照已经不能发（返回 null）时同样不放行", async () => {
    const audits = stubAudits();
    const { unmount } = await mount();
    let outcome: Awaited<ReturnType<SendRiskGateController["check"]>> | null = null;
    await act(async () => {
      void holder.controller!.check(snapshot({}), () => null)
        .then((value) => { outcome = value; });
    });
    await act(async () => { audits.calls[0]!.release(); await flush(10); });
    expect(outcome).toEqual({ kind: "BLOCKED" });
    unmount();
  });

  it("作用域本身无法确定（默认目录不可用）：不取审计，直接判风险未知", async () => {
    const audits = stubAudits();
    const { unmount } = await mount();
    const unknown: SendSnapshot = { ...snapshot({}), unknownReason: "默认目录当前不可用，风险未知。" };
    let outcome: Awaited<ReturnType<SendRiskGateController["check"]>> | null = null;
    await act(async () => {
      void holder.controller!.check(unknown, () => unknown).then((value) => { outcome = value; });
    });
    expect(outcome).toEqual({ kind: "BLOCKED" });
    expect(audits.calls).toHaveLength(0);
    expect(holder.controller!.gate?.code).toBe("SCOPE_UNKNOWN");
    expect(holder.controller!.gate?.message).toContain("默认目录当前不可用");
    unmount();
  });
});
