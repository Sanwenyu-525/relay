import { sql } from 'kysely';

import type { DbExecutor } from '../infrastructure/database.js';
import { createRepositories, type Repositories } from './unit-of-work.js';
import { readContextUsageSnapshot, type ContextUsageSnapshot } from './assist-context-usage.js';
import { planAssistModelBudget } from './assist-model-snapshot.js';
import { readModelPortConfig, readOpenRouterModelPortConfig } from
  '../workflow/model-port-config.js';
import type { AssistContextUsageCallRow } from '../assist/assist-repository.js';
import type { AssistSessionRow, SessionModelSelectionRow } from '../infrastructure/database-schema.js';
import { resourceNotFound } from './domain-error.js';
import { COMPACTION_THRESHOLD_RECOMMENDED, DEFAULT_COMPACTION_THRESHOLD_TOKENS,
  measureSessionContextTokens, planContextCompaction, readCompactionAudit, readSessionModelCapacity,
  type CompactionTrigger } from './assist-context-policy.js';

/**
 * 上下文用量面板的只读投影（0145 / 0162）。
 *
 * 一次请求给全一个浮层需要的东西：会话当前档位、最近一次真实调用的实付用量、
 * 那次调用冻结的单次预算、（如果采到过）它自己的分项构成，以及**压缩策略**。
 *
 * 四件事刻意分开，因为它们回答四个不同的问题：
 *   * `budget`——这个会话**现在**按哪一档走（会话级事实，可随时改）；
 *   * `last_call.reserved_tokens`——历史那一次调用**当时**申请了多少额度，作为历史依据保留；
 *   * `last_call.input_tokens`——Provider 真的回了多少输入量。这是唯一可以直接相信的
 *     总量；分项是本地按请求文本估算的，两者口径不同，因此不强行相加相等；
 *   * `compaction`——现在有多少上下文、模型真实窗口多大、阈值生效在哪个数、离它还有多远。
 *     它把「模型窗口」与「压缩阈值」分开：达到阈值不是达到窗口上限。
 *
 * 前端占比的分母由产品口径决定：2026-11-11 用户指令改为**当前档位**（`budget.tokens`），
 * 圆环、浮层与三档单选共用同一个分母；`reserved_tokens` 只在两者不同时作为差异说明出现。
 *
 * 不返回提示词、文件正文、工具输出或任何路径：面板只需要数值与来源分类。
 */

export interface SessionContextUsageProjection {
  readonly session_id: string;
  readonly budget: { readonly tokens: number; readonly revision: string };
  /**
   * 下一次真实调用会**申请**多少预算（2026-10-31）。
   *
   * 它与「当前档位」不是同一个数：冻结时还要按已知的 Provider 窗口截断。这里用与
   * 冻结完全相同的 `planAssistModelBudget` 计算，前端不自己取 min，也不拿历史值冒充。
   * 窗口未知时如实给出 `window_source: 'UNKNOWN'`——那表示「会按档位申请」，不表示
   * Provider 一定装得下。模型选择不可用（配置读不到、目录里没有这个模型）时为 null。
   */
  readonly next_call: {
    readonly reservation_tokens: number;
    readonly context_budget_tokens: number;
    readonly provider_window_tokens: number | null;
    readonly window_source: 'MODEL_CATALOG' | 'UNKNOWN';
  } | null;
  readonly last_call: {
    /** 这份读数属于哪一次调用；`MESSAGE` 表示退回消息行上的用量（旧数据没有调用行）。 */
    readonly source: 'MODEL_CALL' | 'MESSAGE';
    readonly call_id: string | null;
    readonly message_id: string | null;
    readonly provider: string | null;
    readonly model: string | null;
    readonly status: string | null;
    readonly input_tokens: number | null;
    readonly output_tokens: number | null;
    readonly cache_read_tokens: number | null;
    readonly cache_creation_tokens: number | null;
    /** 那次调用冻结的单次预算；没有记录为 null。占比按当前档位计算，它只作差异说明。 */
    readonly reserved_tokens: number | null;
    readonly settled_at: string | null;
    /** 分项构成；`null` = 这次调用没有分项统计（0145 之前的数据或非对话调用）。 */
    readonly breakdown: ContextUsageSnapshot | null;
  } | null;
  /**
   * 0162：自动压缩策略与当前读数。
   *
   * `effective_threshold_tokens` 是**真正生效**的阈值：min(用户设置, 安全输入上限的 90%)，
   * 让自动压缩先于硬上限发生；`safe_input_tokens` 是硬上限本身。
   * `threshold_clamped` 为真时界面必须说明「保存值高于当前模型安全上限，已按窗口收敛」，
   * 不能把用户设置原样当成生效值展示。
   */
  readonly compaction: {
    readonly enabled: boolean;
    readonly threshold_tokens: number | null;
    readonly default_threshold_tokens: number;
    readonly recommended: { readonly min: number; readonly max: number };
    readonly requested_threshold_tokens: number;
    readonly effective_threshold_tokens: number;
    readonly threshold_clamped: boolean;
    readonly target_window_tokens: number;
    readonly model_window_tokens: number | null;
    readonly window_source: 'MODEL_CATALOG' | 'SESSION_TIER';
    readonly effective_window_tokens: number;
    readonly output_reserve_tokens: number;
    readonly protocol_overhead_tokens: number;
    readonly safety_reserve_tokens: number;
    readonly safe_input_tokens: number;
    readonly post_compaction_target_tokens: number;
    /** 当前上下文规模；`PROVIDER_USAGE` 表示基线来自真实上报，`ESTIMATED` 表示整份估算。 */
    readonly context_tokens: number;
    readonly context_source: 'PROVIDER_USAGE' | 'ESTIMATED';
    /** 距离生效阈值还有多少 tokens；已超过时为负。 */
    readonly distance_tokens: number;
    readonly active: { readonly request_id: string; readonly status: 'PENDING' | 'RUNNING';
      readonly trigger: CompactionTrigger } | null;
    readonly last_result: { readonly request_id: string; readonly reason: 'MANUAL' | 'AUTO';
      readonly trigger: CompactionTrigger;
      readonly status: 'COMPLETED' | 'FAILED' | 'CANCELLED';
      readonly error_code: string | null;
      readonly through_seq: string;
      readonly tokens_before: number | null;
      /** 完成后重新量到的上下文规模；没有回填成功时为 null（不猜）。 */
      readonly tokens_after: number | null;
      /**
       * 压缩后预算复核结论：`true` = 压完仍不低于安全输入上限，下一轮还得继续整理或中止；
       * `null` = 没有可核对的读数（未完成、或读数缺失）。
       */
      readonly budget_unmet: boolean | null;
      /** 这次压缩判定时冻结的安全输入上限；与 `budget_unmet` 同一口径，界面不另算。 */
      readonly safe_input_tokens: number | null;
      readonly at: string } | null;
  };
}

