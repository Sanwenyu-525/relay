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
  AssistMessageBaselineFileRow, AssistMessageBaselineRow, AssistMessageRecallFileRow,
  AssistMessageRecallFileStatus, AssistMessageRecallRow, AssistMessageRecallStatus,
  AssistMessageRecallProtectionRow, AssistMessageRecallUndoRow,
} from '../infrastructure/database-schema.js';
import type { JsonObject } from '../infrastructure/json.js';

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

export interface RecallFileInput {
  readonly relativePath: string; readonly baselineExisted: boolean;
  readonly baselineSha256: string | null; readonly baselineMessageId: string | null;
  readonly expectedCurrentSha256: string | null;
  readonly observedSha256: string | null; readonly status: AssistMessageRecallFileStatus;
  readonly reason: string | null;
}

export class MessageRecallRepository {
  constructor(private readonly db: DbExecutor) {}

  /**
   * 在 SQL SAVEPOINT 内运行采集的数据库阶段：语句失败只回滚保存点，不把外层消息
   * 准入事务置为 aborted（采集失败不得阻塞消息，§8.5/§27.3.4 的降级语义）。
   * 注意不能用 Kysely 的 transaction()：在裸 Kysely 实例上它会从连接池另开一条
   * 新连接，看不到外层事务里已插入、未提交的消息行（实测 FK 23503 的根因）；
   * 同一连接上的 SAVEPOINT/ROLLBACK TO 才是正确原语。
   */
  async inSavepoint<T>(work: (sp: MessageRecallRepository) => Promise<T>): Promise<T | undefined> {
    const name = `sp_baseline_${Date.now().toString(36)}`;
    const id = sql.raw(`"${name}"`);
    try {
      await sql`savepoint ${id}`.execute(this.db);
      try {
        return await work(this);
      } catch {
        await sql`rollback to savepoint ${id}`.execute(this.db);
        return undefined;
      } finally {
        await sql`release savepoint ${id}`.execute(this.db);
      }
    } catch {
      // 连接不在事务中或保存点机制不可用：外层调用方按 CAPTURE_FAILED 降级处理。
      return undefined;
    }
  }

  // ---- 发送前基线（2026-10-24 用户拍板口径，取代首写前像）----

  async findBaselineByMessage(messageId: string): Promise<AssistMessageBaselineRow | undefined> {
    return (await sql<AssistMessageBaselineRow>`select * from assist_message_baselines
      where message_id = ${messageId}`.execute(this.db)).rows[0];
  }

  async insertBaseline(input: { id: string; workspaceId: string; sessionId: string;
    messageId: string; resourceId: string; rootPath: string;
    status: 'COMPLETE' | 'INCOMPLETE'; reason: string; fileCount: number;
    totalBytes: bigint;
  }): Promise<AssistMessageBaselineRow> {
    const result = await sql<AssistMessageBaselineRow>`
      insert into assist_message_baselines (id, workspace_id, session_id, message_id,
        resource_id, root_path, status, reason, file_count, total_bytes)
      values (${input.id}, ${input.workspaceId}, ${input.sessionId}, ${input.messageId},
        ${input.resourceId}, ${input.rootPath}, ${input.status}, ${input.reason},
        ${input.fileCount}, ${input.totalBytes})
      returning *`.execute(this.db);
    return result.rows[0]!;
  }

  async insertBaselineFiles(baselineId: string, files: readonly {
    relativePath: string; blobSha256: string | null;
    sizeBytes: bigint | null; unavailableReason: string | null;
  }[]): Promise<void> {
    if (files.length === 0) return;
    await sql`insert into assist_message_baseline_files (baseline_id, relative_path,
        existed, blob_sha256, size_bytes, unavailable_reason)
      select ${baselineId}, t.path, true, t.sha, t.size, t.reason
      from unnest(${files.map((f) => f.relativePath)}::text[], ${files.map((f) => f.blobSha256)}::text[],
        ${files.map((f) => f.sizeBytes)}::bigint[], ${files.map((f) => f.unavailableReason)}::text[])
        as t(path, sha, size, reason)`.execute(this.db);
  }

  async listBaselineFiles(baselineId: string):
  Promise<readonly AssistMessageBaselineFileRow[]> {
    return (await sql<AssistMessageBaselineFileRow>`
      select * from assist_message_baseline_files where baseline_id = ${baselineId}
      order by relative_path`.execute(this.db)).rows;
  }

  async readBaselineBlob(blobSha256: string): Promise<Buffer | undefined> {
    return (await sql<{ content: Buffer }>`select content from assist_message_snapshot_blobs
      where blob_sha256 = ${blobSha256}`.execute(this.db)).rows[0]?.content;
  }

  /** 哪些摘要已在字节库中（去重判定；只读）。 */
  async filterExistingBlobShas(shas: readonly string[]): Promise<Set<string>> {
    if (shas.length === 0) return new Set();
    const rows = (await sql<{ blob_sha256: string }>`
      select blob_sha256 from assist_message_snapshot_blobs
      where blob_sha256 = any(${[...shas]}::text[])`.execute(this.db)).rows;
    return new Set(rows.map((row) => row.blob_sha256));
  }

