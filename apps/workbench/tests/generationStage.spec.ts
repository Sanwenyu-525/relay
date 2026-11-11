import { describe, expect, it } from "vitest";
import type { RelayAssistGenerationProgress, RelayAssistMessage } from "../src/api/dtos/assist";
import { generationStageView } from "../src/lib/generationStage";

function progress(patch: Partial<RelayAssistGenerationProgress> = {}): RelayAssistGenerationProgress {
  return {
    phase: "WAITING_MODEL",
    callCount: 1,
    latestCall: {
      status: "STARTED",
      startedAt: "2026-11-01T07:00:00.000Z",
      firstStreamEventAt: null,
      firstTextDeltaAt: null,
      firstPreviewPersistedAt: null,
      settledAt: null,
    },
    ...patch,
  };
}

function message(patch: Partial<RelayAssistMessage> = {}): Pick<RelayAssistMessage,
  "status" | "generationProgress" | "createdAt"> {
  return { status: "RUNNING", generationProgress: null,
    createdAt: "2026-11-01T06:59:58.000Z", ...patch };
}

describe("回复等待阶段文案", () => {
  it("PENDING 只说已提交、等待处理，不冒充正在生成", () => {
    expect(generationStageView(message({ status: "PENDING" })))
      .toEqual({ key: "AWAITING_WORKER", text: "等待处理" });
  });

  it("没有阶段读数时只回退到正在生成，不猜模型是否已响应", () => {
    expect(generationStageView(message())).toEqual({ key: "UNKNOWN", text: "正在生成" });
  });

  it("五档阶段各有独立文案", () => {
    const cases = [["PREPARING_CONTEXT", "正在准备上下文"],
      ["WAITING_MODEL", "等待模型响应"],
      ["MODEL_STREAMING", "模型已响应，等待正文"],
      ["MODEL_OUTPUT", "已收到模型输出，正在整理为回复"],
      ["PROCESSING", "正在处理模型返回结果"]] as const;
    for (const [phase, text] of cases) {
      expect(generationStageView(message({ generationProgress: progress({ phase }) })))
        .toEqual({ key: phase, text });
    }
  });

  it("终态不再有等待阶段", () => {
    expect(generationStageView(message({ status: "COMPLETED" }))).toBeNull();
    expect(generationStageView(message({ status: "FAILED" }))).toBeNull();
  });
});
