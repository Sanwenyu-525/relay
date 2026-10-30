import { describe, expect, it } from "vitest";

import type { RequiredContextAudit } from "../src/api/resources/requiredContext";
import { classifyRiskAudit, confirmationApplies, firstSendPayload, intentSignature,
  isGateStale, riskScopeSignature } from "../src/lib/sendRiskGate";

/* 发送前预检的判定与失效规则（P0-C）。这些用例钉的是「读代码看不出问题」的三处：
 * 审计没有结论时会不会被当成安全、确认期间换了作用域或改了正文会不会沿用旧确认。 */

function audit(overrides: Record<string, unknown> = {}): RequiredContextAudit {
  return { state: "OK", severity: "SEVERE", fingerprint: "fp-1", files: [{ path: "AGENTS.md" }],
    budget: { requiredTotalShare: 0.7 }, reasons: [], suggestions: [], skipped: [],
    access: "OK", thresholds: {}, detail: "", ...overrides } as unknown as RequiredContextAudit;
}

const scope = { resourceId: "res-1", sessionId: null, model: "gpt-5", budgetTokens: 262144 };

describe("classifyRiskAudit", () => {
  it("没发过审计（没绑目录）时直接放行", () => {
    expect(classifyRiskAudit({ audit: null, failure: null, failureCode: null })).toEqual({ kind: "PROCEED" });
  });

  it("超时判为未知，不冒充安全", () => {
    const outcome = classifyRiskAudit({ audit: null, failure: "风险检查超时（6 秒）。", failureCode: "TIMEOUT" });
    expect(outcome.kind).toBe("UNKNOWN");
    if (outcome.kind === "UNKNOWN") {
      expect(outcome.code).toBe("TIMEOUT");
      expect(outcome.message).toContain("超时");
    }
  });

  it("请求失败（无 failureCode）也算未知", () => {
    const outcome = classifyRiskAudit({ audit: null, failure: "网络不可用", failureCode: null });
    expect(outcome.kind).toBe("UNKNOWN");
    if (outcome.kind === "UNKNOWN") expect(outcome.code).toBe("AUDIT_FAILED");
  });

  it.each(["NO_FILE_ACCESS", "SCAN_UNAVAILABLE"] as const)("%s 判为未知", (state) => {
    const outcome = classifyRiskAudit({ audit: audit({ state }), failure: null, failureCode: null });
    expect(outcome.kind).toBe("UNKNOWN");
    if (outcome.kind === "UNKNOWN") expect(outcome.code).toBe(state);
  });

  it("高风险与严重风险要求确认", () => {
    for (const severity of ["HIGH", "SEVERE"] as const) {
      expect(classifyRiskAudit({ audit: audit({ severity }), failure: null, failureCode: null }).kind)
        .toBe("CONFIRM");
    }
  });

  it("低风险或没有风险直接放行", () => {
    for (const severity of ["NONE", "NOTICE"] as const) {
      expect(classifyRiskAudit({ audit: audit({ severity }), failure: null, failureCode: null }).kind)
        .toBe("PROCEED");
    }
  });
});

describe("作用域与正文指纹", () => {
  it("模型、目录、会话、档位任一变化都换一个作用域指纹", () => {
    const base = riskScopeSignature(scope);
    expect(riskScopeSignature({ ...scope, model: "gpt-5-mini" })).not.toBe(base);
    expect(riskScopeSignature({ ...scope, resourceId: "res-2" })).not.toBe(base);
    expect(riskScopeSignature({ ...scope, sessionId: "s-1" })).not.toBe(base);
    expect(riskScopeSignature({ ...scope, budgetTokens: 524288 })).not.toBe(base);
    expect(riskScopeSignature({ ...scope })).toBe(base);
  });

  it("同一段正文换了模式就是另一次发送", () => {
    expect(intentSignature({ content: "做点什么", chatMode: null }))
      .not.toBe(intentSignature({ content: "做点什么", chatMode: "PLAN" }));
    expect(intentSignature({ content: "做点什么", chatMode: null }))
      .toBe(intentSignature({ content: "做点什么", chatMode: null }));
    expect(intentSignature({ content: "做点什么", chatMode: null }))
      .not.toBe(intentSignature({ content: "做点别的", chatMode: null }));
  });
});

describe("确认的有效期", () => {
  const confirmation = { fingerprint: "fp-1", scopeSignature: "a|b|c|d" };

  it("同一指纹 + 同一作用域才算已经确认过", () => {
    expect(confirmationApplies(confirmation, "a|b|c|d", "fp-1")).toBe(true);
    expect(confirmationApplies(confirmation, "a|b|c|e", "fp-1")).toBe(false);
    expect(confirmationApplies(confirmation, "a|b|c|d", "fp-2")).toBe(false);
    expect(confirmationApplies(null, "a|b|c|d", "fp-1")).toBe(false);
  });

  it("作用域或待发正文变了，旧确认就不代表这一次发送", () => {
    const gate = { scopeSignature: "s-1", payloadSignature: "p-1" };
    expect(isGateStale(gate, { scopeSignature: "s-1", payloadSignature: "p-1" })).toBe(false);
    expect(isGateStale(gate, { scopeSignature: "s-2", payloadSignature: "p-1" })).toBe(true);
    expect(isGateStale(gate, { scopeSignature: "s-1", payloadSignature: "p-2" })).toBe(true);
  });
});

describe("firstSendPayload（P0-2：预检前不改草稿）", () => {
  it("/plan 内容：发的是内容本身，模式随命令走", () => {
    expect(firstSendPayload("/plan 整理实验评价指标"))
      .toEqual({ content: "整理实验评价指标", chatMode: "PLAN" });
  });

  it("/goal 内容同理，不混到另一档", () => {
    expect(firstSendPayload("/goal 补齐验收基线"))
      .toEqual({ content: "补齐验收基线", chatMode: "GOAL" });
  });

  it("普通文本只去掉首尾空白，不在这里改写正文", () => {
    expect(firstSendPayload("  整理实验评价指标  "))
      .toEqual({ content: "整理实验评价指标", chatMode: null });
  });

  it("只写命令不写内容：原文保留，模式不预先生效", () => {
    expect(firstSendPayload("/plan")).toEqual({ content: "/plan", chatMode: null });
  });
});
