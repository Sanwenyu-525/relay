import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { badgeLabel, drawBadge } from "../src/lib/taskbarBadge";

const host = vi.hoisted(() => ({
  isTauri: vi.fn(() => true),
  setOverlayIcon: vi.fn(async (_icon?: unknown) => undefined),
  newImage: vi.fn(async (_bytes?: unknown, _width?: number, _height?: number) => ({ rid: 7 })),
}));
vi.mock("@tauri-apps/api/core", () => ({ isTauri: host.isTauri }));
vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => ({ setOverlayIcon: host.setOverlayIcon }),
}));
vi.mock("@tauri-apps/api/image", () => ({ Image: { new: host.newImage } }));

const FONT = '"Segoe UI Variable Text", "Segoe UI Variable Display", "Segoe UI", system-ui, sans-serif';
type Ink = { left: number; right: number; ascent: number; descent: number };

/** 默认度量给一组真实量级：数字墨迹宽于/窄于 advance 且上下不对称，逼出按墨迹而不是文本盒居中。 */
function fakeContext(options: { ink?: Ink | "throw" } = {}) {
  const calls: string[] = [];
  const ink: Ink = options.ink ?? { left: 1, right: 1, ascent: 12, descent: 0 };
  const ctx = {
    fillStyle: "", font: "", textAlign: "", textBaseline: "",
    clearRect: () => calls.push("clearRect"),
    beginPath: () => calls.push("beginPath"),
    arc: (x: number, y: number, r: number) => calls.push(`arc:${x},${y},${r}`),
    closePath: () => calls.push("closePath"),
    fill: () => calls.push(`fill:${ctx.fillStyle}`),
    measureText: () => {
      if (options.ink === "throw") throw new TypeError("measureText unavailable");
      return {
        actualBoundingBoxLeft: ink.left, actualBoundingBoxRight: ink.right,
        actualBoundingBoxAscent: ink.ascent, actualBoundingBoxDescent: ink.descent,
      } as TextMetrics;
    },
    fillText: (text: string, x: number, y: number) =>
      calls.push(`fillText:${text}|${ctx.font}|${x.toFixed(3)},${y.toFixed(3)}`),
    getImageData: () => ({ data: new Uint8ClampedArray(32 * 32 * 4) }),
  };
  return { calls, ctx: ctx as unknown as CanvasRenderingContext2D };
}

