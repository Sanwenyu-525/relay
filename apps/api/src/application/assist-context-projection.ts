import { sql } from 'kysely';

import type { DbExecutor } from '../infrastructure/database.js';
import { createRepositories } from './unit-of-work.js';
import { readContextUsageSnapshot, type ContextUsageSnapshot } from './assist-context-usage.js';
import type { AssistContextUsageCallRow } from '../assist/assist-repository.js';
import { resourceNotFound } from './domain-error.js';

/**
 * 上下文用量面板的只读投影（0145）。
 *
 * 一次请求给全一个浮层需要的东西：会话当前档位、最近一次真实调用的实付用量、
 * 那次调用冻结的单次预算，以及（如果采到过）它自己的分项构成。
 *
 * 三件事刻意分开，因为它们回答三个不同的问题：
 *   * `budget`——这个会话**现在**按哪一档走（会话级事实，可随时改）；
 *   * `last_call.reserved_tokens`——历史那一次调用**当时**申请了多少额度。档位改过之后
 *     两者不同，历史占比必须按当时的额度解释，否则同一份读数会因为后来换档而变形；
 *   * `last_call.input_tokens`——Provider 真的回了多少输入量。这是唯一可以直接相信的
 *     总量；分项是本地按请求文本估算的，两者口径不同，因此不强行相加相等。
 *
 * 不返回提示词、文件正文、工具输出或任何路径：面板只需要数值与来源分类。
 */

export interface SessionContextUsageProjection {
  readonly session_id: string;
  readonly budget: { readonly tokens: number; readonly revision: string };
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
    /** 那次调用冻结的单次预算；没有记录为 null（此时占比只能按当前档位解释）。 */
    readonly reserved_tokens: number | null;
    readonly settled_at: string | null;
    /** 分项构成；`null` = 这次调用没有分项统计（0145 之前的数据或非对话调用）。 */
    readonly breakdown: ContextUsageSnapshot | null;
  } | null;
}

export async function readSessionContextUsage(db: DbExecutor, workspaceId: string,
  sessionId: string): Promise<SessionContextUsageProjection> {
  const r = createRepositories(db);
  const session = await r.assist.readSession(sessionId);
  if (session?.workspace_id !== workspaceId) throw resourceNotFound('Assist session');
  const call = await r.assist.latestContextUsageCall(session.id);
  const lastCall = call === undefined ? await messageFallback(db, session.id) : callProjection(call);
  return { session_id: session.id,
    budget: { tokens: session.context_budget_tokens,
      revision: session.context_budget_revision.toString() },
    last_call: lastCall };
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
