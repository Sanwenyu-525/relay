import type { AssistGenerationRoundRow } from '../infrastructure/database-schema.js';
import type { JsonObject } from '../infrastructure/json.js';
import type { ModelToolCall, ModelToolTurnResult, ModelUsage } from '../workflow/fake-model-port.js';
import { ASSISTANT_READ_TOOLS } from './assistant-readonly-round.js';
import { createRepositories } from './unit-of-work.js';
import type { DbExecutor } from '../infrastructure/database.js';

/**
 * 会话生成的持久接续契约（0163，2026-11-12 Durable Task Continuation）。
 *
 * 这一模块只负责**读回与判定**：把持久检查点还原成可回灌的模型工具回合，并给出
 * 「一条过期生成能否接续」的纯结论。真正的重放/补派发在
 * `assistant-readonly-round.ts` 里，与首次执行共用同一份准入与结算路径。
 *
 * 三条边界：
 *   * 检查点只描述「已经回传给模型的工具结果」。没有它，恢复时只能重新调用模型；
 *   * 结果正文可以从检查点复用，但**动作身份与外部副作用**仍以 `session_tool_calls`
 *     为准；两者冲突时按账本判定，不按内存猜测；
 *   * 不把流式预览当作模型回答：预览是 `assist_message_previews` 的可丢弃副本。
 */

/** 同一条消息最多开始几次生成；到上界仍中断就如实失败，不无限重启。 */
export const GENERATION_RECOVERY_MAX_ATTEMPTS = 3;

/** 一条过期生成按真实账本得到的接续结论。 */
export type GenerationRecoveryVerdict =
  | 'REQUEUE'
  | 'CANCELLED'
  | 'BLOCKED'
  | 'EXHAUSTED'
  | 'DEFERRED';

/**
 * 纯判定：过期生成属于哪一档。
 *
 * 顺序即优先级：用户停止意图最高，其次委派在途（交给委派恢复核对），
 * 再是有未核对的外部动作（阻塞），最后才看上界。
 */
export function decideExpiredGenerationRecovery(input: {
  readonly cancelRequested: boolean;
  readonly runningDelegation: boolean;
  readonly unsafeTool: boolean;
  readonly generationAttempt: number;
  readonly maxAttempts: number;
}): GenerationRecoveryVerdict {
  if (input.cancelRequested) return 'CANCELLED';
  if (input.runningDelegation) return 'DEFERRED';
  if (input.unsafeTool) return 'BLOCKED';
  if (input.generationAttempt >= input.maxAttempts) return 'EXHAUSTED';
  return 'REQUEUE';
}

/** 恢复时允许安全重放的只读工具词表；有副作用的工具一律不重放。 */
export function recoveryReadOnlyTools(): readonly string[] {
  // `read_change_set` 位于写工具词表（需要 FILE_WRITE 能力），但它只读回自己刚写出的
  // 变更集证据，没有新的外部副作用，因此和只读工具同类。
  return [...ASSISTANT_READ_TOOLS, 'read_change_set'];
}

/** 恢复时回灌给模型的工具结果；`slot` 用来重建本轮预算用量。 */
export interface ResumedToolResult extends ModelToolTurnResult {
  /** READ = 计入工具调用预算；SETTLEMENT = 待办结算额度（不占读取额度）。 */
  readonly slot: 'READ' | 'SETTLEMENT';
}

/** 一个已完成的工具回合（模型请求 + 已得到的工具结果）。 */
export interface ResumedGenerationRound {
  readonly round: number;
  readonly attempt: number;
  readonly calls: readonly ModelToolCall[];
  readonly results: readonly ResumedToolResult[];
  readonly steersBefore: readonly string[];
  readonly preamble?: string;
  readonly reasoningContent?: string;
  readonly usage: ModelUsage | null;
  readonly providerRequestId: string | null;
}

function readString(value: unknown): string | undefined {
  return typeof value === 'string' && value !== '' ? value : undefined;
}

function readStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
}

function readObject(value: unknown): JsonObject | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as JsonObject : undefined;
}

/** 从检查点解析模型工具请求；畸形行整轮跳过（宁可重新调用模型，也不编造历史）。 */
export function parseAssistantTurn(value: JsonObject): {
  readonly calls: readonly ModelToolCall[];
  readonly steersBefore: readonly string[];
  readonly preamble?: string;
  readonly reasoningContent?: string;
} | undefined {
  const rawCalls = value.calls;
  if (!Array.isArray(rawCalls) || rawCalls.length === 0) return undefined;
  const calls: ModelToolCall[] = [];
  for (const item of rawCalls) {
    const call = readObject(item);
    if (call === undefined || typeof call.provider_tool_call_id !== 'string' ||
        typeof call.name !== 'string' || readObject(call.arguments) === undefined) return undefined;
    calls.push({ providerToolCallId: call.provider_tool_call_id, name: call.name,
      arguments: call.arguments as JsonObject });
  }
  const preamble = readString(value.preamble);
  const reasoningContent = readString(value.reasoning_content);
  return { calls, steersBefore: readStringArray(value.steers_before),
    ...(preamble === undefined ? {} : { preamble }),
    ...(reasoningContent === undefined ? {} : { reasoningContent }) };
}

/** 从检查点解析工具结果；逐项校验，畸形的单项丢弃（由账本补核对）。 */
export function parseToolResults(value: unknown): ResumedToolResult[] {
  if (!Array.isArray(value)) return [];
  const results: ResumedToolResult[] = [];
  for (const item of value) {
    const result = readObject(item);
    if (result === undefined || typeof result.provider_tool_call_id !== 'string' ||
        typeof result.name !== 'string' || typeof result.content !== 'string') continue;
    results.push({ providerToolCallId: result.provider_tool_call_id, name: result.name,
      content: result.content, isError: result.is_error === true,
      slot: result.slot === 'SETTLEMENT' ? 'SETTLEMENT' : 'READ' });
  }
  return results;
}

function readUsage(value: JsonObject | null): ModelUsage | null {
  if (value === null) return null;
  const number = (key: string): number | null =>
    typeof value[key] === 'number' ? value[key] as number : null;
  return { inputTokens: number('input_tokens'), outputTokens: number('output_tokens'),
    cacheReadTokens: number('cache_read_tokens'),
    cacheCreationTokens: number('cache_creation_tokens') };
}

/** 持久行 → 恢复回合；畸形行跳过，不补造历史。 */
export function toResumedRound(row: AssistGenerationRoundRow): ResumedGenerationRound | undefined {
  const turn = parseAssistantTurn(row.assistant_turn);
  if (turn === undefined) return undefined;
  return { round: row.round, attempt: row.attempt, calls: turn.calls,
    results: parseToolResults(row.tool_results), steersBefore: turn.steersBefore,
    ...(turn.preamble === undefined ? {} : { preamble: turn.preamble }),
    ...(turn.reasoningContent === undefined
      ? {} : { reasoningContent: turn.reasoningContent }),
    usage: readUsage(row.usage), providerRequestId: row.provider_request_id };
}

/**
 * 读取一条消息的恢复回合。
 *
 * 只有 `generation_attempt > 1` 才需要回灌：首次生成没有历史回合可复用。
 * 读取失败/畸形行按「没有检查点」处理——重新调用模型仍然安全，编造历史不安全。
 */
export async function loadGenerationResumeState(db: DbExecutor, messageId: string):
Promise<readonly ResumedGenerationRound[]> {
  const rows = await createRepositories(db).assist.listGenerationRounds(messageId);
  return rows.flatMap((row) => {
    const round = toResumedRound(row);
    return round === undefined ? [] : [round];
  });
}
