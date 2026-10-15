import { randomUUID } from 'node:crypto';

import { sql } from 'kysely';

import type {
  ConversationCandidateStatus, ConversationStateChangeRow, ConversationStateRequestRow,
  StateChangeKind, StateChangeStatus, StateMaintenanceDecision, StateMaintenanceStatus,
} from '../infrastructure/database-schema.js';
import type { DbExecutor } from '../infrastructure/database.js';
import type { JsonObject } from '../infrastructure/json.js';

/**
 * conversation_state_requests / conversation_state_changes 的独占写入口（0062）。
 *
 * 一次原用户消息一个维护请求：同一 command_id 或同一 source_message_id 只会得到一行。
 * 变更行的命令身份在解释结算时固定，应用与撤回都沿原身份重放，不重建对象；
 * 请求状态推进单独 CAS，已结算的阶段不会被第二次提交改写。
 */
export class ConversationStateRepository {
  constructor(private readonly db: DbExecutor) {}

  async insertRequest(input: {
    readonly id: string; readonly workspaceId: string; readonly projectId: string;
    readonly sessionId: string; readonly sourceMessageId: string; readonly commandId: string;
    readonly applyCommandId: string; readonly undoCommandId: string;
    readonly baseContentSha256: Buffer;
    /** 0067（R3）：claim 事务内、调用模型之前冻结的解释基线；省略 = 迁移前旧行语义。 */
    readonly interpretationBaseline?: JsonObject | null;
  }): Promise<ConversationStateRequestRow> {
    const result = await sql<ConversationStateRequestRow>`
      insert into conversation_state_requests (id, workspace_id, project_id, session_id,
        source_message_id, command_id, apply_command_id, undo_command_id, base_content_sha256,
        interpretation_baseline, decision, candidate_status, status)
      values (${input.id}, ${input.workspaceId}, ${input.projectId}, ${input.sessionId},
        ${input.sourceMessageId}, ${input.commandId}, ${input.applyCommandId},
        ${input.undoCommandId}, ${input.baseContentSha256},
        ${input.interpretationBaseline == null ? null :
          JSON.stringify(input.interpretationBaseline)}::jsonb,
        'DISCUSS', 'PENDING', 'INTERPRETING')
      returning *`.execute(this.db);
    const row = result.rows[0];
    if (row === undefined) throw new Error('conversation state request insert returned no row');
    return row;
  }

  async readRequest(id: string,
    lock = false): Promise<ConversationStateRequestRow | undefined> {
    const suffix = lock ? sql`for update` : sql``;
    return (await sql<ConversationStateRequestRow>`
      select * from conversation_state_requests where id = ${id} ${suffix}`
      .execute(this.db)).rows[0];
  }

  async findByCommand(workspaceId: string, commandId: string,
    lock = false): Promise<ConversationStateRequestRow | undefined> {
    const suffix = lock ? sql`for update` : sql``;
    return (await sql<ConversationStateRequestRow>`
      select * from conversation_state_requests
      where workspace_id = ${workspaceId} and command_id = ${commandId} ${suffix}`
      .execute(this.db)).rows[0];
  }

  async findBySourceMessage(sourceMessageId: string,
    lock = false): Promise<ConversationStateRequestRow | undefined> {
    const suffix = lock ? sql`for update` : sql``;
    return (await sql<ConversationStateRequestRow>`
      select * from conversation_state_requests
      where source_message_id = ${sourceMessageId} ${suffix}`.execute(this.db)).rows[0];
  }

  /** 基础 /undo 必须沿原撤回身份精确定位；既有历史不会被列表上限截断。 */
  async findByUndoCommand(workspaceId: string, sessionId: string,
    commandId: string): Promise<ConversationStateRequestRow | undefined> {
    return (await sql<ConversationStateRequestRow>`select * from conversation_state_requests
      where workspace_id = ${workspaceId} and session_id = ${sessionId}
        and undo_command_id = ${commandId}`.execute(this.db)).rows[0];
  }

  async listSessionRequests(workspaceId: string, sessionId: string,
    limit = 20): Promise<readonly ConversationStateRequestRow[]> {
    return (await sql<ConversationStateRequestRow>`
      select * from conversation_state_requests
      where workspace_id = ${workspaceId} and session_id = ${sessionId}
      order by created_at desc, id desc limit ${limit}`.execute(this.db)).rows;
  }

