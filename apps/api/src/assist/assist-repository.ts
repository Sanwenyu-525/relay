import { sql } from 'kysely';

import type { AssistMessageAttachmentRow, AssistMessagePreviewRow, AssistMessageRow,
  AssistProposalRow, AssistSessionRow, AssistSessionStatus, ConversationMode } from '../infrastructure/database-schema.js';
import type { DbExecutor } from '../infrastructure/database.js';
import type { JsonObject } from '../infrastructure/json.js';

export interface AssistSessionContext {
  readonly session_id: string;
  readonly session_revision: bigint;
  readonly project_goals: readonly { readonly goal_id: string; readonly title: string }[];
  readonly working_directory: { readonly resource_id: string; readonly canonical_root: string | null } | null;
}

/**
 * Assist 模块独占 assist_sessions / assist_messages / assist_proposals 的写入口
 * （红线 1：每类事实只有一个逻辑写入 Owner）。Assist 行不参与业务判定；
 * 提案接受效果由既有业务命令产生，这里只保存提案事实本身。
 */
export class AssistRepository {
  constructor(private readonly db: DbExecutor) {}

  /**
   * 建会话时冻结身份：模式与人设快照在同一事务内写入，因此不存在「会话已建立但身份漏写」
   * 的中间态。AGENT 会话的四个 助手 列必须全为 null，BOT 会话必须全有值——
   * 由 0059 的 CHECK 兜底，这里只保证写入形状与调用方意图一致。
   */
  async insertSession(input: { id: string; workspaceId: string; projectId: string | null;
    taskId: string | null; title: string;
    conversationMode?: ConversationMode | undefined;
    assistantProfileId?: string | null | undefined;
    assistantProfileRevision?: bigint | null | undefined;
    assistantRoleSnapshot?: JsonObject | null | undefined }): Promise<void> {
    const mode = input.conversationMode ?? 'AGENT';
    await sql`insert into assist_sessions (id, workspace_id, project_id, task_id, title,
      conversation_mode, assistant_profile_id, assistant_profile_revision, assistant_role_snapshot)
      values (${input.id}, ${input.workspaceId}, ${input.projectId}, ${input.taskId},
      ${input.title}, ${mode},
      ${mode === 'ASSISTANT' ? input.assistantProfileId ?? null : null},
      ${mode === 'ASSISTANT' ? input.assistantProfileRevision ?? null : null},
      ${mode === 'ASSISTANT' && input.assistantRoleSnapshot !== undefined && input.assistantRoleSnapshot !== null
        ? JSON.stringify(input.assistantRoleSnapshot) : null}::jsonb)`.execute(this.db);
  }

  async readSession(id: string, lock = false): Promise<AssistSessionRow | undefined> {
    const suffix = lock ? sql`for update` : sql``;
    return (await sql<AssistSessionRow>`select * from assist_sessions
      where id = ${id} ${suffix}`.execute(this.db)).rows[0];
  }

  /**
   * 会话列表：置顶优先，其余按创建时间倒序（0090）。
   *
   * `status` 由调用方显式给出——HTTP 层默认只列 ACTIVE，`all`/`archived` 是左栏「已归档」
   * 那一段的读法。缺省不过滤，是为了让内部读取（按项目/任务定位会话）继续看得到全部身份。
   * 排序键用 `pinned_at desc nulls last`：置顶项之间按置顶时刻倒序，未置顶的落在后面，
   * 不再追加第二枚布尔排序键，避免「同现同缺」写成两套规则。
   */
  async listSessions(workspaceId: string, projectId?: string, taskId?: string,
    status?: AssistSessionStatus | 'ALL'): Promise<readonly AssistSessionRow[]> {
    const project = projectId === undefined ? sql`` : sql`and project_id = ${projectId}`;
    const task = taskId === undefined ? sql`` : sql`and task_id = ${taskId}`;
    const active = status === undefined || status === 'ALL' ? sql``
      : sql`and status = ${status}`;
    return (await sql<AssistSessionRow>`select * from assist_sessions
      where workspace_id = ${workspaceId} ${project} ${task} ${active}
      order by pinned_at desc nulls last, created_at desc, id desc`.execute(this.db)).rows;
  }