export async function readSessionContextUsage(db: DbExecutor, workspaceId: string,
  sessionId: string, env: NodeJS.ProcessEnv = process.env): Promise<SessionContextUsageProjection> {
  const r = createRepositories(db);
  const session = await r.assist.readSession(sessionId);
  if (session?.workspace_id !== workspaceId) throw resourceNotFound('Assist session');
  const selection = await r.modelSelection.readForSession(session.id);
  const settings = await r.information.readMemorySettings(session.workspace_id);
  const capacity = await readSessionModelCapacity(r, session.workspace_id, selection, env);
  const policy = planContextCompaction({ targetWindowTokens: session.context_budget_tokens,
    modelWindowTokens: capacity.modelWindowTokens,
    ...(capacity.outputReserveTokens === null ? {}
      : { outputReserveTokens: capacity.outputReserveTokens }),
    userThresholdTokens: settings?.compaction_threshold_tokens ?? null });
  const measured = await measureSessionContextTokens(r, session);
  const call = await r.assist.latestContextUsageCall(session.id);
  const lastCall = call === undefined ? await messageFallback(db, session.id) : callProjection(call);
  const [active, requests] = await Promise.all([
    r.assistMemory.activeRequest(session.id), r.assistMemory.requests(session.id)]);
  const terminal = requests.find((request) =>
    request.status !== 'PENDING' && request.status !== 'RUNNING');
  const lastAudit = terminal === undefined ? null : readCompactionAudit(terminal);
  return { session_id: session.id,
    budget: { tokens: session.context_budget_tokens,
      revision: session.context_budget_revision.toString() },
    next_call: await readNextCallBudget(r, session, selection, env),
    last_call: lastCall,
    compaction: {
      enabled: settings?.automatic_compaction !== false,
      threshold_tokens: policy.userThresholdTokens,
      default_threshold_tokens: DEFAULT_COMPACTION_THRESHOLD_TOKENS,
      recommended: { min: COMPACTION_THRESHOLD_RECOMMENDED.min,
        max: COMPACTION_THRESHOLD_RECOMMENDED.max },
      requested_threshold_tokens: policy.requestedThresholdTokens,
      effective_threshold_tokens: policy.effectiveThresholdTokens,
      threshold_clamped: policy.thresholdClamped,
      target_window_tokens: policy.targetWindowTokens,
      model_window_tokens: policy.modelWindowTokens,
      window_source: policy.windowSource,
      effective_window_tokens: policy.effectiveWindowTokens,
      output_reserve_tokens: policy.outputReserveTokens,
      protocol_overhead_tokens: policy.protocolOverheadTokens,
      safety_reserve_tokens: policy.safetyReserveTokens,
      safe_input_tokens: policy.safeInputTokens,
      post_compaction_target_tokens: policy.postCompactionTargetTokens,
      context_tokens: measured.tokens,
      context_source: measured.source,
      distance_tokens: policy.effectiveThresholdTokens - measured.tokens,
      active: active === undefined ? null : { request_id: active.id,
        status: active.status === 'RUNNING' ? 'RUNNING' : 'PENDING',
        trigger: readCompactionAudit(active).trigger },
      last_result: terminal === undefined || lastAudit === null ? null : {
        request_id: terminal.id, reason: terminal.reason, trigger: lastAudit.trigger,
        status: terminal.status as 'COMPLETED' | 'FAILED' | 'CANCELLED',
        error_code: terminal.error_code, through_seq: terminal.through_seq.toString(),
        tokens_before: lastAudit.tokensBefore,
        // 只有「已完成」的请求才有压后读数：失败/取消没有可核对的结果，宁可为 null。
        tokens_after: terminal.status === 'COMPLETED' ? lastAudit.tokensAfter : null,
        budget_unmet: terminal.status !== 'COMPLETED' || lastAudit.tokensAfter === null ||
          lastAudit.safeInputTokens === null ? null
          : lastAudit.tokensAfter >= lastAudit.safeInputTokens,
        safe_input_tokens: lastAudit.safeInputTokens,
        at: terminal.updated_at.toISOString() },
    } };
}

