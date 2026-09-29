import { sql } from 'kysely';

import type { AssistMessagePreviewRow, AssistMessageRow, AssistProposalRow,
  AssistSessionRow } from '../infrastructure/database-schema.js';
import type { DbExecutor } from '../infrastructure/database.js';
import type { JsonObject } from '../infrastructure/json.js';

/**
 * Assist 模块独占 assist_sessions / assist_messages / assist_proposals 的写入口
 * （红线 1：每类事实只有一个逻辑写入 Owner）。Assist 行不参与业务判定；
 * 提案接受效果由既有业务命令产生，这里只保存提案事实本身。
 */
export class AssistRepository {
  constructor(private readonly db: DbExecutor) {}

  async insertSession(input: { id: string; workspaceId: string; projectId: string | null;
    taskId: string | null; title: string }): Promise<void> {
    await sql`insert into assist_sessions (id, workspace_id, project_id, task_id, title)
      values (${input.id}, ${input.workspaceId}, ${input.projectId}, ${input.taskId},
      ${input.title})`.execute(this.db);
  }

  async readSession(id: string, lock = false): Promise<AssistSessionRow | undefined> {
    const suffix = lock ? sql`for update` : sql``;
    return (await sql<AssistSessionRow>`select * from assist_sessions
      where id = ${id} ${suffix}`.execute(this.db)).rows[0];
  }

  async listSessions(workspaceId: string, projectId?: string,
    taskId?: string): Promise<readonly AssistSessionRow[]> {
    const project = projectId === undefined ? sql`` : sql`and project_id = ${projectId}`;
    const task = taskId === undefined ? sql`` : sql`and task_id = ${taskId}`;
    return (await sql<AssistSessionRow>`select * from assist_sessions
      where workspace_id = ${workspaceId} ${project} ${task}
      order by created_at desc, id desc`.execute(this.db)).rows;
  }

  async archiveSession(id: string): Promise<void> {
    await sql`update assist_sessions set status = 'ARCHIVED', revision = revision + 1,
      updated_at = now() where id = ${id}`.execute(this.db);
  }

  /** 消息序号在会话行锁下分配，保证 (session_id, seq) 严格递增且无并发空洞。 */
  async nextMessageSeq(sessionId: string): Promise<bigint> {
    const row = await sql<{ seq: bigint }>`select coalesce(max(seq), 0) + 1 as seq
      from assist_messages where session_id = ${sessionId}`.execute(this.db);
    return row.rows[0]!.seq;
  }

  async insertMessage(input: { id: string; sessionId: string; seq: bigint;
    role: AssistMessageRow['role']; status: AssistMessageRow['status'];
    intent: AssistMessageRow['intent']; content: string | null;
    sources: readonly JsonObject[]; skillSnapshot?: JsonObject | null;
    skillInput?: JsonObject | null }): Promise<void> {
    await sql`insert into assist_messages (id, session_id, seq, role, status, intent,
      content, sources, skill_snapshot, skill_input) values (${input.id}, ${input.sessionId},
      ${input.seq}, ${input.role},
      ${input.status}, ${input.intent}, ${input.content},
      ${JSON.stringify(input.sources)}::jsonb,
      ${input.skillSnapshot === undefined || input.skillSnapshot === null ? null :
        JSON.stringify(input.skillSnapshot)}::jsonb,
      ${input.skillInput === undefined || input.skillInput === null ? null :
        JSON.stringify(input.skillInput)}::jsonb)`.execute(this.db);
  }

  async readMessage(id: string, lock: boolean | 'share' = false): Promise<AssistMessageRow | undefined> {
    const suffix = lock === 'share' ? sql`for share` : lock ? sql`for update` : sql``;
    return (await sql<AssistMessageRow>`select * from assist_messages
      where id = ${id} ${suffix}`.execute(this.db)).rows[0];
  }

  async readLivePreview(messageId: string): Promise<AssistMessagePreviewRow | undefined> {
    return (await sql<AssistMessagePreviewRow>`select * from assist_message_previews
      where message_id = ${messageId}`.execute(this.db)).rows[0];
  }