  /**
   * 候选先落库：只有 PENDING 能写入，重复结算不会覆盖已保存的整理结果；
   * 同一事务内写入候选携带的类型化变更行（命令身份在此固定）。
   */
  async saveInterpretation(id: string, input: {
    readonly decision: StateMaintenanceDecision;
    readonly candidateStatus: ConversationCandidateStatus;
    readonly status: StateMaintenanceStatus;
    readonly candidate: JsonObject | null;
    readonly clarification: JsonObject | null;
    readonly decisionRequired: JsonObject | null;
    readonly changes: readonly {
      readonly ordinal: number; readonly changeKind: StateChangeKind;
      readonly commandId: string; readonly payload: JsonObject;
      readonly baselineRef: JsonObject | null;
    }[];
  }): Promise<ConversationStateRequestRow | undefined> {
    const updated = await (async () => {
      const result = await sql<ConversationStateRequestRow>`
        update conversation_state_requests set decision = ${input.decision},
          candidate_status = ${input.candidateStatus}, status = ${input.status},
          candidate = ${input.candidate === null ? null : JSON.stringify(input.candidate)}::jsonb,
          clarification = ${input.clarification === null ? null :
            JSON.stringify(input.clarification)}::jsonb,
          decision_required = ${input.decisionRequired === null ? null :
            JSON.stringify(input.decisionRequired)}::jsonb,
          revision = revision + 1, updated_at = now()
        where id = ${id} and candidate_status = 'PENDING'
        returning *`.execute(this.db);
      return result.rows[0];
    })();
    if (updated === undefined) return undefined;
    for (const change of input.changes) {
      await sql`insert into conversation_state_changes (id, request_id, ordinal, change_kind,
        command_id, payload, baseline_ref, status)
        values (${randomUUID()}, ${updated.id}, ${change.ordinal},
          ${change.changeKind}, ${change.commandId},
          ${JSON.stringify(change.payload)}::jsonb,
          ${change.baselineRef === null ? null : JSON.stringify(change.baselineRef)}::jsonb,
          'PENDING')`.execute(this.db);
    }
    return updated;
  }

  /**
   * 明确失败后的恢复出口：只允许把已结算为 INVALID 的请求重开为在途解释，
   * 且由 CAS 裁决唯一重开者；其余状态一律不推进（并发重入的输方读取胜出者的事实）。
   */
  async reopenInterpretation(id: string): Promise<ConversationStateRequestRow | undefined> {
    return (await sql<ConversationStateRequestRow>`
      update conversation_state_requests
      set candidate_status = 'PENDING', status = 'INTERPRETING',
        clarification = null, revision = revision + 1, updated_at = now()
      where id = ${id} and candidate_status = 'INVALID'
      returning *`.execute(this.db)).rows[0];
  }

  /**
   * 变更行结算：应用写 before/after 引用与错误，撤回写补偿身份。
   * APPLIED / COMPENSATED 的时间戳由状态驱动，调用方提供满足数据库 CHECK 的引用。
   */
  async updateChangeStatus(changeId: string, input: {
    readonly status: StateChangeStatus;
    readonly beforeRef?: JsonObject | null;
    readonly afterRef?: JsonObject | null;
    readonly error?: JsonObject | null;
    readonly compensationCommandId?: string | null;
  }): Promise<ConversationStateChangeRow | undefined> {
    const beforeRef = input.beforeRef === undefined ? null : input.beforeRef;
    const afterRef = input.afterRef === undefined ? null : input.afterRef;
    const error = input.error === undefined ? null : input.error;
    const compensationCommandId = input.compensationCommandId === undefined
      ? null : input.compensationCommandId;
    return (await sql<ConversationStateChangeRow>`
      update conversation_state_changes set status = ${input.status},
        before_ref = coalesce(${beforeRef === null ? null :
          JSON.stringify(beforeRef)}::jsonb, before_ref),
        after_ref = coalesce(${afterRef === null ? null :
          JSON.stringify(afterRef)}::jsonb, after_ref),
        error = ${error === null ? null : JSON.stringify(error)}::jsonb,
        compensation_command_id = coalesce(${compensationCommandId}::uuid,
          compensation_command_id),
        applied_at = case when ${input.status} = 'APPLIED' then now() else applied_at end,
        compensated_at = case when ${input.status} = 'COMPENSATED' then now()
          else compensated_at end
      where id = ${changeId}
      returning *`.execute(this.db)).rows[0];
  }

