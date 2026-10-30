import { sql } from 'kysely';

import type { DbExecutor } from '../infrastructure/database.js';
import type { JsonObject } from '../infrastructure/json.js';

/**
 * session_tool_calls 的独占写入口（迁移 0060；0087 起同时承载两种会话读取来源）。
 *
 * 这是**会话读取**工具轮次的账本，覆盖 B 档人设助手与普通 Agent 主流程两种身份。它与
 * run_tool_calls 刻意不合并：Run 是 Task 的执行身份，这两种会话都没有 Task 也没有 Run，
 * 两者不得互相填对方的 id。因此本表不存 step/attempt，只存会话与消息身份，以及那次
 * 只读动作自己的 Operation。两种来源靠 `attachOperation()` 的 origin 参数区分：
 * 一档的行不能绑到另一档的动作上。
 */
export interface SessionToolCallRow {
  readonly id: string;
  readonly session_id: string;
  readonly message_id: string;
  readonly round: number;
  readonly ordinal: number;
  readonly tool_name: string;
  readonly arguments: JsonObject;
  readonly arguments_sha256: string;
  readonly provider_tool_call_id: string | null;
  readonly operation_id: string | null;
  readonly status: 'REQUESTED' | 'SETTLED' | 'REJECTED' | 'ABANDONED' | 'UNKNOWN';
  readonly rejection_reason: string | null;
  readonly rejection_detail: string | null;
  readonly result_digest: string | null;
  readonly requested_at: Date;
  readonly settled_at: Date | null;
}

const COLUMNS = sql.raw('id, session_id, message_id, round, ordinal, tool_name, arguments, ' +
  'arguments_sha256, provider_tool_call_id, operation_id, status, rejection_reason, ' +
  'rejection_detail, result_digest, requested_at, settled_at');

export class SessionToolCallRepository {
  constructor(private readonly db: DbExecutor) {}

  async insert(input: { id: string; sessionId: string; messageId: string; round: number;
    ordinal: number; toolName: string; arguments: JsonObject; argumentsSha256: string;
    providerToolCallId?: string | null | undefined }): Promise<SessionToolCallRow> {
    const rows = (await sql<SessionToolCallRow>`insert into session_tool_calls (id, session_id,
      message_id, round, ordinal, tool_name, arguments, arguments_sha256, provider_tool_call_id)
      values (${input.id}, ${input.sessionId}, ${input.messageId}, ${input.round}, ${input.ordinal},
      ${input.toolName}, ${JSON.stringify(input.arguments)}::jsonb, ${input.argumentsSha256},
      ${input.providerToolCallId ?? null}) returning ${COLUMNS}`.execute(this.db)).rows;
    return rows[0]!;
  }

  async read(id: string): Promise<SessionToolCallRow | undefined> {
    return (await sql<SessionToolCallRow>`select ${COLUMNS} from session_tool_calls
      where id = ${id}`.execute(this.db)).rows[0];
  }

  async listByMessage(messageId: string): Promise<readonly SessionToolCallRow[]> {
    return (await sql<SessionToolCallRow>`select ${COLUMNS} from session_tool_calls
      where message_id = ${messageId} order by round, ordinal`.execute(this.db)).rows;
  }

  async listBySession(sessionId: string): Promise<readonly SessionToolCallRow[]> {
    return (await sql<SessionToolCallRow>`select ${COLUMNS} from session_tool_calls
      where session_id = ${sessionId} order by requested_at, id`.execute(this.db)).rows;
  }

