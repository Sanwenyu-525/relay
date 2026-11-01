import type { JsonObject } from '../infrastructure/json.js';

/**
 * 会话回复的**Token 读数投影**（2026-11-01 AGENT-LIVE-TOKEN-USAGE）。
 *
 * 口径只有一个：一次用户请求的回复轮次 = 这条 assistant message 上全部 `PRIMARY`
 * 模型调用（含工具续轮）。真实用量来自 `model_calls` 的已结算行；生成过程中，当前
 * 在途调用只提供一份**可丢弃估算**，由预览行承载，绝不写进账本。
 *
 * 三条硬约束：
 *   * 同一 `call_id` 不会被「结算行 + 实时估算」重复累计——估算只在对应调用仍为
 *     STARTED 时参与，结算后账本优先；
 *   * 未上报的字段保持 null，不补 0；只有部分调用确认时状态是 PARTIAL，界面必须
 *     显示为下界而不是精确值；
 *   * 辅助外呼（记忆提取/压缩）由仓储查询的 `purpose='PRIMARY'` 排除，不混入本轮。
 */

export const ASSIST_USAGE_STATES = ['ESTIMATED', 'PARTIAL', 'CONFIRMED', 'UNKNOWN'] as const;
export type AssistUsageState = (typeof ASSIST_USAGE_STATES)[number];

/** `model_calls` 的一行只读计量摘要。 */
export interface AssistCallUsageRow {
  readonly id: string;
  readonly assist_message_id: string;
  readonly status: 'STARTED' | 'COMPLETED' | 'FAILED' | 'CANCELLED';
  readonly input_tokens: number | null;
  readonly output_tokens: number | null;
  readonly cache_read_tokens: number | null;
  readonly cache_creation_tokens: number | null;
}

/**
 * 当前在途调用的实时估算（预览行 `usage` 列的解析结果）。
 *
 * `provider*` 是 Provider 本次流里已经上报的字段；它为 null 时用估算值补位，
 * 因此状态仍是 ESTIMATED/PARTIAL，不会被当成已确认。
 */
export interface AssistLiveUsageEstimate {
  readonly callId: string;
  readonly inputTokensEstimate: number;
  readonly outputTokensEstimate: number;
  readonly providerInputTokens: number | null;
  readonly providerOutputTokens: number | null;
  readonly providerCacheReadTokens: number | null;
  readonly providerCacheCreationTokens: number | null;
}

export interface AssistUsageSummary {
  readonly state: AssistUsageState;
  readonly inputTokens: number | null;
  readonly outputTokens: number | null;
  readonly cacheReadTokens: number | null;
  readonly cacheCreationTokens: number | null;
  readonly settledCalls: number;
  readonly pendingCalls: number;
  readonly missingUsageCalls: number;
}

/** 生成中的估算进度落成预览行 JSON；键与读侧解析一一对应。 */
export function liveUsageEstimateJson(callId: string,
  progress: { readonly inputTokensEstimate: number; readonly outputTokensEstimate: number;
    readonly providerUsage: { readonly inputTokens: number | null;
      readonly outputTokens: number | null;
      readonly cacheReadTokens?: number | null;
      readonly cacheCreationTokens?: number | null } }): JsonObject {
  return { call_id: callId,
    input_tokens_estimate: progress.inputTokensEstimate,
    output_tokens_estimate: progress.outputTokensEstimate,
    provider_input_tokens: progress.providerUsage.inputTokens,
    provider_output_tokens: progress.providerUsage.outputTokens,
    provider_cache_read_tokens: progress.providerUsage.cacheReadTokens ?? null,
    provider_cache_creation_tokens: progress.providerUsage.cacheCreationTokens ?? null };
}