  /** Only the current generation owner can replace its bounded temporary prefix. */
  async writeLivePreview(messageId: string, workerId: string, previewText: string,
    truncated: boolean): Promise<boolean> {
    return (await sql<{ message_id: string }>`with owner as materialized (
      select id from assist_messages where id = ${messageId}
        and role = 'ASSISTANT' and intent = 'DISCUSS' and skill_snapshot is null
        and status = 'RUNNING' and worker_id = ${workerId}
        and cancel_requested = false for update
    )
    insert into assist_message_previews (message_id, preview_text, truncated)
    select id, ${previewText}, ${truncated} from owner
    on conflict (message_id) do update set
      revision = assist_message_previews.revision + 1,
      preview_text = excluded.preview_text, truncated = excluded.truncated,
      updated_at = now()
    returning message_id`.execute(this.db)).rows.length === 1;
  }

  async listMessages(sessionId: string, limit?: number): Promise<readonly AssistMessageRow[]> {
    const bounded = limit === undefined ? sql`` : sql`limit ${limit}`;
    return (await sql<AssistMessageRow>`select * from assist_messages
      where session_id = ${sessionId} order by seq ${bounded}`.execute(this.db)).rows;
  }

  async listCompletedHistory(sessionId: string, throughSeq: bigint,
    limit = 20): Promise<readonly AssistMessageRow[]> {
    const rows = (await sql<AssistMessageRow>`select * from assist_messages
      where session_id = ${sessionId} and seq <= ${throughSeq} and status = 'COMPLETED'
      order by seq desc limit ${limit}`.execute(this.db)).rows;
    return rows.reverse();
  }

  /** 监督器只为可领取消息或待清扫的失联领取启动子 Worker。 */
  async hasRunnableGeneration(olderThan: Date): Promise<boolean> {
    const result = await sql<{ id: string }>`select m.id from assist_messages m
      join assist_sessions s on s.id = m.session_id
      left join projects p on p.id = s.project_id
      where (m.status = 'PENDING' and (s.project_id is null or p.archived_at is null))
        or (m.status = 'RUNNING' and m.updated_at < ${olderThan})
      limit 1`.execute(this.db);
    return result.rows.length > 0;
  }

  /** 原子领取：for update skip locked 保证多 Worker/多 tick 恰好一个领取者。 */
  async claimNextPendingMessage(workerId: string): Promise<AssistMessageRow | undefined> {
    return (await sql<AssistMessageRow>`update assist_messages set status = 'RUNNING',
      worker_id = ${workerId}, updated_at = now()
      where id = (select m.id from assist_messages m
        join assist_sessions s on s.id = m.session_id
        left join projects p on p.id = s.project_id
        where m.status = 'PENDING' and (s.project_id is null or p.archived_at is null)
        order by m.created_at, m.id limit 1 for update of m skip locked)
      returning *`.execute(this.db)).rows[0];
  }

  /** 取消意图先持久化（红线 7）：PENDING 直接收敛，RUNNING 只记录意图由生成方结算。 */
  async setCancelRequested(id: string): Promise<'CANCELLED' | 'REQUESTED' | 'UNSETTLED'> {
    return (await sql<{ status: AssistMessageRow['status'] }>`
      update assist_messages set
        status = case when status = 'PENDING' then 'CANCELLED' else status end,
        cancel_requested = true,
        updated_at = now()
      where id = ${id} and status in ('PENDING', 'RUNNING')
      returning status
    `.execute(this.db)).rows[0]?.status === 'CANCELLED' ? 'CANCELLED' :
      ((await this.readMessage(id))?.cancel_requested === true ? 'REQUESTED' : 'UNSETTLED');
  }

  /** 生成完成按领取身份 CAS 结算：迟到的旧 Worker 不能覆盖新状态。 */
  async settleGeneration(input: { messageId: string; workerId: string;
    status: 'COMPLETED' | 'FAILED' | 'CANCELLED';
    content: string | null; errorCode: string | null; providerRequestId: string | null;
    usageInputTokens: number | null; usageOutputTokens: number | null;
    finalSources?: readonly JsonObject[] | undefined;
    skillOutput?: JsonObject | undefined }): Promise<boolean> {
    const sources = input.finalSources === undefined ? sql`` :
      sql`, sources = ${JSON.stringify(input.finalSources)}::jsonb`;
    const skillOutput = input.skillOutput === undefined ? sql`` :
      sql`, skill_output = ${JSON.stringify(input.skillOutput)}::jsonb`;
    const updated = (await sql<{ id: string }>`update assist_messages set status = ${input.status},
      content = ${input.content}, error_code = ${input.errorCode},
      provider_request_id = ${input.providerRequestId},
      usage_input_tokens = ${input.usageInputTokens},
      usage_output_tokens = ${input.usageOutputTokens},
      worker_id = ${input.workerId}, updated_at = now()${sources}${skillOutput}
      where id = ${input.messageId} and status = 'RUNNING' and worker_id = ${input.workerId}
      returning id`.execute(this.db)).rows.length > 0;
    if (updated) {
      await sql`delete from assist_message_previews where message_id = ${input.messageId}`
        .execute(this.db);
    }
    return updated;
  }

