import { describe, expect, it } from "vitest";
import { RelayContractError } from "../src/api/core/errors";
import { assistMessageFrom } from "../src/api/parse/assist";
import { memoryFrom } from "../src/api/parse/information";

/**
 * origin 的兼容读法（ADR-030）。
 *
 * 旧数据没有 origin，必须读成「人工确认」；未知取值不能猜，要显式失败——
 * 把「自动记住」读成「人工确认」等于让模型替人签字，这是本片最不能出的错。
 */

const memoryId = "55555555-5555-4555-8555-555555555555";
const workspaceId = "11111111-1111-4111-8111-111111111111";

function memory(overrides: Record<string, unknown> = {}) {
  return { id: memoryId, project_id: null, title: "约定", status: "ACTIVE", revision: "1",
    current_version: "1", text: "需要留存的事实", confirmed_by: "local-user",
    confirmed_at: "2026-10-01T00:00:00.000Z", expires_at: null,
    created_at: "2026-10-01T00:00:00.000Z", updated_at: "2026-10-01T00:00:00.000Z", ...overrides };
}

function message(sources: readonly unknown[]) {
  return { id: "44444444-4444-4444-8444-444444444444", session_id: workspaceId, seq: "2",
    role: "ASSISTANT", status: "COMPLETED", intent: "DISCUSS", content: "回复", error_code: null,
    sources, usage: { input_tokens: null, output_tokens: null }, cancel_requested: false,
    steer_requested: false, attachments: [] };
}

describe("记忆 origin", () => {
  it("缺字段按人工确认读：旧数据没有自动捕获这个概念", () => {
    expect(memoryFrom(memory()).origin).toBe("HUMAN_CONFIRMED");
  });

  it("AUTO_CAPTURE 原样读出，供列表与详情标注", () => {
    expect(memoryFrom(memory({ origin: "AUTO_CAPTURE" })).origin).toBe("AUTO_CAPTURE");
    expect(memoryFrom(memory({ origin: "HUMAN_CONFIRMED" })).origin).toBe("HUMAN_CONFIRMED");
  });

  it("未知 origin 显式失败，不默认成人工确认", () => {
    expect(() => memoryFrom(memory({ origin: "MODEL_GUESS" }))).toThrow(RelayContractError);
  });
});

describe("消息来源 origin", () => {
  const base = { kind: "MEMORY", root_id: memoryId, version: "2",
    source_ref: `memory:${memoryId}:v2`, status: "AVAILABLE" };

  it("记忆来源缺 origin 读成未标注，不冒充人工确认", () => {
    // 2026-11-01 BUG-CHAT-CONTEXT-CROSS-TALK：旧消息来源记录没写 origin 只说明当时
    // 没有采集这一维；把它读成 HUMAN_CONFIRMED 等于替人签字。只有记录里明确的
    // HUMAN_CONFIRMED 才是人工确认。
    expect(assistMessageFrom(message([base])).sources[0]!.origin).toBeNull();
    expect(assistMessageFrom(message([{ ...base, origin: "AUTO_CAPTURE" }])).sources[0]!.origin)
      .toBe("AUTO_CAPTURE");
    expect(assistMessageFrom(message([{ ...base, origin: "HUMAN_CONFIRMED" }])).sources[0]!.origin)
      .toBe("HUMAN_CONFIRMED");
  });

  it("记忆来源类别原样保留，缺字段读成 null 而不是编一个", () => {
    for (const sourceKind of ["MANUAL", "USER_STATEMENT", "MODEL_OBSERVATION", "UNKNOWN"]) {
      expect(assistMessageFrom(message([{ ...base, source_kind: sourceKind }]))
        .sources[0]!.sourceKind).toBe(sourceKind);
    }
    expect(assistMessageFrom(message([base])).sources[0]!.sourceKind).toBeNull();
  });

  it("未知 source_kind 显式失败，不降级成任何已确认类别", () => {
    expect(() => assistMessageFrom(message([{ ...base, source_kind: "TOOL_OUTPUT" }])))
      .toThrow(RelayContractError);
  });

  it("资料与决定没有 origin 这一维，读成 null 而不是「人工确认」", () => {
    const knowledge = { kind: "KNOWLEDGE", root_id: memoryId, version: "1",
      source_ref: `knowledge:${memoryId}:v1`, status: "AVAILABLE" };
    expect(assistMessageFrom(message([knowledge])).sources[0]!.origin).toBeNull();
  });

  // BUG-CHAT-CONTEXT-CROSS-TALK：selection 是「手选 / 自动召回」的唯一判据，
  // 丢弃它会让自动召回的记忆在界面上显示成用户选的资料。
  it("自动召回的来源保留 selection 与判定依据，缺字段读成手选", () => {
    expect(assistMessageFrom(message([base])).sources[0]!.selection).toBeNull();
    expect(assistMessageFrom(message([{ ...base, selection: "AUTO_MEMORY",
      selection_basis: "LITERAL_MATCH" }])).sources[0]).toMatchObject({
      selection: "AUTO_MEMORY", selectionBasis: "LITERAL_MATCH" });
  });

  it("未知 selection 显式失败，不猜成手选资料", () => {
    expect(() => assistMessageFrom(message([{ ...base, selection: "RECENT" }]))).toThrow(RelayContractError);
  });
});
