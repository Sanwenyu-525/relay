import { describe, expect, it } from "vitest";
import type { RelayAssistGenerationProgress, RelayAssistMessage } from "../src/api/dtos/assist";
import { generationStageDiagnostics, generationStageView } from "../src/lib/generationStage";

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

describe("延迟诊断", () => {
  it("区分已确认时长与尚未到达的区间", () => {
    const rows = generationStageDiagnostics(message({ generationProgress: progress() }));
    const byLabel = (label: string) => rows.find((row) => row.label === label)?.value;
    // 提交 → 请求登记：2 秒；首流尚未到达。
    expect(byLabel("提交 → 模型请求登记（含排队与准备）")).toBe("2s");
    expect(byLabel("模型请求 → 首个流事件")).toBe("尚未收到");
    expect(byLabel("首个流事件 → 首个正文")).toBe("尚未收到正文");
    expect(byLabel("首个正文 → 预览可见")).toBe("尚未写入预览");
  });

  it("首流、首正文、预览可见的区间分别按真实端点计算", () => {
    const rows = generationStageDiagnostics(message({
      generationProgress: progress({
        phase: "MODEL_OUTPUT",
        latestCall: {
          status: "STARTED",
          startedAt: "2026-11-01T07:00:00.000Z",
          firstStreamEventAt: "2026-11-01T07:00:01.000Z",
          firstTextDeltaAt: "2026-11-01T07:00:03.000Z",
          firstPreviewPersistedAt: "2026-11-01T07:00:03.400Z",
          settledAt: null,
        },
      }),
    }));
    const byLabel = (label: string) => rows.find((row) => row.label === label)?.value;
    expect(byLabel("模型请求 → 首个流事件")).toBe("1s");
    expect(byLabel("首个流事件 → 首个正文")).toBe("2s");
    expect(byLabel("首个正文 → 预览可见")).toBe("400ms");
  });

  it("没有领取时刻与前端绘制读数时如实标注，不混算时钟", () => {
    const rows = generationStageDiagnostics(message({ generationProgress: progress() }));
    expect(rows.find((row) => row.label === "Worker 领取时刻")?.value)
      .toContain("未记录");
    expect(rows.find((row) => row.label === "前端首次绘制延迟")?.value).toBe("本机未观测");
  });

  it("还没有调用行时只报未登记，不编造区间", () => {
    const rows = generationStageDiagnostics(message({
      generationProgress: { phase: "PREPARING_CONTEXT", callCount: 0, latestCall: null },
    }));
    expect(rows).toHaveLength(1);
    expect(rows[0]?.value).toContain("尚未登记");
  });
});
