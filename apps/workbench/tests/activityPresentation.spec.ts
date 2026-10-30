import { describe, expect, it } from "vitest";
import type {
  RelayRunToolCall, RelayRunToolCalls, RelaySessionToolCall, RelaySessionToolCalls,
} from "../src/api/dtos/assist";
import {
  activityCategory, activityHeadline, activityHeaderState, activityItemsFromRunProjection,
  activityItemsFromSessionTrace,
  activityStateText, activitySummaryText, activityTargetOf, activityTone, activityVerb,
  formatActivityDuration, sessionActivityRounds, summarizeActivity, summarizeRunToolCalls,
  waitingOperationIds,
} from "../src/lib/activityPresentation";
import { detailOpenByDefault, mustShowActivity } from "../src/lib/activityDensity";

/**
 * 统一活动展示模型（2026-10-29 AI Response Experience V2 · 阶段 A）。
 *
 * 这里钉的不是「好看」，而是**状态语义不被展示层改写**：
 *   * REQUESTED / PREPARED 不是已执行，WAITING_APPROVAL 不是正在跑。
 *   * SETTLED 不等于成功；回执说失败时要另有一个失败标记。
 *   * REJECTED / ABANDONED / UNKNOWN 永远拿不到成功样式。
 *   * 重放与重复事件按行身份去重，不虚报步数。
 *   * 两套业务词表保持各自原样，不做 running/success/error 归一。
 */

const sessionId = "33333333-3333-4333-8333-333333333333";
const messageId = "44444444-4444-4444-8444-444444444444";

function sessionCall(overrides: Partial<RelaySessionToolCall> = {}): RelaySessionToolCall {
  return {
    id: "call-1", round: 0, ordinal: 0, toolName: "read_file", status: "SETTLED",
    args: { relative_path: "src/a.ts" }, rejectionReason: null, rejectionDetail: null,
    requestedAt: "2026-10-29T00:00:00.000Z", settledAt: "2026-10-29T00:00:01.500Z",
    ...overrides,
  };
}

function sessionTrace(rounds: readonly { round: number; calls: readonly RelaySessionToolCall[] }[]):
RelaySessionToolCalls {
  return { sessionId, messageId, messageStatus: "RUNNING", rounds };
}

function runCall(overrides: Partial<RelayRunToolCall> = {}): RelayRunToolCall {
  return {
    id: "run-call-1", round: 0, ordinal: 0, toolName: "run_check", status: "SETTLED",
    args: { check_id: "unit" }, argsSha256: "a".repeat(64), providerToolCallId: "p1",
    operationId: "op-1", adaptationOf: null, adaptedPath: null,
    resultRef: { content: "ok" }, createdAt: "2026-10-29T00:00:00.000Z",
    updatedAt: "2026-10-29T00:00:02.000Z", fileChanges: [],
    ...overrides,
  };
}

function runProjection(calls: readonly RelayRunToolCall[]): RelayRunToolCalls {
  return { runId: "run-a", runStatus: "RUNNING", waitReason: null,
    rounds: [{ round: 0, modelCallId: "m", calls }] };
}

