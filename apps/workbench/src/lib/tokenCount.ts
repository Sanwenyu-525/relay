import type { RelayTokenUsage } from "../api/dtos/assist";

/**
 * Token 数量的展示口径（AGENT_LIVE_TOKEN_USAGE，2026-11-01）。
 *
 * 十进制缩写：1k = 1,000，1m = 1,000,000；最多一位小数，去掉无意义的 `.0`。
 * 全部运算使用原始整数，缩写只发生在展示的最后一刻——绝不拿 "5.4k" 参与累计。
 *
 * 边界按四舍五入后重新判定单位：999,950 → 1000.0k 实际显示为 `1m`，不会出现
 * `1000k`。具体格式与 Lobe 系列的 token 读数一致（小写 k/m）。
 */
export function formatTokenCount(value: number): string {
  if (!Number.isFinite(value) || value < 0) return "0";
  const whole = Math.trunc(value);
  if (whole < 1_000) return String(whole);
  if (whole < 1_000_000) {
    const inThousands = Math.round(whole / 100) / 10;
    if (inThousands >= 1_000) return formatMillions(whole);
    return `${trimDecimal(inThousands)}k`;
  }
  return formatMillions(whole);
}

function formatMillions(value: number): string {
  return `${trimDecimal(Math.round(value / 100_000) / 10)}m`;
}

function trimDecimal(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(1);
}

/** 本轮可展示的整数总量：输入 + 输出；任一未上报时用已知部分的加总作下界。 */
export function tokenUsageTotal(usage: RelayTokenUsage | null): number | null {
  if (usage === null) return null;
  const values = [usage.inputTokens, usage.outputTokens]
    .filter((value): value is number => value !== null);
  return values.length === 0 ? null : values.reduce((sum, value) => sum + value, 0);
}

/**
 * 回复底部的一行读数。状态决定符号，不能只凭「有数字」就写成精确值：
 *   * ESTIMATED → `≈`（实时估算）；
 *   * PARTIAL   → `≥` + 部分用量未知（有调用未确认，数字只是下界）；
 *   * CONFIRMED → 精确总量；
 *   * UNKNOWN / null → 生成中「统计中」、完成后「未上报」，绝不写 0。
 */
export function formatTokenUsageLine(usage: RelayTokenUsage | null,
  phase: "LIVE" | "FINAL"): string {
  const total = tokenUsageTotal(usage);
  if (usage === null || usage.state === "UNKNOWN" || total === null) {
    return phase === "LIVE" ? "Token 统计中" : "本轮 Token 未上报";
  }
  const count = formatTokenCount(total);
  if (usage.state === "ESTIMATED") return `本轮 ≈ ${count} tokens`;
  if (usage.state === "PARTIAL") return `本轮 ≥ ${count} tokens · 部分用量未知`;
  return `本轮 ${count} tokens`;
}

/**
 * 悬停详情：未经缩写的精确整数 + 结算状态。
 *
 * 估算参与时逐项标注「估算」，并说明这是下界/约算；缓存字段只在 Provider 真的
 * 上报过其中一项时出现，不为凑字段制造 `0`。
 */
export function formatTokenUsageDetail(usage: RelayTokenUsage | null): string | null {
  if (usage === null ||
      usage.inputTokens === null && usage.outputTokens === null) return null;
  const estimated = usage.state === "ESTIMATED" || usage.state === "PARTIAL";
  const exact = (value: number | null): string => value === null
    ? "未上报" : EXACT_NUMBER.format(value);
  const parts: string[] = [];
  // 只有一项有值时不把另一项伪装成已确认的 0。
  parts.push(usage.inputTokens !== null
    ? `输入 ${exact(usage.inputTokens)}${estimated ? "（含估算）" : ""}` : "输入 未上报");
  parts.push(usage.outputTokens !== null
    ? `输出 ${exact(usage.outputTokens)}${estimated ? "（含估算）" : ""}` : "输出 未上报");
  if (usage.cacheReadTokens !== null || usage.cacheCreationTokens !== null) {
    parts.push(`缓存读取 ${exact(usage.cacheReadTokens)}`);
    parts.push(`缓存创建 ${exact(usage.cacheCreationTokens)}`);
  }
  if (usage.settledCalls > 0) parts.push(`已结算 ${usage.settledCalls} 次调用`);
  if (usage.pendingCalls > 0) parts.push(`${usage.pendingCalls} 次调用进行中`);
  if (usage.missingUsageCalls > 0) parts.push(`${usage.missingUsageCalls} 次调用用量未确认`);
  parts.push(stateLabel(usage.state));
  return parts.join(" · ");
}

/** 精确整数统一按 en-US 分组（与页面其他等宽数字一致）；不手写千分位规则。 */
const EXACT_NUMBER = new Intl.NumberFormat("en-US");

function stateLabel(state: RelayTokenUsage["state"]): string {
  switch (state) {
    case "ESTIMATED": return "实时估算";
    case "PARTIAL": return "部分调用已确认";
    case "CONFIRMED": return "全部调用已确认";
    default: return "用量未知";
  }
}

/**
 * 旧服务端消息只有 `usage` 总量（没有调用次数与状态）时的展示回退。
 *
 * 不补造 settledCalls；输入/输出缺任一项仍按 PARTIAL，避免把「一半读数」说成精确值。
 */
export function legacyTokenUsage(usage: {
  readonly inputTokens: number | null;
  readonly outputTokens: number | null;
  readonly cacheReadTokens: number | null;
  readonly cacheCreationTokens: number | null;
}): RelayTokenUsage {
  const complete = usage.inputTokens !== null && usage.outputTokens !== null;
  const any = usage.inputTokens !== null || usage.outputTokens !== null;
  return { state: complete ? "CONFIRMED" : any ? "PARTIAL" : "UNKNOWN",
    inputTokens: usage.inputTokens, outputTokens: usage.outputTokens,
    cacheReadTokens: usage.cacheReadTokens, cacheCreationTokens: usage.cacheCreationTokens,
    settledCalls: 0, pendingCalls: 0, missingUsageCalls: complete || !any ? 0 : 1 };
}