/**
 * 下一次调用的申请预算。
 *
 * 只读，不触发目录同步：下次调用真能不能成立由冻结那一刻决定，这里只回答「按现在的
 * 档位与已知窗口，会申请多少」。读不到配置或模型目录里没有这一条时返回 null——不拿
 * 档位冒充一个可执行的结果。
 */
async function readNextCallBudget(r: Repositories, session: AssistSessionRow,
  selection: SessionModelSelectionRow | undefined,
  env: NodeJS.ProcessEnv): Promise<SessionContextUsageProjection['next_call']> {
  const tokens = session.context_budget_tokens;
  const base = (reservation: number, window: number | null) => ({
    reservation_tokens: reservation, context_budget_tokens: tokens,
    provider_window_tokens: window,
    window_source: window === null ? 'UNKNOWN' as const : 'MODEL_CATALOG' as const });
  if (selection === undefined || selection.connection === 'default') {
    const config = readModelPortConfig(env);
    if (config === undefined) return null;
    return base(planAssistModelBudget(config, tokens, null).callReservationTokens, null);
  }
  const entry = await r.modelCatalog.readEntryBySourceModelId(selection.model);
  if (entry === undefined) return null;
  const config = readOpenRouterModelPortConfig(env, selection.model);
  return base(planAssistModelBudget(config, tokens, entry.context_window).callReservationTokens,
    entry.context_window);
}

function callProjection(row: AssistContextUsageCallRow): SessionContextUsageProjection['last_call'] {
  return { source: 'MODEL_CALL', call_id: row.id, message_id: row.assist_message_id,
    provider: row.provider, model: row.model, status: row.status,
    input_tokens: row.usage_input_tokens, output_tokens: row.usage_output_tokens,
    cache_read_tokens: row.usage_cache_read_tokens,
    cache_creation_tokens: row.usage_cache_creation_tokens,
    reserved_tokens: row.budget_reserved_tokens,
    settled_at: row.settled_at === null ? null : row.settled_at.toISOString(),
    breakdown: readContextUsageSnapshot(row.context_usage) };
}

/**
 * 兜底：没有 `model_calls` 行时，退回消息行上的用量。
 *
 * 这种数据没有「单次调用」的身份，因此不猜冻结预算、也不编分项——只把总数交出来，
 * 面板据此显示「暂无分项统计」。
 */
async function messageFallback(
  db: DbExecutor, sessionId: string,
): Promise<SessionContextUsageProjection['last_call']> {
  const row = (await sql<{ id: string; usage_input_tokens: number | null;
    usage_output_tokens: number | null; usage_cache_read_tokens: number | null;
    usage_cache_creation_tokens: number | null; updated_at: Date }>`
    select id, usage_input_tokens, usage_output_tokens, usage_cache_read_tokens,
      usage_cache_creation_tokens, updated_at
    from assist_messages
    where session_id = ${sessionId} and role = 'ASSISTANT'
      and (usage_input_tokens is not null or usage_cache_read_tokens is not null)
    order by seq desc limit 1`.execute(db)).rows[0];
  if (row === undefined) return null;
  return { source: 'MESSAGE', call_id: null, message_id: row.id, provider: null, model: null,
    status: null, input_tokens: row.usage_input_tokens, output_tokens: row.usage_output_tokens,
    cache_read_tokens: row.usage_cache_read_tokens,
    cache_creation_tokens: row.usage_cache_creation_tokens,
    reserved_tokens: null, settled_at: row.updated_at.toISOString(), breakdown: null };
}
