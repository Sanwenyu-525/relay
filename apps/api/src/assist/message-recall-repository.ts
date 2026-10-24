/**
 * 消息撤回的持久化入口（迁移 0132）。
 *
 * 两块事实分开：
 *   * 文件前像：每次写入落盘前按消息记录，首写优先；这是唯一可信的「发送前真实字节」。
 *   * 撤回回执：一次请求一行，先 RUNNING 后终态；逐文件结果另表保存，便于重读和核对。
 *
 * 本仓库只做落库/读取，资格与冲突判定归 `application/assist-message-recall.ts`。
 */

import { sql } from 'kysely';

import type { DbExecutor } from '../infrastructure/database.js';
import type {
  AssistMessageRecallFileRow, AssistMessageRecallFileStatus, AssistMessageRecallRow,
  AssistMessageRecallStatus, AssistMessageRecallProtectionRow, AssistMessageRecallUndoRow,
} from '../infrastructure/database-schema.js';
import type { JsonObject } from '../infrastructure/json.js';

export interface MessageFilePreimageRow {
  readonly message_id: string; readonly workspace_id: string; readonly session_id: string;
  readonly relative_path: string; readonly existed: boolean;
  readonly content: Buffer | null; readonly sha256: string | null;
  readonly size_bytes: bigint | null; readonly unavailable_reason: string | null;
  readonly source: 'SESSION_WRITE' | 'RUN_WRITE'; readonly created_at: Date;
}

export interface DirectWriteOperationRow {
  readonly message_id: string; readonly message_seq: bigint;
  readonly call_status: 'SETTLED' | 'UNKNOWN';
  readonly operation_status: string;
  readonly root_path: string;
  readonly params: JsonObject;
  readonly result_ref: JsonObject | null;
  readonly observed_at: Date;
}

export interface DelegatedWriteFileRow {
  readonly message_id: string; readonly message_seq: bigint;
  /** 该委派执行绑定的 Task；请求尚未建 Task 时为 null。 */
  readonly task_id: string | null;
  readonly change_set_status: 'SUCCEEDED' | 'PARTIAL' | 'UNKNOWN';
  readonly root_path: string; readonly relative_path: string;
  readonly action: 'CREATE' | 'MODIFY' | 'DELETE';
  readonly file_status: 'APPLIED' | 'CONFLICT' | 'FAILED';
  readonly target_sha256: string | null; readonly actual_sha256: string | null;
  readonly observed_at: Date;
}

export interface InsertPreimageInput {
  readonly messageId: string; readonly workspaceId: string; readonly sessionId: string;
  readonly relativePath: string; readonly existed: boolean;
  readonly content: Buffer | null; readonly sha256: string | null;
  readonly sizeBytes: bigint | null; readonly unavailableReason: string | null;
  readonly source: 'SESSION_WRITE' | 'RUN_WRITE';
}

export interface RecallFileInput {
  readonly relativePath: string; readonly baselineExisted: boolean;
  readonly baselineSha256: string | null; readonly baselineMessageId: string | null;
  readonly expectedCurrentSha256: string | null;
  readonly observedSha256: string | null; readonly status: AssistMessageRecallFileStatus;
  readonly reason: string | null;
}

export class MessageRecallRepository {
  constructor(private readonly db: DbExecutor) {}

  /** 写入前像：首写优先。重放/重试不覆盖已记录的真实前像。 */
  async insertPreimage(input: InsertPreimageInput): Promise<void> {
    await sql`insert into assist_message_file_preimages (message_id, workspace_id, session_id,
      relative_path, existed, content, sha256, size_bytes, unavailable_reason, source)
      values (${input.messageId}, ${input.workspaceId}, ${input.sessionId},
        ${input.relativePath}, ${input.existed}, ${input.content}, ${input.sha256},
        ${input.sizeBytes}, ${input.unavailableReason}, ${input.source})
      on conflict (message_id, relative_path) do nothing`.execute(this.db);
  }

  async listPreimages(sessionId: string, minSeq: bigint): Promise<readonly MessageFilePreimageRow[]> {
    return (await sql<MessageFilePreimageRow>`select p.* from assist_message_file_preimages p
      join assist_messages m on m.id = p.message_id
      where p.session_id = ${sessionId} and m.seq >= ${minSeq}
      order by m.seq, p.created_at, p.relative_path`.execute(this.db)).rows;
  }

