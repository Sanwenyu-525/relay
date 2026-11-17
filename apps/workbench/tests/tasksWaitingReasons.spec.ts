import { describe, expect, it } from "vitest";

import { reviewReasonText } from "../src/lib/labels";
import {
  blockedReasonDetail,
  blockedReasonSummary,
  isKnownWaitingReason,
  waitingReasonDetail,
  waitingReasonShort
} from "../src/lib/waitingReasons";

/** 服务端当前确实会写入 runs.wait_reason 的取值（2026-11-15 按 API 源码核验）。 */
const serverCodes = [
  "ACTION_APPROVAL_REQUIRED",
  "HUMAN_TOOL",
  "REPEATED_FAILURE",
  "PAUSED_BY_USER",
  "AWAITING_HUMAN_EVIDENCE",
  "CHECKER_UNAVAILABLE",
  "CORRECTION_BUDGET_EXHAUSTED",
  "UNCERTAIN_REQUIRES_HUMAN"
] as const;

describe("任务等待原因映射（集中一份读法）", () => {
  it("服务端每个实际写入的等待原因都有中文读法，不是原始码", () => {
    for (const code of serverCodes) {
      expect(isKnownWaitingReason(code)).toBe(true);
      const short = waitingReasonShort(code);
      expect(short).not.toBeNull();
      expect(short).not.toContain(code);
      // 行内短读法要能被单独读懂：至少两个汉字。
      expect((short ?? "").replace(/[^\u4e00-\u9fa5]/g, "").length).toBeGreaterThanOrEqual(2);
    }
  });

  it("不同原因不共用同一个模糊短语", () => {
    const shorts = serverCodes.map((code) => waitingReasonShort(code));
    expect(new Set(shorts).size).toBe(serverCodes.length);
  });

  it("验收类原因与验收页同一句话，不写第二套中文", () => {
    expect(waitingReasonDetail("CORRECTION_BUDGET_EXHAUSTED")).toBe(reviewReasonText("CORRECTION_BUDGET_EXHAUSTED"));
    expect(waitingReasonDetail("CHECKER_UNAVAILABLE")).toBe(reviewReasonText("CHECKER_UNAVAILABLE"));
  });

  it("未知原因保留原始码，并明说界面还没有对应说明", () => {
    expect(waitingReasonShort("SOMETHING_NEW")).toBe("等待原因未识别（SOMETHING_NEW）");
    const detail = waitingReasonDetail("SOMETHING_NEW");
    expect(detail).toContain("SOMETHING_NEW");
    expect(detail).toContain("当前界面还没有对应说明");
  });

  it("服务端没有记录原因时给确切兜底，不冒充已知原因", () => {
    expect(waitingReasonShort(null)).toBeNull();
  });

  it("阻塞原因分说前置任务与未解除阻塞，两种都有时并列", () => {
    expect(blockedReasonSummary([], [])).toBe("服务端未登记阻塞依据");
    expect(blockedReasonSummary(["a", "b"], [])).toBe("2 个前置任务未完成");
    expect(blockedReasonSummary([], ["c"])).toBe("1 个阻塞未解除");
    expect(blockedReasonSummary(["a"], ["c", "d"])).toBe("1 个前置任务未完成 · 2 个阻塞未解除");
  });

  it("阻塞的完整解释说明处理完才能开始；没有依据时不推断为没有阻塞", () => {
    expect(blockedReasonDetail([], [])).toContain("不能当作没有阻塞");
    expect(blockedReasonDetail(["a", "b"], [])).toContain("依赖完成前任务不能开始");
    expect(blockedReasonDetail([], ["c"])).toContain("解除前任务不能开始");
    expect(blockedReasonDetail(["a"], ["c"])).toContain("两类都处理完才具备开始条件");
  });
});