  /** 生成期间的心跳：RUNNING 行持续续租，崩溃后由租约清扫收敛（LEASE_LOST 不会误伤活 Worker）。 */
  async heartbeatGeneration(messageId: string, workerId: string): Promise<boolean> {
    return (await sql<{ id: string }>`update assist_messages set updated_at = now()
      where id = ${messageId} and status = 'RUNNING' and worker_id = ${workerId}
      returning id`.execute(this.db)).rows.length > 0;
  }

  async isCancelRequested(messageId: string): Promise<boolean> {
    return (await sql<{ cancel_requested: boolean }>`select cancel_requested
      from assist_messages where id = ${messageId}`.execute(this.db)).rows[0]?.cancel_requested
      === true;
  }

  /** 租约过期仍处于 RUNNING 的消息按 LEASE_LOST 收敛；Worker 崩溃不悬挂生成状态。 */
  async failExpiredLeases(olderThan: Date): Promise<readonly string[]> {
    return (await sql<{ id: string }>`with failed as (
      update assist_messages set status = 'FAILED', error_code = 'LEASE_LOST',
        worker_id = null, updated_at = now()
      where status = 'RUNNING' and updated_at < ${olderThan} returning id
    ), cleared as (
      delete from assist_message_previews where message_id in (select id from failed)
    ) select id from failed`
      .execute(this.db)).rows.map((row) => row.id);
  }

  async insertProposal(input: { id: string; workspaceId: string; sessionId: string;
    messageId: string; kind: AssistProposalRow['kind']; projectId: string | null;
    taskId: string | null; targetType: AssistProposalRow['target_type']; targetId: string;
    baseRevision: bigint; baseAcceptanceRevision?: bigint | null;
    payload: JsonObject; payloadHash: string; skillSha256?: string | null;
    skillOutputSha256?: string | null }): Promise<void> {
    await sql`insert into assist_proposals (id, workspace_id, session_id, message_id, kind,
      project_id, task_id, target_type, target_id, base_revision,
      base_acceptance_revision, payload, payload_hash, skill_sha256, skill_output_sha256)
      values (${input.id}, ${input.workspaceId}, ${input.sessionId}, ${input.messageId},
      ${input.kind}, ${input.projectId}, ${input.taskId}, ${input.targetType},
      ${input.targetId}, ${input.baseRevision}, ${input.baseAcceptanceRevision ?? null},
      ${JSON.stringify(input.payload)}::jsonb, ${input.payloadHash},
      ${input.skillSha256 ?? null}, ${input.skillOutputSha256 ?? null})`.execute(this.db);
  }

  async readProposal(id: string, lock = false): Promise<AssistProposalRow | undefined> {
    const suffix = lock ? sql`for update` : sql``;
    return (await sql<AssistProposalRow>`select * from assist_proposals
      where id = ${id} ${suffix}`.execute(this.db)).rows[0];
  }

  async listProposals(workspaceId: string, filters: { sessionId?: string;
    status?: string; kind?: string }): Promise<readonly AssistProposalRow[]> {
    const session = filters.sessionId === undefined ? sql`` : sql`and session_id = ${filters.sessionId}`;
    const status = filters.status === undefined ? sql`` : sql`and status = ${filters.status}`;
    const kind = filters.kind === undefined ? sql`` : sql`and kind = ${filters.kind}`;
    return (await sql<AssistProposalRow>`select * from assist_proposals
      where workspace_id = ${workspaceId} ${session} ${status} ${kind}
      order by created_at desc, id desc`.execute(this.db)).rows;
  }

  /** 提案状态 CAS 结算；decided_at 只在首次决断时写入。 */
  async settleProposal(id: string, status: Exclude<AssistProposalRow['status'], 'PENDING'>,
    decision: JsonObject): Promise<boolean> {
    return (await sql<{ id: string }>`update assist_proposals set status = ${status},
      decision = ${JSON.stringify(decision)}::jsonb, decided_at = now(), updated_at = now()
      where id = ${id} and status = 'PENDING' returning id`.execute(this.db)).rows.length > 0;
  }
}