  async findSessionToolCallByOperation(operationId: string): Promise<{
    session_id: string; message_id: string; workspace_id: string;
  } | undefined> {
    return (await sql<{ session_id: string; message_id: string; workspace_id: string }>`
      select stc.session_id, stc.message_id, s.workspace_id
      from session_tool_calls stc
      join assist_sessions s on s.id = stc.session_id
      where stc.operation_id = ${operationId}`.execute(this.db)).rows[0];
  }

  async findConversationRequestByRun(workspaceId: string, runId: string): Promise<{
    session_id: string; source_message_id: string;
  } | undefined> {
    return (await sql<{ session_id: string; source_message_id: string }>`
      select session_id, source_message_id from conversation_execution_requests
      where workspace_id = ${workspaceId} and run_id = ${runId}
      order by created_at desc limit 1`.execute(this.db)).rows[0];
  }

  async listDirectWriteOperations(sessionId: string, minSeq: bigint):
  Promise<readonly DirectWriteOperationRow[]> {
    return (await sql<DirectWriteOperationRow>`select stc.message_id, m.seq as message_seq,
        stc.status as call_status, op.status as operation_status,
        op.normalized_target as root_path, op.params, op.result_ref,
        coalesce(stc.settled_at, stc.requested_at) as observed_at
      from session_tool_calls stc
      join assist_messages m on m.id = stc.message_id
      join logical_operations op on op.id = stc.operation_id
      where stc.session_id = ${sessionId}
        and stc.tool_name = 'apply_changeset'
        and stc.status in ('SETTLED', 'UNKNOWN')
        and m.seq >= ${minSeq}
        and op.origin = 'AGENT_SESSION_WRITE'
        and op.action_type = 'APPLY_CHANGESET'
      order by m.seq, observed_at`.execute(this.db)).rows;
  }

  async listDelegatedWriteFiles(workspaceId: string, sessionId: string, minSeq: bigint):
  Promise<readonly DelegatedWriteFileRow[]> {
    return (await sql<DelegatedWriteFileRow>`select q.source_message_id as message_id,
        q.task_id, m.seq as message_seq, cs.status as change_set_status,
        cs.canonical_root as root_path, f.relative_path, f.action,
        f.status as file_status, f.target_sha256, f.actual_sha256, cs.created_at as observed_at
      from conversation_execution_requests q
      join assist_messages m on m.id = q.source_message_id
      join change_sets cs on cs.run_id = q.run_id and cs.workspace_id = q.workspace_id
      join change_set_files f on f.change_set_id = cs.id and f.invocation_id = cs.invocation_id
      where q.workspace_id = ${workspaceId} and q.session_id = ${sessionId}
        and m.seq >= ${minSeq}
      order by m.seq, cs.created_at, f.relative_path`.execute(this.db)).rows;
  }

  /** 目标消息之后仍非终态的消息（撤回前必须全部结束）。 */
  async listNonTerminalMessagesFrom(sessionId: string, minSeq: bigint): Promise<readonly {
    id: string; seq: bigint; status: string;
  }[]> {
    return (await sql<{ id: string; seq: bigint; status: string }>`select id, seq, status
      from assist_messages
      where session_id = ${sessionId} and seq >= ${minSeq}
        and status in ('PENDING', 'RUNNING')
      order by seq`.execute(this.db)).rows;
  }

  /** 目标消息之后仍未结算的会话工具调用。 */
  async listOpenToolCallsFrom(sessionId: string, minSeq: bigint): Promise<readonly string[]> {
    return (await sql<{ id: string }>`select stc.id from session_tool_calls stc
      join assist_messages m on m.id = stc.message_id
      where stc.session_id = ${sessionId} and m.seq >= ${minSeq}
        and stc.status = 'REQUESTED'
      order by stc.id`.execute(this.db)).rows.map((row) => row.id);
  }

  /** 已撤回用户消息的最大 seq：首版只允许沿对话向后逐条撤回，禁止嵌套/倒序。 */
  async maxWithdrawnUserSeq(sessionId: string): Promise<bigint | null> {
    return (await sql<{ seq: bigint | null }>`select max(m.seq) as seq
      from assist_messages m
      join assist_message_recalls r on r.message_id = m.id
      where m.session_id = ${sessionId} and m.role = 'USER'
        and m.withdrawn_at is not null`.execute(this.db)).rows[0]?.seq ?? null;
  }

