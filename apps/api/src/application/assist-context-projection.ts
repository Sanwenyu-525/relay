import { sql } from 'kysely';

import type { DbExecutor } from '../infrastructure/database.js';
import { createRepositories, type Repositories } from './unit-of-work.js';
import { readContextUsageSnapshot, type ContextUsageSnapshot } from './assist-context-usage.js';
import { planAssistModelBudget } from './assist-model-snapshot.js';
import { readModelPortConfig, readOpenRouterModelPortConfig } from
  '../workflow/model-port-config.js';
import type { AssistContextUsageCallRow } from '../assist/assist-repository.js';
import type { AssistSessionRow } from '../infrastructure/database-schema.js';
import { resourceNotFound } from './domain-error.js';

/**
 * 上下文用量面板的只读投影（0145）。
 *
 * 一次请求给全一个浮层需要的东西：会话当前档位、最近一次真实调用的实付用量、
 * 那次调用冻结的单次预算，以及（如果采到过）它自己的分项构成。
 *
 * 三件事刻意分开，因为它们回答三个不同的问题：
 *   * `budget`——这个会话**现在**按哪一档走（会话级事实，可随时改）；
 *   * `last_call.reserved_tokens`——历史那一次调用**当时**申请了多少额度，作为历史依据保留；
 *   * `last_call.input_tokens`——Provider 真的回了多少输入量。这是唯一可以直接相信的
 *     总量；分项是本地按请求文本估算的，两者口径不同，因此不强行相加相等。
 *
 * 前端占比的分母由产品口径决定：2026-11-11 用户指令改为**当前档位**（`budget.tokens`），
 * 圆环、浮层与三档单选共用同一个分母；`reserved_tokens` 只在两者不同时作为差异说明出现。
 * 投影同时给出两者，读法由界面选择，后端不替界面挑选分母。
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
}

export async function readSessionContextUsage(db: DbExecutor, workspaceId: string,
  sessionId: string, env: NodeJS.ProcessEnv = process.env): Promise<SessionContextUsageProjection> {
  const r = createRepositories(db);
  const session = await r.assist.readSession(sessionId);
  if (session?.workspace_id !== workspaceId) throw resourceNotFound('Assist session');
  const call = await r.assist.latestContextUsageCall(session.id);
  const lastCall = call === undefined ? await messageFallback(db, session.id) : callProjection(call);
  return { session_id: session.id,
    budget: { tokens: session.context_budget_tokens,
      revision: session.context_budget_revision.toString() },
    next_call: await readNextCallBudget(r, session, env),
    last_call: lastCall };
}

/**
 * 下一次调用的申请预算。
 *
 * 只读，不触发目录同步：下次调用真能不能成立由冻结那一刻决定，这里只回答「按现在的
 * 档位与已知窗口，会申请多少」。读不到配置或模型目录里没有这一条时返回 null——不拿
 * 档位冒充一个可执行的结果。
 */
async function readNextCallBudget(r: Repositories, session: AssistSessionRow,
  env: NodeJS.ProcessEnv): Promise<SessionContextUsageProjection['next_call']> {
  const tokens = session.context_budget_tokens;
  const selection = await r.modelSelection.readForSession(session.id);
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
