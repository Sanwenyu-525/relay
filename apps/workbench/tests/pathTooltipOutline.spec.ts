import { describe, expect, it } from "vitest";
import { buildBubbleOutlinePath } from "../src/lib/pathTooltip";

/**
 * 回退按钮 Tooltip 一体化轮廓的几何契约（2026-10-25 重画）。
 *
 * 轮廓由 buildBubbleOutlinePath 的一条闭合 path 生成，这里锁四件事：
 *   1. 固定输入下的 path 逐字符稳定（golden，改动形状必须是有意的）；
 *   2. flip（气泡翻到锚点下方）是整幅绕盒中心垂直镜像，切线关系逐点保持；
 *   3. 尾巴水平中心恒等于气泡自身中心，与宽度无关——气泡被视口夹偏时也不挪尾巴；
 *   4. 窄气泡下尾巴根自动收窄、数值不产生 NaN/负半径。
 */

const PAD = 10;
const SW = 1;
const RADIUS = 8;
const HEIGHT = 40;

type Cmd = { readonly name: string; readonly nums: number[] };

function parsePath(d: string): Cmd[] {
  return d.split(/\s+(?=[A-Za-z])/).map((chunk) => ({
    name: chunk[0],
    nums: chunk.slice(1).split(/[ ,]+/).filter(Boolean).map(Number)
  }));
}

function normalize(d: string): string {
  return d.replace(/\s+/g, " ").trim();
}

/** 各命令里代表 y 坐标的下标（H/Z 没有 y）。 */
function isYIndex(name: string, index: number): boolean {
  if (name === "M") return index === 1;
  if (name === "V") return index === 0;
  if (name === "A") return index === 6;
  if (name === "C") return index % 2 === 1;
  return false;
}

describe("气泡一体化轮廓 path", () => {
  it("固定输入下逐字符稳定（含尾巴根/尖的每个坐标）", () => {
    const d = buildBubbleOutlinePath({ width: 200, height: HEIGHT, strokeWidth: SW, cornerRadius: RADIUS, flip: false });
    expect(normalize(d)).toBe(
      // 底边在尾巴处弯下去而不是断开：两条 C 的首控制点 y 与底边同高（水平切出），
      // 尾控制点 x 与尖端同 x（垂直进入圆弧）；尖端 2px 半圆；尾巴中心 110 = 10 + 200/2。
      "M 18.5 10.5 H 201.5 A 8 8 0 0 1 209.5 18.5 V 41.5 A 8 8 0 0 1 201.5 49.5"
      + " H 119 C 114 49.5, 112 54.5, 112 57"
      + " A 2 2 0 0 1 108 57"
      + " C 108 54.5, 106 49.5, 101 49.5"
      + " H 18.5 A 8 8 0 0 1 10.5 41.5 V 18.5 A 8 8 0 0 1 18.5 10.5 Z");
  });

  it("flip 是绕盒中心垂直镜像：坐标镜像、圆弧 sweep 反向", () => {
    const input = { width: 200, height: HEIGHT, strokeWidth: SW, cornerRadius: RADIUS };
    const base = parsePath(buildBubbleOutlinePath({ ...input, flip: false }));
    const flipped = parsePath(buildBubbleOutlinePath({ ...input, flip: true }));
    const boxHeight = HEIGHT + 2 * PAD;
    expect(base.map((c) => c.name)).toEqual(flipped.map((c) => c.name));
    base.forEach((cmd, commandIndex) => {
      const other = flipped[commandIndex];
      expect(other.nums).toHaveLength(cmd.nums.length);
      cmd.nums.forEach((value, i) => {
        if (cmd.name === "A" && i === 4) {
          expect(other.nums[i]).toBe(1 - value); // sweep 随镜像反向
        } else if (isYIndex(cmd.name, i)) {
          expect(other.nums[i]).toBeCloseTo(boxHeight - value, 6);
        } else {
          expect(other.nums[i]).toBeCloseTo(value, 6);
        }
      });
    });
  });

  it("尾巴中心恒等于气泡自身中心，与气泡宽度无关", () => {
    for (const width of [80, 137, 200, 357]) {
      const cx = PAD + width / 2;
      const cmds = parsePath(buildBubbleOutlinePath({
        width, height: HEIGHT, strokeWidth: SW, cornerRadius: RADIUS, flip: false
      }));
      const hValues = cmds.filter((c) => c.name === "H").map((c) => c.nums[0]);
      const curves = cmds.filter((c) => c.name === "C");
      // 尾巴右根 = 底边右段 H；左根 = 第二条 C 的终点 x。
      expect((hValues[1] + curves[1].nums[4]) / 2).toBeCloseTo(cx, 6);
      // 尖端圆弧两端（第一条 C 的终点与 2px 圆弧的终点）同样关于气泡中心对称。
      const arc = cmds.find((c) => c.name === "A" && c.nums[0] === 2);
      expect((curves[0].nums[4] + arc!.nums[5]) / 2).toBeCloseTo(cx, 6);
      // 气泡本体（最左/最右描边中心线）也关于中心对称：只收集 x 坐标，跳过圆弧的
      // 旋转角与两个 flag（否则 0/1 会混进极值）。
      const xs = cmds.flatMap((c) => c.name === "M" || c.name === "H" ? [c.nums[0]]
        : c.name === "A" ? [c.nums[5]] : c.name === "C" ? [c.nums[0], c.nums[2], c.nums[4]] : []);
      expect((Math.min(...xs) + Math.max(...xs)) / 2).toBeCloseTo(cx, 6);
    }
  });

  it("窄气泡收窄尾巴根且不产生 NaN 或负半径", () => {
    for (const width of [30, 12, 4]) {
      const d = buildBubbleOutlinePath({ width, height: HEIGHT, strokeWidth: SW, cornerRadius: RADIUS, flip: false });
      expect(d).not.toMatch(/NaN|Infinity/);
      const cx = PAD + width / 2;
      const cmds = parsePath(d);
      const hValues = cmds.filter((c) => c.name === "H").map((c) => c.nums[0]);
      const curves = cmds.filter((c) => c.name === "C");
      expect((hValues[1] + curves[1].nums[4]) / 2).toBeCloseTo(cx, 6);
      for (const cmd of cmds) {
        if (cmd.name === "A") {
          expect(cmd.nums[0]).toBeGreaterThanOrEqual(0);
          expect(cmd.nums[1]).toBeGreaterThanOrEqual(0);
        }
      }
    }
  });
});