  async findRecallByMessage(messageId: string): Promise<AssistMessageRecallRow | undefined> {
    return (await sql<AssistMessageRecallRow>`select * from assist_message_recalls
      where message_id = ${messageId}`.execute(this.db)).rows[0];
  }

  async findRecallById(recallId: string): Promise<AssistMessageRecallRow | undefined> {
    return (await sql<AssistMessageRecallRow>`select * from assist_message_recalls
      where id = ${recallId}`.execute(this.db)).rows[0];
  }

  async findRecallByCommand(workspaceId: string, commandId: string):
  Promise<AssistMessageRecallRow | undefined> {
    return (await sql<AssistMessageRecallRow>`select * from assist_message_recalls
      where workspace_id = ${workspaceId} and command_id = ${commandId}`.execute(this.db)).rows[0];
  }

  /**
   * 会话里是否还有未结算的撤回（含崩溃遗留的 RUNNING）。
   *
   * 不按心跳区分新鲜度：撤回一旦开始，目标消息之后的新写入都会改变「需要回退的文件集合」，
   * 若允许过期回执期间继续发送，接续恢复就会漏掉这些写入。过期只用于判定能否接续执行，
   * 不用于放行新消息。
   */
  async hasRunningRecall(sessionId: string): Promise<boolean> {
    return (await sql<{ id: string }>`select id from assist_message_recalls
      where session_id = ${sessionId} and status = 'RUNNING'
      limit 1`.execute(this.db)).rows.length > 0;
  }

  /**
   * 认领一条过期 RUNNING 回执，作为唯一接续执行者。
   *
   * 条件更新而不是先读后写：两个客户端同时发现回执过期时，只有一个能把心跳推到现在，
   * 另一个看不到任何变化并按「仍在进行」返回，不会并行恢复同一组文件。
   */
  async claimStaleRecall(recallId: string, staleAfterMs: number): Promise<boolean> {
    const result = await sql`update assist_message_recalls set last_resumed_at = now()
      where id = ${recallId} and status = 'RUNNING'
        and coalesce(last_resumed_at, requested_at) <
          now() - make_interval(secs => ${staleAfterMs / 1000})`
      .execute(this.db);
    return (result.numAffectedRows ?? 0n) > 0n;
  }

  /** 恢复执行期间的心跳，避免长任务被第二个客户端误判为崩溃遗留。 */
  async touchRunningRecall(recallId: string): Promise<void> {
    await sql`update assist_message_recalls set last_resumed_at = now()
      where id = ${recallId} and status = 'RUNNING'`.execute(this.db);
  }

  async insertRecall(input: {
    id: string; workspaceId: string; sessionId: string; messageId: string;
    assistantMessageId: string; commandId: string; rootPath: string | null;
    plannedFiles: number; files: readonly RecallFileInput[];
  }): Promise<void> {
    await sql`insert into assist_message_recalls (id, workspace_id, session_id, message_id,
      assistant_message_id, command_id, status, root_path, planned_files)
      values (${input.id}, ${input.workspaceId}, ${input.sessionId}, ${input.messageId},
        ${input.assistantMessageId}, ${input.commandId}, 'RUNNING', ${input.rootPath},
        ${input.plannedFiles})`.execute(this.db);
    for (const file of input.files) {
      await sql`insert into assist_message_recall_files (recall_id, relative_path,
        baseline_existed, baseline_sha256, baseline_message_id, expected_current_sha256,
        observed_sha256, status, reason)
        values (${input.id}, ${file.relativePath}, ${file.baselineExisted}, ${file.baselineSha256},
          ${file.baselineMessageId}, ${file.expectedCurrentSha256}, ${file.observedSha256},
          ${file.status}, ${file.reason})`
        .execute(this.db);
    }
  }

  async updateRecallFile(recallId: string, relativePath: string, update: {
    observedSha256: string | null; status: AssistMessageRecallFileStatus; reason: string | null;
  }): Promise<void> {
    await sql`update assist_message_recall_files
      set observed_sha256 = ${update.observedSha256}, status = ${update.status},
        reason = ${update.reason}, updated_at = now()
      where recall_id = ${recallId} and relative_path = ${relativePath}`.execute(this.db);
  }