describe("会话侧投影", () => {
  it("动作词与类别只做展示映射，取不到就原样回退工具名", () => {
    expect(activityVerb("read_file")).toBe("读取文件");
    expect(activityCategory("read_file")).toBe("READ");
    expect(activityVerb("browser_read_page")).toBe("读取网页");
    expect(activityCategory("browser_read_page")).toBe("BROWSER");
    expect(activityVerb("some_future_tool")).toBe("some_future_tool");
    expect(activityCategory("some_future_tool")).toBe("OTHER");
  });

  it("对象只取已知参数键，取不到不猜", () => {
    expect(activityTargetOf({ relative_path: "src/a.ts" })).toBe("src/a.ts");
    expect(activityTargetOf({ query: "claim" })).toBe("claim");
    expect(activityTargetOf({ unrelated: "x" })).toBe("");
    expect(activityTargetOf(null)).toBe("");
  });

  it("未结算的行不写成已执行，耗时按请求到结算计算", () => {
    const items = activityItemsFromSessionTrace(sessionTrace([{ round: 0, calls: [
      sessionCall({ id: "a" }),
      sessionCall({ id: "b", status: "REQUESTED", settledAt: null }),
    ] }]));
    expect(items[0].stateText).toBe("已结算");
    expect(items[0].elapsedMs).toBe(1_500);
    // 未结算：没有结算时刻就没有耗时，状态词也不能带「已」。
    expect(items[1].stateText).toBe("已请求，尚未结算");
    expect(items[1].elapsedMs).toBeNull();
    expect(items[1].tone).toBe("active");
  });

  it("被拒、放弃与未知都不是成功样式，且各自保留服务端原因", () => {
    const items = activityItemsFromSessionTrace(sessionTrace([{ round: 0, calls: [
      sessionCall({ id: "r", status: "REJECTED", rejectionReason: "OUTSIDE_SCOPE",
        rejectionDetail: "目标不在本次绑定的目录内。" }),
      sessionCall({ id: "a", status: "ABANDONED", settledAt: null }),
      sessionCall({ id: "u", status: "UNKNOWN", settledAt: null }),
    ] }]));
    expect(items.map((item) => item.tone)).toEqual(["negative", "negative", "negative"]);
    expect(items[0].detail.rejectionReason).toBe("OUTSIDE_SCOPE");
    expect(items[0].detail.rejectionDetail).toBe("目标不在本次绑定的目录内。");
    expect(items[2].stateText).toBe("结果未知，需核对");
  });

  it("重放与重复事件按行身份去重，不虚报步数", () => {
    const items = activityItemsFromSessionTrace(sessionTrace([
      { round: 0, calls: [sessionCall({ id: "dup" })] },
      { round: 1, calls: [sessionCall({ id: "dup" }), sessionCall({ id: "next" })] },
    ]));
    expect(items.map((item) => item.id)).toEqual(["dup", "next"]);
  });

  it("轮次分组以服务端的外层 rounds 为准，不按 call.round 重新切", () => {
    // 历史数据里 call.round 可能与外层分组不一致：按外层渲染，两轮都必须在。
    const rounds = sessionActivityRounds(sessionTrace([
      { round: 0, calls: [sessionCall({ id: "a", round: 0 })] },
      { round: 1, calls: [sessionCall({ id: "b", round: 0 })] },
    ]));
    expect(rounds).toHaveLength(2);
    expect(rounds[1].map((item) => item.id)).toEqual(["b"]);
  });
});

describe("Run 侧投影", () => {
  it("已结算但回执失败单独标记，不把整轮说成完成", () => {
    const items = activityItemsFromRunProjection(runProjection([
      runCall({ id: "failed", resultRef: { outcome: "FAILED", exitCode: 1 } }),
      runCall({ id: "ok", resultRef: { outcome: "COMPLETED", exitCode: 0 } }),
    ]));
    expect(items[0].detail.failed).toBe(true);
    expect(items[0].stateText).toBe("已结算但失败");
    expect(items[0].detail.exitCode).toBe(1);
    expect(items[1].detail.failed).toBe(false);
    expect(items[1].stateText).toBe("已结算");
  });

  it("等待批准是待决，不是正在执行", () => {
    const items = activityItemsFromRunProjection(runProjection([
      runCall({ id: "w", status: "WAITING_APPROVAL", resultRef: null }),
    ]));
    expect(items[0].tone).toBe("attention");
    expect(items[0].stateText).toBe("等待你批准");
    expect(items[0].stateText).not.toContain("执行中");
    expect(items[0].detail.operationId).toBe("op-1");
  });

  it("结果未提供与结果为空是两回事", () => {
    expect(activityStateText("SETTLED", "RUN_TOOL_CALL",
      { failed: false, resultText: null, reason: null })).toBe("已结算，结果未提供");
    expect(activityStateText("SETTLED", "RUN_TOOL_CALL",
      { failed: false, resultText: "ok", reason: null })).toBe("已结算");
  });

  it("截断、超时与取消只按服务端落到的键显示", () => {
    const items = activityItemsFromRunProjection(runProjection([
      runCall({ id: "t", resultRef: { content: "x", truncated: true, omitted_bytes: 2048 } }),
      runCall({ id: "d", resultRef: { content: "y", timed_out: true } }),
      runCall({ id: "c", resultRef: { content: "z", cancelled: true } }),
    ]));
    expect(items[0].detail.resultTruncated).toBe(true);
    expect(items[0].detail.omittedBytes).toBe(2048);
    expect(items[1].detail.timedOut).toBe(true);
    expect(items[2].detail.cancelled).toBe(true);
  });

  it("逐文件账本原样带进第三层，不被汇总改写", () => {
    const items = activityItemsFromRunProjection(runProjection([
      runCall({ id: "w", toolName: "apply_changeset", resultRef: { outcome: "COMPLETED" },
        fileChanges: [{ path: "src/a.ts", action: "MODIFY", status: "APPLIED", added: 3,
          removed: 1, unavailableReason: null }] }),
    ]));
    expect(items[0].detail.fileChanges).toHaveLength(1);
    expect(items[0].detail.fileChanges[0]).toMatchObject({ path: "src/a.ts", added: 3, removed: 1 });
  });
});

