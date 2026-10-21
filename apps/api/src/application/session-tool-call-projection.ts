import type { AssistMessageRow } from '../infrastructure/database-schema.js';
import type { DbExecutor } from '../infrastructure/database.js';
import type { JsonObject } from '../infrastructure/json.js';
import type { SessionToolCallRow } from '../assist/session-tool-call-repository.js';
import { SessionToolCallRepository } from '../assist/session-tool-call-repository.js';
import { resourceNotFound } from './domain-error.js';
import { createRepositories } from './unit-of-work.js';

/**
 * 会话工具轮次的只读投影（工作台 §18.10「原消息下展示实际阶段」）。
 *
 * `session_tool_calls` 一直有写入口却没有读入口：Agent 主流程每轮调了什么工具、是否被拒、
 * 何时结算都只落在库里，界面上因此只剩一个「正在生成」。这份投影补的就是那一只读口子，
 * 形状与 `run-tool-call-projection.ts` 对齐而不合并两张表——Run 是 Task 的执行身份，
 * 会话轮次没有 Task 也没有 Run（见 session-tool-call-repository.ts 的同一说明）。
 *
 * 三条不变量：
 *   * `arguments` 逐字节透传，不新增「摘要」或「人类可读结论」字段；折叠行的一行摘要在前端现算。
 *   * 只读：不触发派发、不重放、不改变任何一行状态。
 *   * 不含模型私有推理。本表没有那一列，推理归 `reasoning_content` 的现行禁令继续成立。
 */

export interface SessionToolCallDto {
  readonly id: string;
  readonly round: number;
  readonly ordinal: number;
  readonly tool_name: string;
  readonly status: 'REQUESTED' | 'SETTLED' | 'REJECTED' | 'ABANDONED' | 'UNKNOWN';
  readonly arguments: JsonObject;
  readonly arguments_sha256: string;
  readonly provider_tool_call_id: string | null;
  readonly operation_id: string | null;
  readonly rejection_reason: string | null;
  readonly rejection_detail: string | null;
  readonly result_digest: string | null;
  readonly requested_at: string;
  readonly settled_at: string | null;
}

export interface SessionToolCallRoundDto {
  readonly round: number;
  readonly calls: readonly SessionToolCallDto[];
}

export interface SessionToolCallProjection {
  readonly session_id: string;
  readonly message_id: string;
  readonly message_status: AssistMessageRow['status'];
  readonly rounds: readonly SessionToolCallRoundDto[];
}

/** 历史行的参数可能来自更早的部署；非对象按空对象投影，不让整份轨迹读取失败。 */
function asObject(value: JsonObject): JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value : {};
}

/**
 * 按 (round, ordinal) 升序分组。仓储已排序，这里再排一次是为了让投影对任意输入给出同一
 * 形状，前端因此不需要二次排序（与 Run 投影同一条理由）。
 */
export function projectSessionToolCalls(sessionId: string, messageId: string,
  messageStatus: AssistMessageRow['status'], rows: readonly SessionToolCallRow[]):
  SessionToolCallProjection {
  const buckets = new Map<number, SessionToolCallRow[]>();
  for (const row of rows) {
    const bucket = buckets.get(row.round);
    if (bucket === undefined) buckets.set(row.round, [row]);
    else bucket.push(row);
  }
  const rounds = [...buckets.keys()].sort((left, right) => left - right).map((round) => ({
    round,
    calls: (buckets.get(round) ?? []).slice()
      .sort((left, right) => left.ordinal - right.ordinal)
      .map((row) => ({
        id: row.id,
        round: row.round,
        ordinal: row.ordinal,
        tool_name: row.tool_name,
        status: row.status,
        arguments: asObject(row.arguments),
        arguments_sha256: row.arguments_sha256,
        provider_tool_call_id: row.provider_tool_call_id,
        operation_id: row.operation_id,
        rejection_reason: row.rejection_reason,
        rejection_detail: row.rejection_detail,
        result_digest: row.result_digest,
        requested_at: row.requested_at.toISOString(),
        settled_at: row.settled_at === null ? null : row.settled_at.toISOString(),
      })),
  }));
  return { session_id: sessionId, message_id: messageId, message_status: messageStatus, rounds };
}

/**
 * 只读投影的 I/O 入口。跨作用域与不可见 ID 一律 404；一条没有工具请求的消息返回空轮次，
 * 那是一个事实而不是读取失败。
 *
 * 不开事务、不加锁：这里读的是已经落账的轮次，界面上允许同一份数据里的行前后各读一次
 * （在途轮询本来就会看到轮次变多）。作用域判定沿 `readAssistSession` 的同一条口径。
 */
export async function readSessionToolCalls(db: DbExecutor, input: {
  workspaceId: string; sessionId: string; messageId: string;
}): Promise<SessionToolCallProjection> {
  const r = createRepositories(db);
  const session = await r.assist.readSession(input.sessionId);
  if (session === undefined || session.workspace_id !== input.workspaceId) {
    throw resourceNotFound('Assist session');
  }
  const message = await r.assist.readMessage(input.messageId);
  if (message === undefined || message.session_id !== session.id) {
    throw resourceNotFound('Assist message');
  }
  const rows = await new SessionToolCallRepository(db).listByMessage(message.id);
  return projectSessionToolCalls(session.id, message.id, message.status, rows);
}
