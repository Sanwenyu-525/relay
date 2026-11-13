/**
 * 投影断言：把 token 值与浏览器 computed style 都解析成可比较的结构，再逐项比对。
 *
 * 为什么不能直接比字符串：浏览器会把 `0 10px 32px rgb(30 57 37 / 0.055)` 归一化成
 * `rgba(30, 57, 37, 0.055) 0px 10px 32px 0px`（颜色提前、补零长度、rgb→rgba），
 * 字面量比较只会得到假失败。
 *
 * 为什么不能写成 `expect(actual).toBe(cond ? "none" : actual)`：后半句恒真，等于没有断言
 * （UI-UNIFY-01 遗留缺陷，UI-UNIFY-02 修复）。这里每一项都参与比较，并至少由
 * `tests/uiOverlays.spec.tsx` 的变异用例证明「改坏实现会失败」。
 */

export interface ParsedShadow {
  readonly inset: boolean;
  /** offsetX / offsetY / blur / spread，单位 px。 */
  readonly lengths: readonly number[];
  readonly color: { readonly r: number; readonly g: number; readonly b: number; readonly a: number } | null;
}

const NUMBER = /-?\d*\.?\d+/g;

function parseColor(text: string): ParsedShadow["color"] {
  const match = /rgba?\(([^)]+)\)/i.exec(text);
  if (match === null) return null;
  const parts = match[1]!.split(/[\s,/]+/).filter(Boolean).map(Number);
  if (parts.length < 3 || parts.some(Number.isNaN)) return null;
  return { r: parts[0]!, g: parts[1]!, b: parts[2]!, a: parts[3] ?? 1 };
}

function parseOne(text: string): ParsedShadow {
  const inset = /\binset\b/.test(text);
  const withoutColor = text.replace(/rgba?\([^)]*\)/gi, " ");
  const lengths = (withoutColor.match(NUMBER) ?? []).map(Number);
  return { inset, lengths, color: parseColor(text) };
}

/** 返回 null 表示 token 不是合法投影；空数组表示 none。 */
export function parseShadow(value: string): ParsedShadow[] | null {
  const text = value.trim();
  if (text === "" || text === "none") return [];
  // token 里的单个投影不嵌套逗号（颜色内部的逗号已经被 rgba() 包裹），按顶层逗号切分。
  const parts: string[] = [];
  let depth = 0;
  let current = "";
  for (const char of text) {
    if (char === "(") depth += 1;
    if (char === ")") depth -= 1;
    if (char === "," && depth === 0) { parts.push(current); current = ""; continue; }
    current += char;
  }
  parts.push(current);
  const parsed = parts.map(parseOne).filter((shadow) => shadow.lengths.length >= 2 || shadow.color !== null);
  return parsed.length === 0 ? null : parsed;
}

const near = (a: number, b: number) => Math.abs(a - b) < 0.01;

/** 逐项比较；返回不一致原因（字符串）或 null（一致）。 */
export function shadowMismatch(actual: string, tokenValue: string): string | null {
  const expected = parseShadow(tokenValue);
  if (expected === null) return `token 投影无法解析：${tokenValue}`;
  const received = parseShadow(actual);
  if (received === null) return `computed 投影无法解析：${actual}`;
  if (expected.length === 0) return received.length === 0 ? null : `token 为 none，元素却有投影：${actual}`;
  if (received.length === 0) return `token 有投影，元素却是 none（期望 ${tokenValue}）`;
  if (expected.length !== received.length) return `投影层数不同：期望 ${expected.length}，实际 ${received.length}`;
  for (let index = 0; index < expected.length; index += 1) {
    const want = expected[index]!;
    const got = received[index]!;
    if (want.inset !== got.inset) return `第 ${index + 1} 层 inset 不同`;
    // 浏览器补零到四段；token 可能只写 2–3 段，缺的按 0 比。
    const wantLengths = [0, 1, 2, 3].map((i) => want.lengths[i] ?? 0);
    const gotLengths = [0, 1, 2, 3].map((i) => got.lengths[i] ?? 0);
    if (wantLengths.some((value, i) => !near(value, gotLengths[i]!))) {
      return `第 ${index + 1} 层长度不同：期望 [${wantLengths.join(", ")}]，实际 [${gotLengths.join(", ")}]`;
    }
    if (want.color === null || got.color === null) continue;
    if (![want.color.r, want.color.g, want.color.b].every((value, i) => near(value, [got.color!.r, got.color!.g, got.color!.b][i]!))
      || !near(want.color.a, got.color.a)) {
      return `第 ${index + 1} 层颜色不同：期望 ${JSON.stringify(want.color)}，实际 ${JSON.stringify(got.color)}`;
    }
  }
  return null;
}

/** 供断言直接使用：一致返回 true；不一致返回原因，便于把原因带进失败信息。 */
export function shadowMatchesToken(actual: string, tokenValue: string): true | string {
  const mismatch = shadowMismatch(actual, tokenValue);
  return mismatch === null ? true : mismatch;
}