describe("活动摘要", () => {
  it("按动作词聚合，超过三类只报类数", () => {
    const items = activityItemsFromSessionTrace(sessionTrace([{ round: 0, calls: [
      sessionCall({ id: "1" }), sessionCall({ id: "2" }),
      sessionCall({ id: "3", toolName: "search_text", args: { query: "q" } }),
      sessionCall({ id: "4", toolName: "git_status", args: {} }),
      sessionCall({ id: "5", toolName: "run_check", args: { check_id: "c" } }),
    ] }]));
    const summary = summarizeActivity(items);
    expect(summary.total).toBe(5);
    expect(activitySummaryText(summary.verbs)).toBe("读取文件 2 次、搜索内容 1 次、查看 Git 状态 1 次、等 4 类");
  });

  it("四类状态分栏计数，不合并成一个「异常」", () => {
    const items = activityItemsFromSessionTrace(sessionTrace([{ round: 0, calls: [
      sessionCall({ id: "s" }),
      sessionCall({ id: "r", status: "REJECTED", rejectionReason: "X" }),
      sessionCall({ id: "u", status: "UNKNOWN", settledAt: null }),
      sessionCall({ id: "p", status: "REQUESTED", settledAt: null }),
    ] }]));
    const summary = summarizeActivity(items);
    expect(summary).toMatchObject({ total: 4, settled: 1, rejected: 1, unknown: 1, active: 1 });
  });

  it("标题行在途只报「正在做的那一件」，结算后才报整轮做过什么", () => {
    const running = activityItemsFromSessionTrace(sessionTrace([{ round: 0, calls: [
      sessionCall({ id: "done" }),
      sessionCall({ id: "now", toolName: "list_directory", args: { relative_path: "src" },
        status: "REQUESTED", settledAt: null }),
    ] }]));
    expect(activityHeadline({ summary: summarizeActivity(running), inFlight: true,
      awaitingWorker: false, currentVerb: running[1].verb })).toBe("正在列目录");
    // 已提交但 Worker 尚未领取：不是「正在处理」。
    expect(activityHeadline({ summary: summarizeActivity([]), inFlight: true,
      awaitingWorker: true })).toBe("等待处理");
    expect(activityHeadline({ summary: summarizeActivity([]), inFlight: true,
      awaitingWorker: false })).toBe("正在处理");
    expect(activityHeadline({ summary: summarizeActivity(running), inFlight: false,
      awaitingWorker: false })).toBe("读取文件 1 次、列目录 1 次");
  });

  it("Run 侧分类计数保持既有口径：失败的检查同时进「检查次数」与「失败数」", () => {
    const counts = summarizeRunToolCalls(runProjection([
      runCall({ id: "c1", resultRef: { outcome: "FAILED", exitCode: 1 } }),
      runCall({ id: "c2", resultRef: { outcome: "COMPLETED", exitCode: 0 } }),
      runCall({ id: "w", toolName: "apply_changeset", resultRef: { outcome: "COMPLETED" } }),
      runCall({ id: "r", toolName: "read_file", resultRef: { content: "x" } }),
      runCall({ id: "p", toolName: "apply_changeset", status: "PREPARED", resultRef: null }),
      runCall({ id: "n", toolName: "read_file", resultRef: null }),
    ]));
    expect(counts).toMatchObject({ checks: 2, failed: 1, writes: 1, reads: 1, running: 1,
      unavailable: 1, waiting: 0 });
  });

  it("等待批准的动作身份按 operation_id 对齐，未知操作不进集合", () => {
    const projection: RelayRunToolCalls = { runId: "run-a", runStatus: "RUNNING", waitReason: null,
      rounds: [{ round: 0, modelCallId: "m", calls: [
        runCall({ id: "w1", status: "WAITING_APPROVAL", operationId: "op-b", resultRef: null }),
        runCall({ id: "w2", status: "WAITING_APPROVAL", operationId: "op-a", resultRef: null }),
        runCall({ id: "w3", status: "WAITING_APPROVAL", operationId: null, resultRef: null }),
        runCall({ id: "s", status: "SETTLED", operationId: "op-z" }),
      ] }] };
    expect(waitingOperationIds(projection)).toBe("op-a,op-b");
  });
});