  async finalizeRecall(input: {
    id: string; status: AssistMessageRecallStatus; restoredFiles: number;
    skippedFiles: number; detail: JsonObject; withdrawnMessageIds: readonly string[];
  }): Promise<void> {
    await sql`update assist_message_recalls
      set status = ${input.status}, restored_files = ${input.restoredFiles},
        skipped_files = ${input.skippedFiles}, detail = ${JSON.stringify(input.detail)}::jsonb,
        completed_at = now()
      where id = ${input.id}`.execute(this.db);
    for (const messageId of input.withdrawnMessageIds) {
      await sql`update assist_messages
        set withdrawn_at = now(), withdrawn_by_recall_id = ${input.id}
        where id = ${messageId} and withdrawn_at is null`.execute(this.db);
    }
  }

  async listRecallFiles(recallId: string): Promise<readonly AssistMessageRecallFileRow[]> {
    return (await sql<AssistMessageRecallFileRow>`select * from assist_message_recall_files
      where recall_id = ${recallId} order by relative_path`.execute(this.db)).rows;
  }

  async listRecallsForSession(sessionId: string): Promise<readonly AssistMessageRecallRow[]> {
    return (await sql<AssistMessageRecallRow>`select * from assist_message_recalls
      where session_id = ${sessionId} order by requested_at`.execute(this.db)).rows;
  }

  // ---- §27.3.3 单层撤销：保护副本与撤销回执 ----

  /** 首个恢复写入前保存目标文件当前内容；重复路径（接续重跑）不覆盖首份。 */
  async insertProtections(recallId: string, files: readonly {
    relativePath: string; existed: boolean; content: Buffer | null;
    sha256: string | null; sizeBytes: bigint | null; unavailableReason: string | null;
  }[]): Promise<void> {
    for (const file of files) {
      await sql`insert into assist_message_recall_protections (recall_id, relative_path,
        existed, content, sha256, size_bytes, unavailable_reason)
      values (${recallId}, ${file.relativePath}, ${file.existed}, ${file.content},
        ${file.sha256}, ${file.sizeBytes}, ${file.unavailableReason})
      on conflict (recall_id, relative_path) do nothing`.execute(this.db);
    }
  }

  async listProtections(recallId: string):
  Promise<readonly AssistMessageRecallProtectionRow[]> {
    return (await sql<AssistMessageRecallProtectionRow>`
      select * from assist_message_recall_protections where recall_id = ${recallId}
      order by relative_path`.execute(this.db)).rows;
  }

  /**
   * 是否存在比给定撤回更新的完整成功撤回（单层撤销只指向最近一次）。
   * 用 (requested_at, id) 元组与自身行比较：JS Date 只有毫秒精度，直接传时间戳参数
   * 会让微秒精度的自身行被误判为「更新」（RA-05 实测命中过该陷阱）。
   */
  async existsNewerCompletedRecall(sessionId: string, recallId: string): Promise<boolean> {
    const rows = (await sql<{ id: string }>`
      select other.id from assist_message_recalls other
      join assist_message_recalls self on self.id = ${recallId}
      where other.session_id = ${sessionId} and other.status = 'COMPLETED'
        and (other.requested_at, other.id) > (self.requested_at, self.id)
      limit 1`.execute(this.db)).rows;
    return rows.length > 0;
  }

  async insertUndo(input: { id: string; workspaceId: string; sessionId: string;
    sourceRecallId: string; commandId: string; rootPath: string;
  }): Promise<AssistMessageRecallUndoRow> {
    const result = await sql<AssistMessageRecallUndoRow>`
      insert into assist_message_recall_undos (id, workspace_id, session_id,
        source_recall_id, command_id, status, root_path)
      values (${input.id}, ${input.workspaceId}, ${input.sessionId}, ${input.sourceRecallId},
        ${input.commandId}, 'RUNNING', ${input.rootPath})
      returning *`.execute(this.db);
    return result.rows[0]!;
  }

  async findUndoBySource(sourceRecallId: string):
  Promise<AssistMessageRecallUndoRow | undefined> {
    return (await sql<AssistMessageRecallUndoRow>`select * from assist_message_recall_undos
      where source_recall_id = ${sourceRecallId}`.execute(this.db)).rows[0];
  }

  async findUndoByCommand(workspaceId: string, commandId: string):
  Promise<AssistMessageRecallUndoRow | undefined> {
    return (await sql<AssistMessageRecallUndoRow>`select * from assist_message_recall_undos
      where workspace_id = ${workspaceId} and command_id = ${commandId}`.execute(this.db))
      .rows[0];
  }