  /**
   * 改名、置顶、归档、重开与未读共用这一条带 CAS 的会话改写（0090 / 0104）。
   *
   * `where revision = 期望值` 是唯一的并发裁决点：调用方已在同一事务内取到 `for update`
   * 行锁并比对过修订，这里落空即返回 undefined，由用例翻成 `REVISION_CONFLICT`，
   * 绝不静默覆盖更新的值。`pinnedAt`/`unreadAt` 用 `undefined`/`null` 区分「不改」与
   * 「取消」，因为取消置顶与取消未读都是把那一项写回 NULL，不是删掉一列。
   */
  async applySessionControl(id: string, expectedRevision: bigint, patch: {
    readonly title?: string; readonly pinnedAt?: Date | null; readonly status?: AssistSessionStatus;
    readonly unreadAt?: Date | null;
  }): Promise<AssistSessionRow | undefined> {
    const sets = [sql`revision = revision + 1`, sql`updated_at = now()`];
    if (patch.title !== undefined) sets.push(sql`title = ${patch.title}`);
    if (patch.pinnedAt !== undefined) sets.push(sql`pinned_at = ${patch.pinnedAt}`);
    if (patch.status !== undefined) sets.push(sql`status = ${patch.status}`);
    if (patch.unreadAt !== undefined) sets.push(sql`unread_at = ${patch.unreadAt}`);
    const updated = await sql<AssistSessionRow>`update assist_sessions set ${sql.join(sets, sql`, `)}
      where id = ${id} and revision = ${expectedRevision} returning *`.execute(this.db);
    return updated.rows[0];
  }

  /** 导航只读投影：目标经项目关联，目录来自会话绑定；二者不是彼此的归属边界。 */
  async listSessionContexts(workspaceId: string, sessionIds: readonly string[]): Promise<readonly AssistSessionContext[]> {
    if (sessionIds.length === 0) return [];
    return (await sql<AssistSessionContext>`select s.id as session_id, s.revision as session_revision,
      coalesce((select jsonb_agg(jsonb_build_object('goal_id', g.id, 'title', g.title) order by g.id)
        from project_goals pg join goals g on g.id = pg.goal_id and g.workspace_id = pg.workspace_id
        where pg.workspace_id = s.workspace_id and pg.project_id = s.project_id), '[]'::jsonb) as project_goals,
      case when s.working_resource_id is null then null else
        jsonb_build_object('resource_id', s.working_resource_id, 'canonical_root', r.canonical_root)
      end as working_directory
      from assist_sessions s left join managed_resources r
        on r.id = s.working_resource_id and r.workspace_id = s.workspace_id
      where s.workspace_id = ${workspaceId} and s.id in (${sql.join(sessionIds)})`.execute(this.db)).rows;
  }

  /**
   * 在途消息未结束时改归属，会让回复落到与发送时不同的作用域，因此绑定必须先拒绝。
   * 状态取值与 AssistView 的消息状态一致：只有真正在途的两种状态挡住归属变更。
   */
  async hasInflightMessages(sessionId: string): Promise<boolean> {
    const rows = await sql<{ present: boolean }>`select exists(
      select 1 from assist_messages where session_id = ${sessionId}
      and status in ('PENDING', 'RUNNING')) as present`.execute(this.db);
    return rows.rows[0]?.present === true;
  }

  /** 绑定只改归属，不碰 task_id：会话仍可讨论，但执行准入另由目录决定。 */
  async bindSessionProject(id: string, projectId: string): Promise<void> {
    await sql`update assist_sessions set project_id = ${projectId}, revision = revision + 1,
      updated_at = now() where id = ${id}`.execute(this.db);
  }

