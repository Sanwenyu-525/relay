import { afterEach, describe, expect, it } from "vitest";
import { applyMotionPreference, resolveMotionPreference, storeMotionPreference,
  storedMotionPreference, systemPrefersReducedMotion } from "../src/lib/motionPreference";

const STORAGE_KEY = "relay.motion";

function setReducedMotion(matches: boolean): void {
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    writable: true,
    value: (query: string) => ({
      matches: query.includes("prefers-reduced-motion") ? matches : false,
      media: query, addEventListener() { return undefined; }, removeEventListener() { return undefined; },
      addListener() { return undefined; }, removeListener() { return undefined; }, onchange: null, dispatchEvent: () => false
    })
  });
}

afterEach(() => {
  window.localStorage.removeItem(STORAGE_KEY);
  delete document.documentElement.dataset.motion;
});

describe("运行期动效偏好", () => {
  it("无本机选择时跟随系统「减少动态效果」", () => {
    setReducedMotion(false);
    expect(storedMotionPreference()).toBeNull();
    expect(systemPrefersReducedMotion()).toBe(false);
    expect(resolveMotionPreference()).toBe(true);

    setReducedMotion(true);
    expect(systemPrefersReducedMotion()).toBe(true);
    expect(resolveMotionPreference()).toBe(false);
  });

  it("本机显式开启覆盖系统的减少动态效果", () => {
    setReducedMotion(true);
    storeMotionPreference("on");
    expect(storedMotionPreference()).toBe("on");
    expect(resolveMotionPreference()).toBe(true);
  });

  it("本机显式关闭覆盖系统默认", () => {
    setReducedMotion(false);
    storeMotionPreference("off");
    expect(resolveMotionPreference()).toBe(false);
  });

  it("写回 <html data-motion> 供 CSS 读取，system 重新按系统解析", () => {
    setReducedMotion(false);
    expect(applyMotionPreference("off")).toBe(false);
    expect(document.documentElement.dataset.motion).toBe("off");
    expect(applyMotionPreference("on")).toBe(true);
    expect(document.documentElement.dataset.motion).toBe("on");

    storeMotionPreference("off");
    setReducedMotion(true);
    expect(applyMotionPreference("system")).toBe(false);
    expect(document.documentElement.dataset.motion).toBe("off");
  });

  it("存储不可用时按系统设置走，不抛出", () => {
    setReducedMotion(false);
    const original = Object.getOwnPropertyDescriptor(window.localStorage, "getItem");
    Object.defineProperty(window.localStorage, "getItem", {
      configurable: true, value: () => { throw new Error("storage blocked"); }
    });
    expect(storedMotionPreference()).toBeNull();
    expect(resolveMotionPreference()).toBe(true);
    if (original !== undefined) Object.defineProperty(window.localStorage, "getItem", original);
  });
});