/** 解析预览行的估算；畸形或缺失一律当没有估算，不猜。 */
export function readLiveUsageEstimate(value: JsonObject | null | undefined):
AssistLiveUsageEstimate | undefined {
  if (value === null || value === undefined) return undefined;
  const callId = value.call_id;
  const inputTokensEstimate = readToken(value.input_tokens_estimate);
  const outputTokensEstimate = readToken(value.output_tokens_estimate);
  if (typeof callId !== 'string' || callId === '' ||
      inputTokensEstimate === null || outputTokensEstimate === null) return undefined;
  return { callId, inputTokensEstimate, outputTokensEstimate,
    providerInputTokens: readToken(value.provider_input_tokens),
    providerOutputTokens: readToken(value.provider_output_tokens),
    providerCacheReadTokens: readToken(value.provider_cache_read_tokens),
    providerCacheCreationTokens: readToken(value.provider_cache_creation_tokens) };
}

/**
 * 汇总一条回复轮次的用量读数。
 *
 * 累计只发生在原始整数上；界面负责缩写，投影不返回任何格式化字符串。
 */
export function projectAssistUsage(calls: readonly AssistCallUsageRow[],
  estimate?: AssistLiveUsageEstimate): AssistUsageSummary {
  let input: number | null = null;
  let output: number | null = null;
  let cacheRead: number | null = null;
  let cacheCreation: number | null = null;
  const add = (current: number | null, value: number | null): number | null =>
    value === null ? current : (current ?? 0) + value;

  let settledCalls = 0;
  let pendingCalls = 0;
  let missingUsageCalls = 0;
  for (const call of calls) {
    if (call.status === 'STARTED') { pendingCalls += 1; continue; }
    settledCalls += 1;
    // 一次调用只有输入与输出都上报才算完整；缺任一项都说明这一项用量未知。
    if (call.input_tokens === null || call.output_tokens === null) missingUsageCalls += 1;
    input = add(input, call.input_tokens);
    output = add(output, call.output_tokens);
    cacheRead = add(cacheRead, call.cache_read_tokens);
    cacheCreation = add(cacheCreation, call.cache_creation_tokens);
  }

  // 估算只对仍为 STARTED 的那次调用生效；对应行已结算/不存在时账本优先，忽略估算。
  const active = estimate === undefined ? undefined
    : calls.find((call) => call.id === estimate.callId && call.status === 'STARTED');
  if (estimate !== undefined && active !== undefined) {
    input = add(input, estimate.providerInputTokens ?? estimate.inputTokensEstimate);
    output = add(output, estimate.providerOutputTokens ?? estimate.outputTokensEstimate);
    cacheRead = add(cacheRead, estimate.providerCacheReadTokens);
    cacheCreation = add(cacheCreation, estimate.providerCacheCreationTokens);
  }

  const hasKnownValue = input !== null || output !== null;
  let state: AssistUsageState;
  if (!hasKnownValue) state = 'UNKNOWN';
  else if (estimate !== undefined && active !== undefined) {
    // 在途估算参与时永远不是 CONFIRMED：它还没进账本。
    state = settledCalls > 0 ? 'PARTIAL' : 'ESTIMATED';
  } else if (pendingCalls > 0 || missingUsageCalls > 0) state = 'PARTIAL';
  else state = 'CONFIRMED';

  return { state, inputTokens: input, outputTokens: output,
    cacheReadTokens: cacheRead, cacheCreationTokens: cacheCreation,
    settledCalls, pendingCalls,
    // 在途调用同样属于「尚未确认」：详情里要如实说还有几次调用没有结算用量。
    missingUsageCalls: missingUsageCalls + pendingCalls };
}

/** HTTP/SSE DTO 形状（snake_case）；null 保持 null，不变成 0。 */
export function assistUsageDto(summary: AssistUsageSummary): JsonObject {
  return { state: summary.state,
    input_tokens: summary.inputTokens, output_tokens: summary.outputTokens,
    cache_read_tokens: summary.cacheReadTokens,
    cache_creation_tokens: summary.cacheCreationTokens,
    settled_calls: summary.settledCalls, pending_calls: summary.pendingCalls,
    missing_usage_calls: summary.missingUsageCalls };
}

function readToken(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
    ? value : null;
}
