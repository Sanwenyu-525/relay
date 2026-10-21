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

function fakeContext() {
  const calls: string[] = [];
  const ctx = {
    fillStyle: "", font: "", textAlign: "", textBaseline: "",
    clearRect: () => calls.push("clearRect"),
    beginPath: () => calls.push("beginPath"),
    arc: (x: number, y: number, r: number) => calls.push(`arc:${x},${y},${r}`),
    closePath: () => calls.push("closePath"),
    fill: () => calls.push(`fill:${ctx.fillStyle}`),
    fillText: (text: string, _x: number, y: number) => calls.push(`fillText:${text}|${ctx.font}|${y.toFixed(2)}`),
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
    expect(badgeLabel(9)).toBe("9");
    expect(badgeLabel(42)).toBe("42");
    expect(badgeLabel(100)).toBe("99+");
  });

  it("一条细边打底，一位数画圆盘、多位数画胶囊，数字按视觉居中落基线", () => {
    const { calls, ctx } = fakeContext();
    drawBadge(ctx, "7");
    expect(calls).toEqual([
      "clearRect",
      "beginPath", "arc:16,16,15", "arc:16,16,15", "closePath", "fill:#FBFCFA",
      "beginPath", "arc:16,16,14", "arc:16,16,14", "closePath", "fill:#BE3E2C",
      'fillText:7|700 22px "Segoe UI Variable Display", "Segoe UI", system-ui, sans-serif|23.70',
    ]);
    expect(ctx.textBaseline).toBe("alphabetic");

    const two = fakeContext();
    drawBadge(two.ctx, "42");
    expect(two.calls.slice(1, 11)).toEqual([
      "beginPath", "arc:14,16,14", "arc:18,16,14", "closePath", "fill:#FBFCFA",
      "beginPath", "arc:14,16,13", "arc:18,16,13", "closePath", "fill:#BE3E2C",
    ]);
    expect(two.calls.at(-1)).toBe(
      'fillText:42|700 20px "Segoe UI Variable Display", "Segoe UI", system-ui, sans-serif|23.00',
    );

    const capped = fakeContext();
    drawBadge(capped.ctx, "99+");
    expect(capped.calls.at(-1)).toBe(
      'fillText:99+|700 13px "Segoe UI Variable Display", "Segoe UI", system-ui, sans-serif|20.55',
    );
    // 三位数的描边已经横向贴满画布，钉住左半圆防止再往宽处走。
    expect(capped.calls[2]!).toBe("arc:12,16,12");
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
