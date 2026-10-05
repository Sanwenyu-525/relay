import { describe, expect, it } from "vitest";
import { headTailCap } from "../src/components/RunToolTrajectoryPanel";

// 折叠算术是导出的纯函数：它决定用户看到哪几行，因此值得单独钉住。
describe("轨迹折叠算术", () => {
  it("超长结果保留头尾两半，并如实给出省略行数", () => {
    const cap = headTailCap(40, 8, false);
    expect(cap).toEqual({ headLines: 4, tailLines: 4, hiddenLines: 32 });
  });

  it("展开时不隐藏任何行", () => {
    expect(headTailCap(40, 8, true)).toEqual({ headLines: 40, tailLines: 0, hiddenLines: 0 });
  });

  it("行数不超过上限时不省略任何行", () => {
    const cap = headTailCap(5, 8, false);
    expect(cap.hiddenLines).toBe(0);
    // 头 4 行 + 尾 4 行在 5 行时会重叠：拼接前必须按去重后的实际行数取尾，
    // 否则第 1~3 行会在界面上各出现两次。
    const lines = Array.from({ length: 5 }, (_unused, index) => index);
    const head = lines.slice(0, Math.min(cap.headLines, lines.length));
    const tail = lines.slice(Math.max(head.length, lines.length - cap.tailLines));
    expect([...new Set([...head, ...tail])]).toEqual(lines);
  });

  it("空结果不产生负的省略行数", () => {
    expect(headTailCap(0, 8, false)).toEqual({ headLines: 0, tailLines: 0, hiddenLines: 0 });
  });
});