describe("视觉档与密度", () => {
  it("只有待决与例外拿 attention/negative；已结算一律中性", () => {
    expect(activityTone("REQUESTED")).toBe("active");
    expect(activityTone("PREPARED")).toBe("active");
    expect(activityTone("WAITING_APPROVAL")).toBe("attention");
    expect(activityTone("REJECTED")).toBe("negative");
    expect(activityTone("ABANDONED")).toBe("negative");
    expect(activityTone("UNKNOWN")).toBe("negative");
    expect(activityTone("SETTLED")).toBe("neutral");
  });

  it("简洁档不得隐藏审批、被拒与失败，只折掉正常完成的行", () => {
    expect(mustShowActivity("attention", false)).toBe(true);
    expect(mustShowActivity("negative", false)).toBe(true);
    expect(mustShowActivity("neutral", true)).toBe(true);
    expect(mustShowActivity("neutral", false)).toBe(false);
    // 在途行在简洁档也不隐藏：那是「现在在做什么」，不是历史细节。
    expect(mustShowActivity("active", false)).toBe(false);
  });

  it("第三层只在详细档默认展开", () => {
    expect(detailOpenByDefault("concise")).toBe(false);
    expect(detailOpenByDefault("standard")).toBe(false);
    expect(detailOpenByDefault("detailed")).toBe(true);
  });

  it("耗时文本按量级切换，不把 900ms 说成 1 秒", () => {
    expect(formatActivityDuration(null)).toBe("");
    expect(formatActivityDuration(900)).toBe("900ms");
    expect(formatActivityDuration(1_500)).toBe("1.5s");
    expect(formatActivityDuration(65_000)).toBe("1m05s");
  });
});


/**
 * 标题行状态矩阵（2026-10-30 验收整改）。
 *
 * V3 首版的真实缺陷：在途消息读到零条记录时被判成 EMPTY，界面上写「本轮没有调用工具」——
 * 而模型此刻随时可能开始调用。零记录在「还没跑完」与「已经跑完」两个时刻含义完全不同，
 * 这里把六种容易被混为一谈的情况逐条钉住：
 *   * 在途 + 零记录 ≠ 已完成 + 零记录（前者是 RUNNING_NO_TOOLS，后者才是 EMPTY）。
 *   * 未读取 ≠ 已读取（IDLE 只说「展开查看」，不预判有没有工具）。
 *   * 读取失败压过在途（ERROR 优先，不能说成「没有工具」）。
 *   * 在途压过例外（有被拒的调用时整轮并没有结束）。
 *   * SETTLED 只是「都结清了」，tone 不能是 success。
 */