  async listChangeRows(requestId: string): Promise<readonly ConversationStateChangeRow[]> {
    return (await sql<ConversationStateChangeRow>`
      select * from conversation_state_changes
      where request_id = ${requestId}
      order by ordinal, id`.execute(this.db)).rows;
  }

  /**
   * 抢占撤回 Owner 并持久化已确认方案（0064）：状态推进与范围在同一语句提交，
   * CAS 输方拿不到行，也就不会执行任何补偿计划。
   */
  async startUndo(id: string, input: {
    readonly from: readonly StateMaintenanceStatus[];
    readonly scope: JsonObject;
  }): Promise<ConversationStateRequestRow | undefined> {
    return (await sql<ConversationStateRequestRow>`
      update conversation_state_requests set status = 'UNDOING',
        undo_scope = ${JSON.stringify(input.scope)}::jsonb,
        revision = revision + 1, updated_at = now()
      where id = ${id} and status = any(${sql.val([...input.from])}::text[])
      returning *`.execute(this.db)).rows[0];
  }

  /**
   * 取得连带承诺的决定：清掉 decision_required、按原身份推进状态，
   * 并把被拒绝的变更在同一事务里结算为 DECLINED（0067 R1）。
   * CAS 由 from 集合 + expectedRevision 共同裁决：版本在事务前读取之后被并发推进时，
   * 这里拿不到行，续答与并发推进只有一个能写。
   */
  async resolveDecision(id: string, input: {
    readonly from: readonly StateMaintenanceStatus[];
    readonly status: StateMaintenanceStatus;
    /** 用户看到答案时的请求版本：必须在本写事务内核对，不能只有事务前读取比较。 */
    readonly expectedRevision: string;
    /** resolution=DECLINE 时受这项决定约束、按决定不执行的变更（序号 + 决定留痕）。 */
    readonly declinedChanges?: readonly {
      readonly ordinal: number; readonly resolution: string;
      readonly answer: string; readonly question: string;
    }[];
    readonly changes: readonly {
      readonly ordinal: number; readonly changeKind: StateChangeKind;
      readonly commandId: string; readonly payload: JsonObject;
      readonly baselineRef: JsonObject | null;
    }[];
  }): Promise<ConversationStateRequestRow | undefined> {
    const updated = (await sql<ConversationStateRequestRow>`
      update conversation_state_requests set decision_required = null,
        status = ${input.status}, revision = revision + 1, updated_at = now()
      where id = ${id} and decision_required is not null
        and revision = ${input.expectedRevision}::bigint
        and status = any(${sql.val([...input.from])}::text[])
      returning *`.execute(this.db)).rows[0];
    if (updated === undefined) return undefined;
    for (const declined of input.declinedChanges ?? []) {
      await sql`update conversation_state_changes set status = 'DECLINED',
          after_ref = coalesce(after_ref, ${JSON.stringify({ declined: true,
            resolution: declined.resolution, answer: declined.answer,
            question: declined.question })}::jsonb)
        where request_id = ${id} and ordinal = ${declined.ordinal}
          and status = 'PENDING'`.execute(this.db);
    }
    for (const change of input.changes) {
      await sql`insert into conversation_state_changes (id, request_id, ordinal, change_kind,
        command_id, payload, baseline_ref, status)
        values (${randomUUID()}, ${updated.id}, ${change.ordinal}, ${change.changeKind},
          ${change.commandId}, ${JSON.stringify(change.payload)}::jsonb,
          ${change.baselineRef === null ? null : JSON.stringify(change.baselineRef)}::jsonb,
          'PENDING')
        on conflict (request_id, ordinal) do nothing`.execute(this.db);
    }
    return updated;
  }

  /** 请求状态推进：只允许从给定状态集合向前，竞态失败由调用方按原行重读。 */
  async setRequestStatus(id: string, input: {
    readonly from: readonly StateMaintenanceStatus[];
    readonly status: StateMaintenanceStatus;
  }): Promise<ConversationStateRequestRow | undefined> {
    return (await sql<ConversationStateRequestRow>`
      update conversation_state_requests set status = ${input.status},
        revision = revision + 1, updated_at = now()
      where id = ${id} and status = any(${sql.val([...input.from])}::text[])
      returning *`.execute(this.db)).rows[0];
  }
}
