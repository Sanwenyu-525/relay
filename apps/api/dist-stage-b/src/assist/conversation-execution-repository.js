import { sql } from 'kysely';
/**
 * conversation_execution_requests 的独占写入口。
 *
 * 一次用户意图一个身份：同一 command_id 或同一原消息只会得到一行。
 * 阶段推进单独 CAS，恢复时按已保存的命令身份重放，不新建第二个 Task/Run。
 */
export class ConversationExecutionRepository {
    db;
    constructor(db) {
        this.db = db;
    }
    async insertRequest(input) {
        const result = await sql `
      insert into conversation_execution_requests (id, workspace_id, project_id, session_id,
        source_message_id, resource_id, command_id, root_path, base_content_sha256,
        decision, candidate_status, status, task_command_id, ready_command_id, delegate_command_id)
      values (${input.id}, ${input.workspaceId}, ${input.projectId}, ${input.sessionId},
        ${input.sourceMessageId}, ${input.resourceId}, ${input.commandId}, ${input.rootPath},
        ${input.baseContentSha256}, 'DISCUSS', 'PENDING', 'INTERPRETING',
        ${input.taskCommandId}, ${input.readyCommandId}, ${input.delegateCommandId})
      returning *`.execute(this.db);
        const row = result.rows[0];
        if (row === undefined)
            throw new Error('conversation execution request insert returned no row');
        return row;
    }
    async readRequest(id, lock = false) {
        const suffix = lock ? sql `for update` : sql ``;
        return (await sql `
      select * from conversation_execution_requests where id = ${id} ${suffix}`
            .execute(this.db)).rows[0];
    }
    async findByCommand(workspaceId, commandId, lock = false) {
        const suffix = lock ? sql `for update` : sql ``;
        return (await sql `
      select * from conversation_execution_requests
      where workspace_id = ${workspaceId} and command_id = ${commandId} ${suffix}`
            .execute(this.db)).rows[0];
    }
    async findBySourceMessage(sourceMessageId, lock = false) {
        const suffix = lock ? sql `for update` : sql ``;
        return (await sql `
      select * from conversation_execution_requests
      where source_message_id = ${sourceMessageId} ${suffix}`.execute(this.db)).rows[0];
    }
    async listSessionRequests(workspaceId, sessionId, limit = 20) {
        return (await sql `
      select * from conversation_execution_requests
      where workspace_id = ${workspaceId} and session_id = ${sessionId}
      order by created_at desc, id desc limit ${limit}`.execute(this.db)).rows;
    }
    /** 候选先落库：只有 PENDING 能写入，重复结算不会覆盖已保存的整理结果。 */
    async saveInterpretation(id, input) {
        return (await sql `
      update conversation_execution_requests set decision = ${input.decision},
        candidate_status = ${input.candidateStatus}, status = ${input.status},
        candidate = ${input.candidate === null ? null : JSON.stringify(input.candidate)}::jsonb,
        clarification = ${input.clarification === null ? null :
            JSON.stringify(input.clarification)}::jsonb,
        revision = revision + 1, updated_at = now()
      where id = ${id} and candidate_status = 'PENDING'
      returning *`.execute(this.db)).rows[0];
    }
    /** 阶段推进：只允许向前，已结算的阶段不会被第二次提交改写。 */
    async advanceStage(id, input) {
        const setTaskId = input.taskId === undefined ? sql `` : sql `, task_id = ${input.taskId}`;
        const setTaskCommand = input.taskCommandId === undefined ? sql `` :
            sql `, task_command_id = ${input.taskCommandId}`;
        const setReadyCommand = input.readyCommandId === undefined ? sql `` :
            sql `, ready_command_id = ${input.readyCommandId}`;
        const setDelegateCommand = input.delegateCommandId === undefined ? sql `` :
            sql `, delegate_command_id = ${input.delegateCommandId}`;
        const setRunId = input.runId === undefined ? sql `` : sql `, run_id = ${input.runId}`;
        return (await sql `
      update conversation_execution_requests set status = ${input.status},
        revision = revision + 1, updated_at = now()
        ${setTaskId}${setTaskCommand}${setReadyCommand}${setDelegateCommand}${setRunId}
      where id = ${id} and status = any(${sql.val([...input.from])}::text[])
      returning *`.execute(this.db)).rows[0];
    }
    async markFailed(id, allowedFrom, candidateStatus) {
        return (await sql `
      update conversation_execution_requests set status = 'FAILED',
        candidate_status = ${candidateStatus}, revision = revision + 1, updated_at = now()
      where id = ${id} and status = any(${sql.val([...allowedFrom])}::text[])
      returning *`.execute(this.db)).rows[0];
    }
}