  /**
   * 新增字节入内容寻址库：批内同内容按出现次数计引用；既有行只累加计数。
   * 单条 upsert 原子完成，无并发双插。调用方只传「确认新增」的文件（内容已重读核对）。
   */
  async registerBaselineBlobs(files: readonly { sha256: string; sizeBytes: bigint;
    content: Buffer }[]): Promise<void> {
    if (files.length === 0) return;
    const bySha = new Map<string, { sizeBytes: bigint; count: number; content: Buffer }>();
    for (const file of files) {
      const current = bySha.get(file.sha256);
      if (current === undefined) {
        bySha.set(file.sha256, { sizeBytes: file.sizeBytes, count: 1, content: file.content });
      } else {
        current.count += 1;
      }
    }
    for (const [sha, info] of bySha) {
      await sql`insert into assist_message_snapshot_blobs (blob_sha256, size_bytes, content,
          refcount)
        values (${sha}, ${info.sizeBytes}, ${info.content}, ${info.count})
        on conflict (blob_sha256) do update
          set refcount = assist_message_snapshot_blobs.refcount + excluded.refcount`
        .execute(this.db);
    }
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

  /**
   * §27.3.5 方向放开后的「当前仍生效状态」折叠材料：本会话已结算撤回实际恢复
   * （RESTORED）的路径及其恢复后状态，按结算时间参与期望态计算。
   */
  async listRecallEffectsForFold(sessionId: string, minSeq: bigint): Promise<readonly {
    messageId: string; messageSeq: bigint; relativePath: string;
    exists: boolean; sha256: string | null; rootPath: string; settledAt: Date;
  }[]> {
    const rows = (await sql<{ message_id: string; message_seq: string; relative_path: string;
      baseline_existed: boolean; baseline_sha256: string | null; root_path: string;
      settled_at: Date }>`
      select r.message_id, m.seq::text as message_seq, f.relative_path,
        f.baseline_existed, f.baseline_sha256, r.root_path, r.completed_at as settled_at
      from assist_message_recalls r
      join assist_messages m on m.id = r.message_id
      join assist_message_recall_files f on f.recall_id = r.id
      where r.session_id = ${sessionId} and r.status = 'COMPLETED'
        and f.status = 'RESTORED' and m.seq >= ${minSeq}
      order by m.seq, r.completed_at, f.relative_path`.execute(this.db)).rows;
    return rows.map((row) => ({ messageId: row.message_id, messageSeq: BigInt(row.message_seq),
      relativePath: row.relative_path, exists: row.baseline_existed,
      sha256: row.baseline_sha256 === null ? null : row.baseline_sha256.toLowerCase(),
      rootPath: row.root_path ?? '', settledAt: row.settled_at }));
  }

  /** 把补充事实（如任务重开结果）合并进撤回 detail；只做 jsonb 合并，不改写既有键以外的内容。 */
  async mergeRecallDetail(recallId: string, patch: JsonObject): Promise<void> {
    await sql`update assist_message_recalls
      set detail = detail || ${JSON.stringify(patch)}::jsonb
      where id = ${recallId}`.execute(this.db);
  }

  // ---- §27.3.4 容量预算与保留清理 ----

  /**
   * 工作区快照占用（基线字节库＋保护副本的累计字节）与最旧快照时间。
   * 基线字节按去重后的 blob 行计（§27.3.4 的「实际快照存储」口径）。
   */
  async snapshotUsage(workspaceId: string): Promise<{
    bytes: bigint; count: number; oldestAt: Date | null;
  }> {
    const result = await sql<{ bytes: string; count: string; oldest: Date | null }>`
      with usage as (
        select coalesce(sum(b.size_bytes), 0) as bytes, count(*) as count,
          min(b.created_at) as oldest
        from assist_message_snapshot_blobs b
        where exists (select 1 from assist_message_baselines lb
          where lb.workspace_id = ${workspaceId}
            and exists (select 1 from assist_message_baseline_files f
              where f.baseline_id = lb.id and f.blob_sha256 = b.blob_sha256))
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
    const expiredAt = sql`now() - make_interval(secs => ${seconds})`;
    // 过期基线：不被在途撤回/撤销所在会话引用的整份删除（条目级联）。
    const baselines = await sql`
      delete from assist_message_baselines b
      where b.captured_at < ${expiredAt}
        and not exists (select 1 from assist_message_recalls r
          where r.session_id = b.session_id and r.status = 'RUNNING')
        and not exists (select 1 from assist_message_recall_undos u
          where u.session_id = b.session_id and u.status = 'RUNNING')`.execute(this.db);
    // 字节库引用回收：删掉不再被任何条目引用的 blob（refcount 不再维护精确值，
    // 以「有无引用行」为准——同一事实只有条目一处，不冒充第二套计数）。
    const blobs = await sql`
      delete from assist_message_snapshot_blobs b
      where not exists (select 1 from assist_message_baseline_files f
        where f.blob_sha256 = b.blob_sha256)`.execute(this.db);
    const protections = await sql`
      delete from assist_message_recall_protections p
      using assist_message_recalls r
      where p.recall_id = r.id
        and p.created_at < ${expiredAt}
        and r.status <> 'RUNNING'
        and not exists (select 1 from assist_message_recall_undos u
          where u.source_recall_id = r.id and u.status = 'RUNNING')`.execute(this.db);
    return Number((baselines.numAffectedRows ?? 0n) + (blobs.numAffectedRows ?? 0n)
      + (protections.numAffectedRows ?? 0n));
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