  /**
   * 绑定本会话的当前工作目录（0087）。
   *
   * 只改目录，不改 project_id、不改 task_id，也不产生任何写准入：目录绑定是**作用域**，
   * 写能力仍要每次动作单独经 Gateway 核对连接与权限。换绑是允许的——用户换目录就是换作用域，
   * 下一轮立即按新目录解析，不保留旧目录的缓存。
   */
  async bindSessionDirectory(id: string, resourceId: string | null): Promise<void> {
    await sql`update assist_sessions set working_resource_id = ${resourceId},
      revision = revision + 1, updated_at = now() where id = ${id}`.execute(this.db);
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
    skillInput?: JsonObject | null; methodSnapshot?: JsonObject | null;
    methodAction?: 'INSPECT' | 'MODIFY' | null; methodArgument?: string | null;
    modelSelectionSnapshot?: JsonObject | null;
    modelAttemptState?: JsonObject | null;
    /** 0072：本轮不记录学习状态。随命令体持久，不由模型提示决定。 */
    learningRecordDisabled?: boolean | undefined }): Promise<void> {
    await sql`insert into assist_messages (id, session_id, seq, role, status, intent,
      content, sources, skill_snapshot, skill_input, method_snapshot, method_action,
      method_argument, learning_record_disabled, model_selection_snapshot, model_attempt_state)
      values (${input.id}, ${input.sessionId},
      ${input.seq}, ${input.role},
      ${input.status}, ${input.intent}, ${input.content},
      ${JSON.stringify(input.sources)}::jsonb,
      ${input.skillSnapshot === undefined || input.skillSnapshot === null ? null :
        JSON.stringify(input.skillSnapshot)}::jsonb,
      ${input.skillInput === undefined || input.skillInput === null ? null :
        JSON.stringify(input.skillInput)}::jsonb,
      ${input.methodSnapshot === undefined || input.methodSnapshot === null ? null :
        JSON.stringify(input.methodSnapshot)}::jsonb,
      ${input.methodAction ?? null},
      ${input.methodArgument ?? null},
      ${input.learningRecordDisabled ?? false},
      ${input.modelSelectionSnapshot === undefined || input.modelSelectionSnapshot === null ? null :
        JSON.stringify(input.modelSelectionSnapshot)}::jsonb,
      ${input.modelAttemptState === undefined || input.modelAttemptState === null ? null :
        JSON.stringify(input.modelAttemptState)}::jsonb)`.execute(this.db);
  }

  async readMessage(id: string, lock: boolean | 'share' = false): Promise<AssistMessageRow | undefined> {
    const suffix = lock === 'share' ? sql`for share` : lock ? sql`for update` : sql``;
    return (await sql<AssistMessageRow>`select * from assist_messages
      where id = ${id} ${suffix}`.execute(this.db)).rows[0];
  }

  /** 0099: claim one concrete Assist model call before the external request begins. */
  async reserveModelCall(input: { messageId: string; workerId: string;
    expectedRevision: string; expectedIndex: number; callId: string;
    turnId: string; nextState: JsonObject }): Promise<boolean> {
    return (await sql<{ id: string }>`update assist_messages set
      model_attempt_state = ${JSON.stringify(input.nextState)}::jsonb, updated_at = now()
      where id = ${input.messageId} and role = 'ASSISTANT' and status = 'RUNNING'
        and worker_id = ${input.workerId} and cancel_requested = false
        and model_attempt_state->>'revision' = ${input.expectedRevision}
        and model_attempt_state->>'current_candidate_index' = ${String(input.expectedIndex)}
        and model_attempt_state->>'status' = 'READY'
        and model_attempt_state->>'active_call_id' is null
      returning id`.execute(this.db)).rows.length === 1;
  }

  /** 0099: release a settled result only after its exact persisted call identity is known. */
  async finishModelCall(input: { messageId: string; workerId: string;
    expectedRevision: string; expectedIndex: number; callId: string;
    nextState: JsonObject }): Promise<boolean> {
    return (await sql<{ id: string }>`update assist_messages set
      model_attempt_state = ${JSON.stringify(input.nextState)}::jsonb, updated_at = now()
      where id = ${input.messageId} and role = 'ASSISTANT' and status = 'RUNNING'
        and worker_id = ${input.workerId} and cancel_requested = false
        and model_attempt_state->>'revision' = ${input.expectedRevision}
        and model_attempt_state->>'current_candidate_index' = ${String(input.expectedIndex)}
        and model_attempt_state->>'active_call_id' = ${input.callId}
      returning id`.execute(this.db)).rows.length === 1;
  }

  /** 0099: advance only from the active, already-settled call after precise fallback evidence. */
  async advanceModelCandidate(input: { messageId: string; workerId: string;
    expectedRevision: string; expectedIndex: number; activeCallId: string | null;
    nextState: JsonObject }): Promise<boolean> {
    return (await sql<{ id: string }>`update assist_messages set
      model_attempt_state = ${JSON.stringify(input.nextState)}::jsonb, updated_at = now()
      where id = ${input.messageId} and role = 'ASSISTANT' and status = 'RUNNING'
        and worker_id = ${input.workerId} and cancel_requested = false
        and model_attempt_state->>'revision' = ${input.expectedRevision}
        and model_attempt_state->>'current_candidate_index' = ${String(input.expectedIndex)}
        and model_attempt_state->>'active_call_id' is not distinct from ${input.activeCallId}
      returning id`.execute(this.db)).rows.length === 1;
  }

  /**
   * 0072 整改：按 (session_id, seq) 读一条消息。学习结算要按轮次身份取本 round 的
   * 用户消息作为依据绑定目标（assistant 消息的 seq-1 就是发起本轮的那条用户消息）。
   */
  async readMessageAtSeq(sessionId: string, seq: bigint): Promise<AssistMessageRow | undefined> {
    return (await sql<AssistMessageRow>`select * from assist_messages
      where session_id = ${sessionId} and seq = ${seq}`.execute(this.db)).rows[0];
  }

  // ---- 0093：消息图片附件（会话输入快照）。上传端点先落未引用行，消息命令在同一
  // 事务内绑定到新消息；媒体类型与内容插入后不可变，应用角色无 DELETE。 ----

  /** 上传暂存：类型白名单与字节上限由 0093 的 CHECK 兜底，这里只保证写入形状与调用方意图一致。 */
  async insertAttachment(input: { id: string; workspaceId: string; sessionId: string;
    name: string; mediaType: AssistMessageAttachmentRow['media_type']; content: Buffer;
    contentHash: Buffer }): Promise<void> {
    await sql`insert into assist_message_attachments (id, workspace_id, session_id,
      name, media_type, byte_length, content_hash, content)
      values (${input.id}, ${input.workspaceId}, ${input.sessionId}, ${input.name},
      ${input.mediaType}, ${input.content.byteLength}, ${input.contentHash}, ${input.content})`
      .execute(this.db);
  }

  /** 读取必须同时核对 workspace 与 session：跨会话/跨工作区引用一律查无（RESOURCE_NOT_FOUND）。 */
  async readAttachment(id: string, workspaceId: string,
    sessionId: string): Promise<AssistMessageAttachmentRow | undefined> {
    return (await sql<AssistMessageAttachmentRow>`select * from assist_message_attachments
      where id = ${id} and workspace_id = ${workspaceId} and session_id = ${sessionId}`
      .execute(this.db)).rows[0];
  }

  /**
   * 消息命令事务内绑定：`where message_id is null` 是唯一的绑定入口，兜底并发重复
   * 绑定；返回实际绑定数，不足即有 id 查无或已被占用，由调用方按 RESOURCE_NOT_FOUND
   * 拒绝整条命令。附件行不可变：没有任何路径改写媒体类型或内容。
   */
  async bindAttachments(sessionId: string, messageId: string,
    ids: readonly string[]): Promise<number> {
    if (ids.length === 0) return 0;
    return (await sql<{ id: string }>`update assist_message_attachments
      set message_id = ${messageId}
      where session_id = ${sessionId} and message_id is null
        and id in (${sql.join(ids)})`.execute(this.db)).rows.length;
  }

  /** 组装与投影读取：按消息取附件（含内容字节，多模态组装与回放都要用）。 */
  async listAttachmentsByMessage(
    messageId: string): Promise<readonly AssistMessageAttachmentRow[]> {
    return (await sql<AssistMessageAttachmentRow>`select * from assist_message_attachments
      where message_id = ${messageId} order by created_at, id`.execute(this.db)).rows;
  }

  /** 0093：历史轮次的附件占位读取；空入参直接返回，不产生 `in ()` 空列表查询。 */
  async listAttachmentsByMessages(
    messageIds: readonly string[]): Promise<readonly AssistMessageAttachmentRow[]> {
    if (messageIds.length === 0) return [];
    return (await sql<AssistMessageAttachmentRow>`select * from assist_message_attachments
      where message_id in (${sql.join(messageIds)}) order by created_at, id`
      .execute(this.db)).rows;
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
        order by m.session_id, m.created_at, m.id limit 1 for update of m skip locked)
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
    providerErrorKind?: AssistMessageRow['provider_error_kind'];
    usageInputTokens: number | null; usageOutputTokens: number | null;
    usageCacheReadTokens?: number | null; usageCacheCreationTokens?: number | null;
    finalSources?: readonly JsonObject[] | undefined;
    skillOutput?: JsonObject | undefined }): Promise<boolean> {
    const sources = input.finalSources === undefined ? sql`` :
      sql`, sources = ${JSON.stringify(input.finalSources)}::jsonb`;
    const skillOutput = input.skillOutput === undefined ? sql`` :
      sql`, skill_output = ${JSON.stringify(input.skillOutput)}::jsonb`;
    const updated = (await sql<{ id: string }>`update assist_messages set status = ${input.status},
      content = ${input.content}, error_code = ${input.errorCode},
      provider_error_kind = ${input.providerErrorKind ?? null},
      provider_request_id = ${input.providerRequestId},
      usage_input_tokens = ${input.usageInputTokens},
      usage_output_tokens = ${input.usageOutputTokens},
      usage_cache_read_tokens = ${input.usageCacheReadTokens ?? null},
      usage_cache_creation_tokens = ${input.usageCacheCreationTokens ?? null},
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
