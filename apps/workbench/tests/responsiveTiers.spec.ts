import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

// 2026-10-10 响应式收敛回写。
// 规则来源：docs/frontend/design-system.md §9.6 —— 宽度断点只允许四档语义值
// （breakpoint.medium 48rem / breakpoint.large 64rem / breakpoint.rail 80rem / breakpoint.wide 90rem），
// 写法统一 range 语法，禁止 .9375rem 补丁与 min/max 双触发。
// 本文件把该规则变成可执行守卫：新增一处遗留断点就红灯，收敛完成后全绿。
// 只读源码 CSS，不渲染页面；几何与溢出由 tests/browser 的真实 Chromium 用例核对。

const srcRoot = join(__dirname, "..", "src");
/** 四档语义断点，对应 design-tokens.json 的 breakpoint.*。 */
const tierRem = new Set([48, 64, 80, 90]);
/**
 * 只做「档位语义」守卫、暂不做「range 语法」归一的文件。
 * 2026-10-10：views/AssistView.css 属自然语言状态维护任务在途文件（另一 Agent 持有），
 * 本轮不改其写法；其中的 max-width: 64rem 档位本身合规。该文件 Owner 收敛后从本集合移除，
 * 守卫随即对其恢复语法检查。
 */
const syntaxDeferred = new Set(["views/AssistView.css"]);

function cssFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) return cssFiles(full);
    return full.endsWith(".css") ? [full] : [];
  });
}

interface Condition {
  readonly file: string;
  readonly line: number;
  readonly text: string;
}

function widthConditions(file: string): Condition[] {
  const text = readFileSync(file, "utf8");
  const found: Condition[] = [];
  // @media 条件里不会出现 "{"，取到第一个 "{" 即为完整条件；跨行条件按同样规则拼接。
  const pattern = /@media([^{]*)/gu;
  for (const match of text.matchAll(pattern)) {
    const before = text.slice(0, match.index);
    const line = before.split("\n").length;
    found.push({ file, line, text: match[0] });
  }
  return found;
}

function widthFeatures(condition: string): string[] {
  // 只校验宽度条件：高度断点（如 50rem/44rem 侧栏滚动档）另有语义，不在本规则内。
  // 混合条件按 and / 逗号拆开，只取含 width 的那几项，避免把高度值误判成宽度档位。
  const inner = condition.slice(condition.indexOf("(") + 1, condition.lastIndexOf(")"));
  return inner.split(/\s+and\s+|,/u).map((feature) => feature.trim())
    .filter((feature) => /(?:^|[\s(])(?:min-|max-)?width/ui.test(feature));
}

const files = cssFiles(srcRoot).map((file) => relative(srcRoot, file).replaceAll("\\", "/"));

describe("响应式断点收敛守卫（design-system §9.6）", () => {
  it("每个宽度断点都落在四档语义值上，没有 .9375rem 补丁、非档值与 min/max 双触发", () => {
    const offenders: string[] = [];
    for (const file of files) {
      for (const condition of widthConditions(join(srcRoot, file))) {
        const features = widthFeatures(condition.text);
        if (features.length === 0) continue;
        const where = `${file}:${condition.line}`;
        const part = features.join(" and ");
        if (part.includes("9375")) { offenders.push(`${where} 使用 .9375rem 补丁：${part}`); continue; }
        if (/min-width[\s\S]*max-width|max-width[\s\S]*min-width/u.test(part)) {
          offenders.push(`${where} min/max 双触发：${part}`); continue;
        }
        for (const match of part.matchAll(/(\d+(?:\.\d+)?)rem/gu)) {
          if (!tierRem.has(Number(match[1]))) {
            offenders.push(`${where} 非语义档宽度值 ${match[1]}rem：${part}`);
          }
        }
        if (/max-width/u.test(part) && !syntaxDeferred.has(file)) {
          offenders.push(`${where} 旧式 max-width 写法，应改 range 语法：${part}`);
        }
      }
    }
    expect(offenders, `遗留断点：\n${offenders.join("\n")}`).toEqual([]);
  });

  it("被守卫覆盖的源码 CSS 数量稳定，确认扫描范围没有静默缩小", () => {
    // 2026-10-10 基线：src 下 21 个 CSS 文件。文件被删除/移走时本计数提醒更新，
    // 避免守卫只剩个别文件却显示全绿。
    expect(files.length).toBeGreaterThanOrEqual(21);
  });
});
