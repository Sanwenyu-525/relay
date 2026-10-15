import { sql } from 'kysely';
const COLUMNS = sql.raw('id, session_id, message_id, round, ordinal, tool_name, arguments, ' +
    'arguments_sha256, provider_tool_call_id, operation_id, status, rejection_reason, ' +
    'rejection_detail, result_digest, requested_at, settled_at');
export class SessionToolCallRepository {
    db;
    constructor(db) {
        this.db = db;
    }
    async insert(input) {
        const rows = (await sql `insert into session_tool_calls (id, session_id,
      message_id, round, ordinal, tool_name, arguments, arguments_sha256, provider_tool_call_id)
      values (${input.id}, ${input.sessionId}, ${input.messageId}, ${input.round}, ${input.ordinal},
      ${input.toolName}, ${JSON.stringify(input.arguments)}::jsonb, ${input.argumentsSha256},
      ${input.providerToolCallId ?? null}) returning ${COLUMNS}`.execute(this.db)).rows;
        return rows[0];
    }
    async read(id) {
        return (await sql `select ${COLUMNS} from session_tool_calls
      where id = ${id}`.execute(this.db)).rows[0];
    }
    async listByMessage(messageId) {
        return (await sql `select ${COLUMNS} from session_tool_calls
      where message_id = ${messageId} order by round, ordinal`.execute(this.db)).rows;
    }
    async listBySession(sessionId) {
        return (await sql `select ${COLUMNS} from session_tool_calls
      where session_id = ${sessionId} order by requested_at, id`.execute(this.db)).rows;
    }
    /**
     * 绑定那次只读动作的 Operation 身份。
     *
     * 目标 Operation 必须是 ASSISTANT_READ 来源、同一 Project 与受管资源——由 0060 的
     * CHECK 与这里的显式核对共同保证。跨身份冒用（指向一个 RUN 的既有 Operation）
     * 在这里被挡住，而不是等读取投影时才发现。
     */
    async attachOperation(id, operationId) {
        return (await sql `update session_tool_calls set operation_id = ${operationId}
      where id = ${id} and operation_id is null
        and exists (select 1 from logical_operations o where o.id = ${operationId}
          and o.origin = 'ASSISTANT_READ')
      returning id`.execute(this.db)).rows.length === 1;
    }
    /** 派发前被准入或参数校验拒绝：行落 REJECTED，不连 Operation。 */
    async reject(id, reason, detail) {
        return (await sql `update session_tool_calls set status = 'REJECTED',
      rejection_reason = ${reason}, rejection_detail = ${detail}, settled_at = now()
      where id = ${id} and status = 'REQUESTED' returning id`.execute(this.db)).rows.length === 1;
    }
    async settle(id, resultDigest) {
        return (await sql `update session_tool_calls set status = 'SETTLED',
      result_digest = ${resultDigest}, settled_at = now()
      where id = ${id} and status = 'REQUESTED' and operation_id is not null
      returning id`.execute(this.db)).rows.length === 1;
    }
    /**
     * 结果未知：行保留原 Operation 身份，等人工核对。
     * 不改成成功也不清空引用——UNKNOWN 先核对，不盲重试。
     */
    async markUnknown(id) {
        return (await sql `update session_tool_calls set status = 'UNKNOWN'
      where id = ${id} and status = 'REQUESTED' returning id`.execute(this.db)).rows.length === 1;
    }
    /** 停止或放弃：请求行不再派发。已经派发的结果不受影响。 */
    async abandon(id, reason) {
        return (await sql `update session_tool_calls set status = 'ABANDONED',
      rejection_reason = ${reason}, settled_at = now()
      where id = ${id} and status = 'REQUESTED' returning id`.execute(this.db)).rows.length === 1;
    }
    /** 恢复用：这条消息还有哪些没结算的请求。读取本身不重新派发。 */
    async listPending(messageId) {
        return (await sql `select ${COLUMNS} from session_tool_calls
      where message_id = ${messageId} and status = 'REQUESTED'
      order by round, ordinal`.execute(this.db)).rows;
    }
}