describe("标题行状态矩阵", () => {
  const settledOne = { total: 1, active: 0, waiting: 0, rejected: 0, unknown: 0, settled: 1,
    failed: 0, verbs: [["读取文件", 1] as const] };
  const none = { total: 0, active: 0, waiting: 0, rejected: 0, unknown: 0, settled: 0,
    failed: 0, verbs: [] as const };

  it("在途且零记录：不是「没有调用工具」，只是还没开始调", () => {
    const running = activityHeaderState({ loaded: true, error: false, inFlight: true, summary: none });
    expect(running.phase).toBe("RUNNING_NO_TOOLS");
    expect(running.tone).toBe("running");
    expect(running.meta).toBe("正在执行");
    expect(running.meta).not.toContain("没有调用工具");
    // 还没读到时同样是「还没开始」，而不是结论。
    expect(activityHeaderState({ loaded: false, error: false, inFlight: true, summary: none }).phase)
      .toBe("RUNNING_NO_TOOLS");
    // PENDING：已提交、Worker 尚未领取，比「正在执行」更早一档。
    expect(activityHeaderState({ loaded: false, error: false, inFlight: true,
      awaitingWorker: true, summary: none }).meta).toBe("等待处理");
  });

  it("已结束且零记录：这才是「本轮没有调用工具」", () => {
    const done = activityHeaderState({ loaded: true, error: false, inFlight: false, summary: none });
    expect(done.phase).toBe("EMPTY");
    expect(done.meta).toBe("本轮没有调用工具");
    expect(done.tone).toBe("neutral");
  });

  it("未读取且不在跑：只说「展开查看」，不预判有没有工具", () => {
    const idle = activityHeaderState({ loaded: false, error: false, inFlight: false, summary: none });
    expect(idle.phase).toBe("IDLE");
    expect(idle.meta).toBe("展开查看");
  });

  it("读取失败压过在途：不能说成「没有工具」", () => {
    expect(activityHeaderState({ loaded: false, error: true, inFlight: true, summary: none }).phase)
      .toBe("ERROR");
    expect(activityHeaderState({ loaded: true, error: true, inFlight: false, summary: settledOne }).phase)
      .toBe("ERROR");
  });

  it("在途压过例外：出现被拒的调用之后整轮并没有结束", () => {
    const mixed = { ...settledOne, total: 2, rejected: 1, settled: 1 };
    expect(activityHeaderState({ loaded: true, error: false, inFlight: true, summary: mixed }).phase)
      .toBe("RUNNING");
  });

  it("已结束的例外分档：失败 / 未执行 / 待核对 / 等批准各自独立", () => {
    const failed = activityHeaderState({ loaded: true, error: false, inFlight: false,
      summary: { ...settledOne, failed: 1 } });
    expect([failed.phase, failed.tone]).toEqual(["FAILED", "danger"]);
    const rejected = activityHeaderState({ loaded: true, error: false, inFlight: false,
      summary: { ...settledOne, total: 2, rejected: 1 } });
    expect([rejected.phase, rejected.tone]).toEqual(["REJECTED", "danger"]);
    const unknown = activityHeaderState({ loaded: true, error: false, inFlight: false,
      summary: { ...settledOne, unknown: 1 } });
    expect([unknown.phase, unknown.tone]).toEqual(["UNKNOWN", "attention"]);
    const waiting = activityHeaderState({ loaded: true, error: false, inFlight: false,
      summary: { ...settledOne, waiting: 1 } });
    expect([waiting.phase, waiting.tone]).toEqual(["WAITING", "attention"]);
    expect(waiting.meta).toContain("等待你的批准");
  });

  it("全部结算：tone 是 settled 而不是 success——结清不等于成功", () => {
    const done = activityHeaderState({ loaded: true, error: false, inFlight: false, summary: settledOne });
    expect(done.phase).toBe("SETTLED");
    expect(done.tone).toBe("settled");
    expect(done.tone).not.toBe("success");
    expect(done.meta).toBe("1 项操作 · 已结束");
    expect(done.meta).not.toContain("成功");
    expect(done.meta).not.toContain("通过");
  });

  it("没有任何相位会宣布 success：会话账本里没有验证证据", () => {
    const phases = [
      activityHeaderState({ loaded: false, error: true, inFlight: false, summary: none }),
      activityHeaderState({ loaded: false, error: false, inFlight: false, summary: none }),
      activityHeaderState({ loaded: true, error: false, inFlight: false, summary: none }),
      activityHeaderState({ loaded: true, error: false, inFlight: true, summary: none }),
      activityHeaderState({ loaded: true, error: false, inFlight: true, summary: settledOne }),
      activityHeaderState({ loaded: true, error: false, inFlight: false, summary: settledOne }),
      activityHeaderState({ loaded: true, error: false, inFlight: false, summary: { ...settledOne, failed: 1 } }),
      activityHeaderState({ loaded: true, error: false, inFlight: false, summary: { ...settledOne, total: 2, rejected: 1 } }),
      activityHeaderState({ loaded: true, error: false, inFlight: false, summary: { ...settledOne, unknown: 1 } }),
      activityHeaderState({ loaded: true, error: false, inFlight: false, summary: { ...settledOne, waiting: 1 } })
    ];
    expect(phases.some((state) => state.tone === "success")).toBe(false);
    expect(new Set(phases.map((state) => state.phase)).size).toBeGreaterThanOrEqual(9);
  });
});
