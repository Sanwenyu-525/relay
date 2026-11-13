import { describe, expect, it } from "vitest";
import { parseShadow, shadowMatchesToken } from "./uiShadowAssert";

/**
 * 投影断言的变异验证。
 *
 * 上一轮的断言在「token 说有投影」分支里与自身比较，恒真；这里逐项证明：
 * 一致时通过，任一字段（层数 / inset / 偏移 / 模糊 / 颜色 / alpha）被改坏都会失败。
 * 这类测试不依赖浏览器，跑在默认 Vitest 套件里，改坏 helper 会立刻红。
 */

const SURFACE = "0 10px 32px rgb(30 57 37 / 0.055)";
const NORMALIZED = "rgba(30, 57, 37, 0.055) 0px 10px 32px 0px";

describe("parseShadow", () => {
  it("none 解析为空数组，单层投影解析出长度与颜色", () => {
    expect(parseShadow("none")).toEqual([]);
    expect(parseShadow(NORMALIZED)).toEqual([{
      inset: false,
      lengths: [0, 10, 32, 0],
      color: { r: 30, g: 57, b: 37, a: 0.055 }
    }]);
    expect(parseShadow("inset 0 0 0 2px rgb(1 2 3)")?.[0]?.inset).toBe(true);
  });

  it("token 与浏览器归一化写法可以互相比较", () => {
    expect(shadowMatchesToken(NORMALIZED, SURFACE)).toBe(true);
    expect(shadowMatchesToken("rgba(32, 61, 40, 0.13) 0px 14px 44px 0px", "0 14px 44px rgb(32 61 40 / 0.13)")).toBe(true);
  });
});

describe("shadowMatchesToken 变异验证", () => {
  it("token 为 none：元素有投影必须失败，元素也无投影才通过", () => {
    expect(shadowMatchesToken("none", "none")).toBe(true);
    expect(shadowMatchesToken("rgba(0, 0, 0, 0.1) 0px 0px 0px 1px", "none")).toMatch(/none/);
  });

  it("token 有投影：元素 none、模糊值不同、颜色不同、alpha 不同都必须失败", () => {
    expect(shadowMatchesToken("none", SURFACE)).toMatch(/none/);
    expect(shadowMatchesToken("rgba(30, 57, 37, 0.055) 0px 10px 24px 0px", SURFACE)).toMatch(/长度不同/);
    expect(shadowMatchesToken("rgba(30, 57, 37, 0.055) 4px 10px 32px 0px", SURFACE)).toMatch(/长度不同/);
    expect(shadowMatchesToken("rgba(0, 0, 0, 0.055) 0px 10px 32px 0px", SURFACE)).toMatch(/颜色不同/);
    expect(shadowMatchesToken("rgba(30, 57, 37, 0.2) 0px 10px 32px 0px", SURFACE)).toMatch(/颜色不同/);
    expect(shadowMatchesToken("rgba(30, 57, 37, 0.055) 0px 10px 32px 0px inset", SURFACE)).toMatch(/inset/);
  });

  it("层数不同也必须失败", () => {
    expect(shadowMatchesToken("rgba(30, 57, 37, 0.055) 0px 10px 32px 0px, rgba(0, 0, 0, 0.1) 0px 0px 1px 0px", SURFACE)).toMatch(/层数/);
  });
});