afterEach(() => {
  host.isTauri.mockReturnValue(true);
  host.setOverlayIcon.mockReset().mockResolvedValue(undefined);
  host.newImage.mockReset().mockResolvedValue({ rid: 7 });
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("任务栏角标文案", () => {
  it("零与非法数量撤掉角标，一位与两位原样显示，三位以上收敛到 99+", () => {
    expect(badgeLabel(0)).toBeNull();
    expect(badgeLabel(-3)).toBeNull();
    expect(badgeLabel(Number.NaN)).toBeNull();
    expect(badgeLabel(1.9)).toBe("1");
    expect(badgeLabel(7)).toBe("7");
    expect(badgeLabel(9)).toBe("9");
    expect(badgeLabel(10)).toBe("10");
    expect(badgeLabel(42)).toBe("42");
    expect(badgeLabel(99)).toBe("99");
    expect(badgeLabel(100)).toBe("99+");
  });
});

describe("任务栏角标外形", () => {
  it("一位数画小圆盘：圆心 (18,18)、半径 12，墨迹右下缘收在画布 30 处留 2px 空气", () => {
    const { calls, ctx } = fakeContext();
    drawBadge(ctx, "7");
    expect(calls).toEqual([
      "clearRect",
      "beginPath", "arc:18,18,12", "arc:18,18,12", "closePath", "fill:#B9452F",
      `fillText:7|600 17.5px ${FONT}|18.000,24.000`,
    ]);
    expect(ctx.textBaseline).toBe("alphabetic");
    expect(ctx.textAlign).toBe("center");
    // 旧版圆盘 28px + 2px 白圈铺满整块画布；现在圆盘 24px，右/下各留 2px。
    expect(18 + 12).toBe(30);
    expect(18 - 12).toBe(6);
  });

  it("两位数换短胶囊：30×22、圆心 (15,19)，不拉成长药丸也不退回正圆", () => {
    const two = fakeContext();
    drawBadge(two.ctx, "42");
    expect(two.calls.slice(1, 6)).toEqual([
      "beginPath", "arc:11,19,11", "arc:19,19,11", "closePath", "fill:#B9452F",
    ]);
    expect(two.calls.at(-1)).toContain(`600 13.5px ${FONT}`);
    // 长宽比 30/22 ≈ 1.36，落在「短胶囊」区间；右/下缘同样收在 30。
    expect(15 + 15).toBe(30);
    expect(19 + 11).toBe(30);
  });

  it("三位数沿用两位数胶囊外形，只缩字号：不贴边、不裁切", () => {
    const capped = fakeContext();
    drawBadge(capped.ctx, "99+");
    expect(capped.calls.slice(1, 6)).toEqual([
      "beginPath", "arc:11,19,11", "arc:19,19,11", "closePath", "fill:#B9452F",
    ]);
    expect(capped.calls.at(-1)).toContain(`600 11px ${FONT}`);
  });

  it("只画一层底色：没有描边、没有白圈、没有渐变", () => {
    const single = fakeContext();
    drawBadge(single.ctx, "1");
    expect(single.calls.filter((call) => call.startsWith("fill:"))).toEqual(["fill:#B9452F"]);
    expect(single.calls.some((call) => call.startsWith("stroke"))).toBe(false);
    expect(single.calls.filter((call) => call === "closePath")).toHaveLength(1);
  });
});

describe("任务栏角标数字排布", () => {
  it("按墨迹居中：字面左右不对称时右移半个墨迹差，基线按上下墨迹拉平", () => {
    // 墨迹 left 5.2 / right 2.8（字面偏左）、上伸 12 下伸 1。
    const { calls, ctx } = fakeContext({ ink: { left: 5.2, right: 2.8, ascent: 12, descent: 1 } });
    drawBadge(ctx, "7");
    // dx = −(2.8 − 5.2)/2 = +1.2 → 18 + 1.2；dy = (12 − 1)/2 = 5.5 → 18 + 5.5。
    expect(calls.at(-1)).toBe(`fillText:7|600 17.5px ${FONT}|19.200,23.500`);
  });

  it("取不到墨迹包围盒时退回 cap-height 估值，仍然有确定落点", () => {
    const { calls, ctx } = fakeContext({ ink: "throw" });
    expect(() => drawBadge(ctx, "7")).not.toThrow();
    // 17.5 × 0.7 / 2 = 6.125 → 18 + 6.125。
    expect(calls.at(-1)).toBe(`fillText:7|600 17.5px ${FONT}|18.000,24.125`);
  });
});

describe("任务栏角标同步", () => {
  let syncTaskbarBadge: typeof import("../src/lib/taskbarBadge").syncTaskbarBadge;

  beforeEach(async () => {
    vi.resetModules();
    ({ syncTaskbarBadge } = await import("../src/lib/taskbarBadge"));
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockImplementation(() => fakeContext().ctx);
  });

  it("浏览器模式不碰宿主接口", async () => {
    host.isTauri.mockReturnValue(false);
    await syncTaskbarBadge(3);
    expect(host.setOverlayIcon).not.toHaveBeenCalled();
    expect(host.newImage).not.toHaveBeenCalled();
  });

  it("数量变化才重设角标，归零撤掉", async () => {
    await syncTaskbarBadge(2);
    await syncTaskbarBadge(2);
    expect(host.newImage).toHaveBeenCalledTimes(1);
    expect(host.setOverlayIcon).toHaveBeenCalledTimes(1);
    expect(host.newImage.mock.calls[0]![1]).toBe(32);
    expect(host.newImage.mock.calls[0]![2]).toBe(32);

    await syncTaskbarBadge(5);
    expect(host.setOverlayIcon).toHaveBeenCalledTimes(2);

    await syncTaskbarBadge(0);
    expect(host.setOverlayIcon).toHaveBeenLastCalledWith(undefined);
    expect(host.newImage).toHaveBeenCalledTimes(2);
  });

  it("宿主拒绝时只告警，不影响调用方轮询", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    host.setOverlayIcon.mockRejectedValueOnce(new Error("missing core:window:allow-set-overlay-icon"));
    await expect(syncTaskbarBadge(4)).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalledWith("taskbar_badge_failed", expect.any(Error));

    await syncTaskbarBadge(6);
    expect(host.setOverlayIcon).toHaveBeenCalledTimes(2);
  });
});