  /**
   * 绑定那次只读动作的 Operation 身份。
   *
   * 目标 Operation 必须是**本次调用方自己的**会话读取来源、同一 Project 与受管资源——
   * 由 0060/0087 的 CHECK 与这里的显式核对共同保证。跨身份冒用（人设助手的行指向普通
   * 会话的 Operation，或反过来，或指向一个 RUN 的既有 Operation）在这里被挡住，
   * 而不是等读取投影时才发现。
   */
  async attachOperation(id: string, operationId: string,
    origin: 'ASSISTANT_READ' | 'AGENT_SESSION_READ' | 'AGENT_SESSION_WRITE'): Promise<boolean> {
    return (await sql<{ id: string }>`update session_tool_calls set operation_id = ${operationId}
      where id = ${id} and operation_id is null
        and exists (select 1 from logical_operations o where o.id = ${operationId}
          and o.origin = ${origin})
      returning id`.execute(this.db)).rows.length === 1;
  }

  /** 派发前被准入或参数校验拒绝：行落 REJECTED，不连 Operation。 */
  async reject(id: string, reason: string, detail: string): Promise<boolean> {
    return (await sql<{ id: string }>`update session_tool_calls set status = 'REJECTED',
      rejection_reason = ${reason}, rejection_detail = ${detail}, settled_at = now()
      where id = ${id} and status = 'REQUESTED' returning id`.execute(this.db)).rows.length === 1;
  }

  async settle(id: string, resultDigest: string): Promise<boolean> {
    return (await sql<{ id: string }>`update session_tool_calls set status = 'SETTLED',
      result_digest = ${resultDigest}, settled_at = now()
      where id = ${id} and status = 'REQUESTED' and operation_id is not null
      returning id`.execute(this.db)).rows.length === 1;
  }

  /**
   * 0128：应用内工具（委派）的结算——没有 Gateway Operation。
   *
   * 它的执行证据在 `assist_delegation_attempts`（子尝试状态、领取代次与结果消息），
   * 因此 0128 只对 `delegate_subagent` 放开了「SETTLED 必须有 Operation」这条 CHECK。
   * 其它工具仍走 `settle()`，那条不变量对它们继续成立。
   */
  async settleApplicationTool(id: string, resultDigest: string): Promise<boolean> {
    return (await sql<{ id: string }>`update session_tool_calls set status = 'SETTLED',
      result_digest = ${resultDigest}, settled_at = now()
      where id = ${id} and status = 'REQUESTED' and operation_id is null
        and tool_name = 'delegate_subagent'
      returning id`.execute(this.db)).rows.length === 1;
  }

  /** ADR-038: todo_write is an in-app tool without a Gateway Operation. */
  async settleTodoWrite(id: string, resultDigest: string): Promise<boolean> {
    return (await sql<{ id: string }>`update session_tool_calls set status = 'SETTLED',
      result_digest = ${resultDigest}, settled_at = now()
      where id = ${id} and status = 'REQUESTED' and operation_id is null
        and tool_name = 'todo_write'
      returning id`.execute(this.db)).rows.length === 1;
  }

  /**
   * 结果未知：行保留原 Operation 身份，等人工核对。
   * 不改成成功也不清空引用——UNKNOWN 先核对，不盲重试。
   */
  async markUnknown(id: string): Promise<boolean> {
    return (await sql<{ id: string }>`update session_tool_calls set status = 'UNKNOWN'
      where id = ${id} and status = 'REQUESTED' returning id`.execute(this.db)).rows.length === 1;
  }

  /** 停止或放弃：请求行不再派发。已经派发的结果不受影响。 */
  async abandon(id: string, reason: string): Promise<boolean> {
    return (await sql<{ id: string }>`update session_tool_calls set status = 'ABANDONED',
      rejection_reason = ${reason}, settled_at = now()
      where id = ${id} and status = 'REQUESTED' returning id`.execute(this.db)).rows.length === 1;
  }

  /** 恢复用：这条消息还有哪些没结算的请求。读取本身不重新派发。 */
  async listPending(messageId: string): Promise<readonly SessionToolCallRow[]> {
    return (await sql<SessionToolCallRow>`select ${COLUMNS} from session_tool_calls
      where message_id = ${messageId} and status = 'REQUESTED'
      order by round, ordinal`.execute(this.db)).rows;
  }
}