  async hasRunningUndo(sessionId: string): Promise<boolean> {
    return (await sql<{ id: string }>`select id from assist_message_recall_undos
      where session_id = ${sessionId} and status = 'RUNNING' limit 1`.execute(this.db))
      .rows.length > 0;
  }

  /** 认领过期 RUNNING 撤销作为唯一接续执行者；未过期返回 false。 */
  async claimStaleUndo(undoId: string, staleAfterMs: number): Promise<boolean> {
    const result = await sql`update assist_message_recall_undos set last_resumed_at = now()
      where id = ${undoId} and status = 'RUNNING'
        and coalesce(last_resumed_at, requested_at) <
          now() - make_interval(secs => ${staleAfterMs / 1000})`.execute(this.db);
    return (result.numAffectedRows ?? 0n) > 0n;
  }

  /** 把补充事实（如任务重开结果）合并进撤回 detail；只做 jsonb 合并，不改写既有键以外的内容。 */
  async mergeRecallDetail(recallId: string, patch: JsonObject): Promise<void> {
    await sql`update assist_message_recalls
      set detail = detail || ${JSON.stringify(patch)}::jsonb
      where id = ${recallId}`.execute(this.db);
  }

  // ---- §27.3.4 容量预算与保留清理 ----

  /**
   * 工作区快照占用（前像＋保护副本的累计字节）与最旧快照时间。
   * 前像有 workspace_id 列；保护副本经撤回行取工作区。
   */
  async snapshotUsage(workspaceId: string): Promise<{
    bytes: bigint; count: number; oldestAt: Date | null;
  }> {
    const result = await sql<{ bytes: string; count: string; oldest: Date | null }>`
      with usage as (
        select coalesce(sum(size_bytes), 0) as bytes, count(*) as count, min(created_at) as oldest
        from assist_message_file_preimages where workspace_id = ${workspaceId}
        union all
        select coalesce(sum(p.size_bytes), 0), count(*), min(p.created_at)
        from assist_message_recall_protections p
        join assist_message_recalls r on r.id = p.recall_id
        where r.workspace_id = ${workspaceId}
      )
      select coalesce(sum(bytes), 0)::text as bytes, coalesce(sum(count), 0)::text as count,
        min(oldest) as oldest from usage`.execute(this.db);
    const row = result.rows[0]!;
    return { bytes: BigInt(row.bytes ?? '0'), count: Number(row.count ?? '0'),
      oldestAt: row.oldest };
  }

  /**
   * 保留期清理（§27.3.4）：删除超过保留期、且不被任何在途撤回/撤销引用的快照，
   * 按最旧优先（DELETE 天然按年龄谓词）。正在捕获、RUNNING 撤回/撤销所在会话的
   * 字节一律不动；被清理的消息此后如实报告「缺少基线/副本」而不是静默可恢复。
   * 返回删除的行数。
   */
  async sweepExpiredSnapshots(retentionDays: number): Promise<number> {
    const seconds = Math.max(0, Math.round(retentionDays * 86400));
    const preimages = await sql`
      delete from assist_message_file_preimages p
      where p.created_at < now() - make_interval(secs => ${seconds})
        and not exists (select 1 from assist_message_recalls r
          where r.session_id = p.session_id and r.status = 'RUNNING')
        and not exists (select 1 from assist_message_recall_undos u
          where u.session_id = p.session_id and u.status = 'RUNNING')`.execute(this.db);
    const protections = await sql`
      delete from assist_message_recall_protections p
      using assist_message_recalls r
      where p.recall_id = r.id
        and p.created_at < now() - make_interval(secs => ${seconds})
        and r.status <> 'RUNNING'
        and not exists (select 1 from assist_message_recall_undos u
          where u.source_recall_id = r.id and u.status = 'RUNNING')`.execute(this.db);
    return Number((preimages.numAffectedRows ?? 0n) + (protections.numAffectedRows ?? 0n));
  }

  async finalizeUndo(id: string, status: AssistMessageRecallStatus,
    files: JsonObject, detail: JsonObject): Promise<AssistMessageRecallUndoRow> {
    const result = await sql<AssistMessageRecallUndoRow>`
      update assist_message_recall_undos set status = ${status},
        files = ${JSON.stringify(files)}::jsonb, detail = ${JSON.stringify(detail)}::jsonb,
        completed_at = now()
      where id = ${id} returning *`.execute(this.db);
    return result.rows[0]!;
  }
}
