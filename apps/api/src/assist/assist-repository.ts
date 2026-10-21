import { sql } from 'kysely';

import type { AssistMessageAttachmentMetaRow, AssistMessageAttachmentRow,
  AssistMessagePreviewRow, AssistMessageRow,
  AssistProposalRow, AssistSessionRow, AssistSessionStatus, ConversationMode } from '../infrastructure/database-schema.js';
import type { DbExecutor } from '../infrastructure/database.js';
import type { JsonObject } from '../infrastructure/json.js';

/**
 * 会话物理删除的阻断项（ADR-027）。任何一项存在，删除命令整条拒绝、零删除。
 * 「在途消息」不在这张表里：它由 `hasInflightMessages` 单独判定，与归档共用同一道栅栏。
 */
export type SessionDeleteBlockerReason =
  | 'MEMORY_SOURCES'
  | 'MEMORY_COMPACTION_ACTIVE'
  | 'FORK_CHILDREN'
  | 'TASK_ACCEPTANCE_CITED'
  | 'HYPOTHESIS_CITED'
  | 'WORK_SEGMENT_CITED'
  | 'BLUEPRINT_CITED'
  | 'EXECUTION_REQUESTS'
  | 'LEARNING_RECORDS'
  | 'ARTIFACT_IMPACT_COMMITTED'
  | 'PROVIDER_COOLDOWN_ACTIVE';

export interface AssistSessionContext {
  readonly session_id: string;
  readonly session_revision: bigint;
  readonly project_goals: readonly { readonly goal_id: string; readonly title: string }[];
  readonly working_directory: { readonly resource_id: string; readonly canonical_root: string | null;
    readonly source: AssistSessionRow['working_directory_source'] } | null;
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
    workingResourceId?: string;
    workingDirectorySource?: 'USER_PICKED' | 'WORKSPACE_DEFAULT';
    assistantProfileId?: string | null | undefined;
    assistantProfileRevision?: bigint | null | undefined;
    assistantRoleSnapshot?: JsonObject | null | undefined;
    /** 0127：新会话的行为模式，缺省 CHAT（既有调用方与旧客户端行为不变）。 */
    chatMode?: 'CHAT' | 'PLAN' | 'GOAL' | undefined;
    /** 0128：主子关联。子会话两列都必须给；根会话两列都不给。 */
    parentSessionId?: string | null | undefined;
    budgetScopeSessionId?: string | null | undefined }): Promise<void> {
    const mode = input.conversationMode ?? 'AGENT';
    const parentSessionId = input.parentSessionId ?? null;
    const budgetScopeSessionId = input.budgetScopeSessionId ?? null;
    if ((parentSessionId === null) !== (budgetScopeSessionId === null)) {
      throw new Error('assist session parent and budget scope must be set together');
    }
    await sql`insert into assist_sessions (id, workspace_id, project_id, task_id, title,
      conversation_mode, chat_mode, working_resource_id, working_directory_source,
      assistant_profile_id, assistant_profile_revision, assistant_role_snapshot,
      parent_session_id, budget_scope_session_id)
      values (${input.id}, ${input.workspaceId}, ${input.projectId}, ${input.taskId},
      ${input.title}, ${mode}, ${input.chatMode ?? 'CHAT'},
      ${input.workingResourceId ?? null}, ${input.workingDirectorySource ?? null},
      ${mode === 'ASSISTANT' ? input.assistantProfileId ?? null : null},
      ${mode === 'ASSISTANT' ? input.assistantProfileRevision ?? null : null},
      ${mode === 'ASSISTANT' && input.assistantRoleSnapshot !== undefined && input.assistantRoleSnapshot !== null
        ? JSON.stringify(input.assistantRoleSnapshot) : null}::jsonb,
      ${parentSessionId}, ${budgetScopeSessionId})`.execute(this.db);
  }

  async readSession(id: string, lock = false): Promise<AssistSessionRow | undefined> {
    const suffix = lock ? sql`for update` : sql``;
    return (await sql<AssistSessionRow>`select * from assist_sessions
      where id = ${id} ${suffix}`.execute(this.db)).rows[0];
  }

  /**
   * 会话列表：置顶优先，其余按最后消息时间倒序（0090 / 0111）。
   *
   * `status` 由调用方显式给出——HTTP 层默认只列 ACTIVE，`all`/`archived` 是左栏「已归档」
   * 那一段的读法。缺省不过滤，是为了让内部读取（按项目/任务定位会话）继续看得到全部身份。
   * 排序键用 `pinned_at desc nulls last`：置顶项之间按置顶时刻倒序，未置顶的落在后面，
   * 不再追加第二枚布尔排序键，避免「同现同缺」写成两套规则。
   * 活动序用 `coalesce(last_message_at, created_at)`：说过话的按最后一次消息落库或生成结算排，
   * 还没说话的按创建时间留在原位，不因本列为空而沉底；`id desc` 只作同值决胜。
   */
  async listSessions(workspaceId: string, projectId?: string, taskId?: string,
    status?: AssistSessionStatus | 'ALL'): Promise<readonly AssistSessionRow[]> {
    const project = projectId === undefined ? sql`` : sql`and project_id = ${projectId}`;
    const task = taskId === undefined ? sql`` : sql`and task_id = ${taskId}`;
    const active = status === undefined || status === 'ALL' ? sql``
      : sql`and status = ${status}`;
    return (await sql<AssistSessionRow>`select * from assist_sessions
      where workspace_id = ${workspaceId} ${project} ${task} ${active}
      order by pinned_at desc nulls last,
        coalesce(last_message_at, created_at) desc, id desc`.execute(this.db)).rows;
  }

  /**
   * 会话活动排序键（0111）：只前进不回退，不碰 `updated_at` 与 `revision`。
   *
   * 调用方只有消息落库与生成结算两处。改名、置顶、未读、绑定都不推进它，它也不推进
   * 人工控制命令赖以裁决的修订号——否则在途生成会把界面上的改名与置顶打成 409。
   */
  async touchLastMessage(sessionId: string): Promise<void> {
    await sql`update assist_sessions
      set last_message_at = greatest(last_message_at, now())
      where id = ${sessionId}`.execute(this.db);
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

  /**
   * 分叉一条会话（0113）。
   *
   * 用 `insert … select` 从源行整行搬运，而不是在 JS 里逐列取值再拼 INSERT：会话身份那一组
   * 列（模式、人设 ID/修订/快照、是否续读、归属项目与任务、绑定目录）以后再加一列时，
   * 逐列拼装会静默漏掉新列，按源行复制不会。
   *
   * 三枚导航列显式写 NULL：置顶、未读与「最近活动」都是这一行自己的事实，不从父行继承——
   * 刚分出来的讨论要按新会话落在活动序顶部，而不是挤在父会话旁边。子会话修订从 0 起，
   * 父会话一行都不改（分叉不推进它的修订与标题，见 0113）。
   */
  async insertForkedSession(input: { id: string; fromSessionId: string; title: string }):
  Promise<AssistSessionRow | undefined> {
    const inserted = await sql<AssistSessionRow>`insert into assist_sessions (
        id, workspace_id, project_id, task_id, title, conversation_mode,
        assistant_profile_id, assistant_profile_revision, assistant_role_snapshot,
        remember, working_resource_id, working_directory_source, status, pinned_at, unread_at, last_message_at,
        forked_from_session_id)
      select ${input.id}, s.workspace_id, s.project_id, s.task_id, ${input.title},
        s.conversation_mode, s.assistant_profile_id, s.assistant_profile_revision,
        s.assistant_role_snapshot, s.remember, s.working_resource_id, s.working_directory_source, s.status,
        null, null, null, s.id
      from assist_sessions s where s.id = ${input.fromSessionId}
      returning *`.execute(this.db);
    return inserted.rows[0];
  }

  /**
   * 0113：分叉要搬的历史消息。
   *
   * 只有「已完成且有正文」的一轮才算历史：RUNNING/PENDING 由用例的在途栅栏先拒掉，
   * FAILED/CANCELLED 是那一轮自己的结局（错误码与服务商请求号都不随文本搬运），
   * 把它们复制进子会话会变成「子会话里有一轮失败过，但它没有任何失败痕迹」。
   */
  async listForkableMessageIds(sessionId: string): Promise<readonly { id: string; seq: bigint }[]> {
    return (await sql<{ id: string; seq: bigint }>`select id, seq from assist_messages
      where session_id = ${sessionId} and status = 'COMPLETED' and content is not null
      order by seq`.execute(this.db)).rows;
  }

  /**
   * 0113：按源行复制一轮消息，正文与各类输入快照都在库里搬运，不经过应用进程。
   *
   * `seq` 由调用方按子会话从 1 重排（`UNIQUE (session_id, seq)`）。刻意**不**搬的列：
   * `provider_request_id`、四枚 usage、`worker_id`、`cancel_requested`、`error_code`、
   * `provider_error_kind`、`model_attempt_state`——它们记的是父会话那一轮的真实外呼与
   * 领取过程，子会话没有发生过那次外呼，留着就是伪造已确认事实。
   * `model_selection_snapshot` 同样不搬：0098 把这两列约束成成对非空
   * （`(snapshot IS NULL) = (attempt_state IS NULL)`），单搬快照会让分叉撞 CHECK；
   * 而复制过去的历史一律 COMPLETED、不会再被生成路径读取，快照只服务排队与重试，
   * 子会话里没有它不影响任何读方。
   * 提案（assist_proposals）也不搬：接受一次会写业务事实，同一条提案不能在两条会话里各接受一次。
   */
  async copyMessageInto(input: { sourceMessageId: string; parentSessionId: string;
    childSessionId: string; childMessageId: string; seq: bigint }): Promise<boolean> {
    const inserted = await sql<{ id: string }>`insert into assist_messages (
        id, session_id, seq, role, status, intent, content, sources,
        skill_snapshot, skill_input, skill_output, method_snapshot, method_action,
        method_argument, learning_record_disabled,
        created_at, updated_at)
      select ${input.childMessageId}, ${input.childSessionId}, ${input.seq}, m.role, m.status,
        m.intent, case when m.role = 'ASSISTANT' and not exists
          (select 1 from assist_memory_uses u where u.message_id = m.id) and exists
          (select 1 from session_tool_calls t where t.message_id = m.id)
          then '（历史工具答复的来源无法核对，正文未复制。）' else m.content end,
        m.sources, m.skill_snapshot, m.skill_input, m.skill_output,
        m.method_snapshot, m.method_action, m.method_argument, m.learning_record_disabled,
        m.created_at, now()
      from assist_messages m
      where m.id = ${input.sourceMessageId} and m.session_id = ${input.parentSessionId}
      returning id`.execute(this.db);
    if (inserted.rows.length === 1) {
      // Copy only revocation provenance, never the parent's call, checkpoint ownership or usage.
      await sql`insert into assist_memory_uses (message_id, session_id, authority_revision,
        context_revision, memory_revision, checkpoint_id, sources, has_tool_context, session_scope)
        select ${input.childMessageId}, ${input.childSessionId}, u.authority_revision,
          u.context_revision, 0, null, u.sources || coalesce(c.sources, '[]'::jsonb),
          u.has_tool_context or u.checkpoint_id is not null or exists
            (select 1 from session_tool_calls t where t.message_id = ${input.sourceMessageId}), u.session_scope
        from assist_memory_uses u left join assist_memory_checkpoints c on c.id = u.checkpoint_id
        where u.message_id = ${input.sourceMessageId}`.execute(this.db);
    }
    return inserted.rows.length === 1;
  }

  /** 0113：某条消息的图片附件身份（按落库顺序），字节不读出来——复制在库里完成。 */
  async listAttachmentIdsByMessage(messageId: string): Promise<readonly string[]> {
    return (await sql<{ id: string }>`select id from assist_message_attachments
      where message_id = ${messageId} order by created_at, id`.execute(this.db)).rows
      .map((row) => row.id);
  }

  /**
   * 0113：把一张附件复制进子会话（0093 的字节不可变，这里只搬运不改写）。
   *
   * 逐张一条语句而不是整表 `insert … select`：新行 ID 仍由应用生成（全仓一致），
   * 而 bytea 内容始终留在数据库内部，不经过程序——一条消息最多 4 张、单张最多 2 MiB，
   * 把整段历史读进内存再写回会把一次分叉变成几十兆搬运。
   */
  async copyAttachmentInto(input: { sourceAttachmentId: string; parentSessionId: string;
    childSessionId: string; childMessageId: string; childAttachmentId: string }): Promise<boolean> {
    const inserted = await sql<{ id: string }>`insert into assist_message_attachments (
        id, workspace_id, session_id, message_id, name, media_type, byte_length,
        content_hash, content, created_at)
      select ${input.childAttachmentId}, a.workspace_id, ${input.childSessionId},
        ${input.childMessageId}, a.name, a.media_type, a.byte_length, a.content_hash,
        a.content, a.created_at
      from assist_message_attachments a
      where a.id = ${input.sourceAttachmentId} and a.session_id = ${input.parentSessionId}
      returning id`.execute(this.db);
    return inserted.rows.length === 1;
  }

  /** 导航只读投影：目标经项目关联，目录来自会话绑定；二者不是彼此的归属边界。 */
  async listSessionContexts(workspaceId: string, sessionIds: readonly string[]): Promise<readonly AssistSessionContext[]> {
    if (sessionIds.length === 0) return [];
    return (await sql<AssistSessionContext>`select s.id as session_id, s.revision as session_revision,
      coalesce((select jsonb_agg(jsonb_build_object('goal_id', g.id, 'title', g.title) order by g.id)
        from project_goals pg join goals g on g.id = pg.goal_id and g.workspace_id = pg.workspace_id
        where pg.workspace_id = s.workspace_id and pg.project_id = s.project_id), '[]'::jsonb) as project_goals,
      case when s.working_resource_id is null then null else
        jsonb_build_object('resource_id', s.working_resource_id, 'canonical_root', r.canonical_root,
          'source', s.working_directory_source)
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

  /** 0122：会话里是否有正在生成的那一轮——插话只能并入它，没有它就只是普通排队。 */
  async hasRunningMessage(sessionId: string): Promise<boolean> {
    const rows = await sql<{ present: boolean }>`select exists(
      select 1 from assist_messages where session_id = ${sessionId}
      and role = 'ASSISTANT' and status = 'RUNNING') as present`.execute(this.db);
    return rows.rows[0]?.present === true;
  }

  /** 0122：某条消息紧邻的前一条用户消息（插话带进来的原文就是它）。 */
  async readPrecedingUserMessage(sessionId: string, seq: bigint):
  Promise<AssistMessageRow | undefined> {
    return (await sql<AssistMessageRow>`select * from assist_messages
      where session_id = ${sessionId} and seq < ${seq} and role = 'USER'
      order by seq desc limit 1`.execute(this.db)).rows[0];
  }

  /**
   * 物理删除的阻断面（ADR-027）：这条会话的账本里有没有被别的对象引用的来源消息。
   *
   * 只读，先于任何 DELETE 执行；命中任意一项，删除命令整条拒绝。理由不是保守，而是
   * 这些行各自有保留 Owner：Task 验收观察属于任务、假设与工作片段属于项目、组合检查
   * 绑定 Task、学习记录有自己的删除入口、执行请求是「任务从哪条消息来」的来源、
   * 未到期的供应商冷却属于平台调用安全。删会话不能让它们一并消失。
   *
   * 分叉子会话单独算一类：外键是 NO ACTION，父行删掉后子会话的 `forked_from_session_id`
   * 会永久悬空；不把来源说明改成 NULL，因为那等于替子会话改历史。
   */
  async listDeleteBlockers(sessionId: string): Promise<readonly SessionDeleteBlockerReason[]> {
    const result = await sql<{ reason: SessionDeleteBlockerReason }>`
      select reason from (
      select 1 as ordinal, 'FORK_CHILDREN' as reason where exists (
        select 1 from assist_sessions where forked_from_session_id = ${sessionId})
      union all
      select 2, 'TASK_ACCEPTANCE_CITED' where exists (
        select 1 from task_acceptance_trial_observations o
        join assist_messages m on m.id = o.source_message_id
        where m.session_id = ${sessionId})
      union all
      select 3, 'HYPOTHESIS_CITED' where exists (
        select 1 from hypothesis_versions h
        join assist_messages m on m.id = h.source_message_id
        where m.session_id = ${sessionId})
      union all
      select 4, 'WORK_SEGMENT_CITED' where exists (
        select 1 from work_segments w
        join assist_messages m on m.id = w.source_message_id
        where m.session_id = ${sessionId})
      union all
      select 5, 'BLUEPRINT_CITED' where exists (
        select 1 from project_blueprint_proposals b
        join assist_messages m on m.id = b.skill_message_id
        where m.session_id = ${sessionId})
      union all
      select 6, 'EXECUTION_REQUESTS' where exists (
        select 1 from conversation_execution_requests where session_id = ${sessionId})
      union all
      select 7, 'LEARNING_RECORDS' where exists (
        select 1 from learning_evidence where session_id = ${sessionId})
      union all
      select 8, 'ARTIFACT_IMPACT_COMMITTED' where exists (
        select 1 from artifact_combination_checks c
        join artifact_impact_candidate_groups g on g.id = c.group_id
        join artifact_impact_checks k on k.id = g.impact_check_id
        where k.assist_session_id = ${sessionId})
      union all
      select 9, 'PROVIDER_COOLDOWN_ACTIVE' where exists (
        select 1 from model_provider_cooldowns c
        join model_calls mc on mc.id = c.model_call_id
        join assist_messages m on m.id = mc.assist_message_id
        where m.session_id = ${sessionId} and c.retry_after_at > now())
      union all
      select 10, 'LEARNING_RECORDS' where exists (
        select 1 from learning_rounds where session_id = ${sessionId})
      union all
      select 11, 'LEARNING_RECORDS' where exists (
        select 1 from learning_session_controls where session_id = ${sessionId})
      union all
      select 12, 'MEMORY_SOURCES' where exists (
        select 1 from memory_message_sources where session_id = ${sessionId})
      union all
      select 13, 'MEMORY_COMPACTION_ACTIVE' where exists (
        select 1 from assist_memory_requests where session_id = ${sessionId} and status in ('PENDING', 'RUNNING'))
      ) blockers order by ordinal`.execute(this.db);
    return [...new Set(result.rows.map((row) => row.reason))];
  }

  /**
   * 物理删除一条会话的自有账本（ADR-027）。调用方已持行锁、核对过修订、确认无阻断项，
   * 且在同一短事务里跑完——这里不再重复判定，只按「子 → 父」顺序删。
   *
   * 顺序是显式的而不是 `ON DELETE CASCADE`：删错一层会当场撞外键失败并整条回滚，
   * 不会让数据库按自己的级联规则决定哪些行该消失。`conversation_diff_baselines.session_id`
   * 是普通列（0097 没有外键），必须单独删，否则留下悬空账本。
   *
   * 删的是**会话自有**的账本：消息、提案、附件、预览、工具调用、模型选择、状态维护请求、
   * 未进入组合检查的影响检查、辅助模型调用计量、已到期冷却与 diff 基线。学习记录、
   * 执行请求与跨对象来源在阻断层就已拒绝，不会走到这里。
   */
  async deleteSession(sessionId: string, expectedRevision: bigint):
  Promise<{ readonly messages: number; readonly attachments: number } | undefined> {
    await sql`delete from assist_memory_uses where session_id = ${sessionId}`.execute(this.db);
    await sql`delete from assist_memory_state where session_id = ${sessionId}`.execute(this.db);
    await sql`delete from assist_memory_requests where session_id = ${sessionId}`.execute(this.db);
    await sql`delete from assist_memory_checkpoints where session_id = ${sessionId}`.execute(this.db);
    const attachments = await sql<{ id: string }>`delete from assist_message_attachments
      where session_id = ${sessionId} returning id`.execute(this.db);
    await sql`delete from assist_message_previews where message_id in (
      select id from assist_messages where session_id = ${sessionId})`.execute(this.db);
    await sql`delete from session_tool_calls where session_id = ${sessionId}`.execute(this.db);
    await sql`delete from assist_proposals where session_id = ${sessionId}`.execute(this.db);
    await sql`delete from artifact_impact_candidate_group_items where group_id in (
      select g.id from artifact_impact_candidate_groups g
      join artifact_impact_checks k on k.id = g.impact_check_id
      where k.assist_session_id = ${sessionId})`.execute(this.db);
    await sql`delete from artifact_impact_candidate_groups where impact_check_id in (
      select id from artifact_impact_checks where assist_session_id = ${sessionId})`.execute(this.db);
    await sql`delete from artifact_impact_candidates where assist_session_id = ${sessionId}`.execute(this.db);
    await sql`delete from artifact_impact_checks where assist_session_id = ${sessionId}`.execute(this.db);
    await sql`delete from conversation_state_changes where request_id in (
      select id from conversation_state_requests where session_id = ${sessionId})`.execute(this.db);
    await sql`delete from conversation_state_requests where session_id = ${sessionId}`.execute(this.db);
    await sql`delete from model_provider_cooldowns where model_call_id in (
      select mc.id from model_calls mc join assist_messages m on m.id = mc.assist_message_id
      where m.session_id = ${sessionId})`.execute(this.db);
    await sql`delete from model_calls where assist_message_id in (
      select id from assist_messages where session_id = ${sessionId})`.execute(this.db);
    await sql`delete from conversation_diff_baselines where session_id = ${sessionId}`.execute(this.db);
    await sql`delete from session_model_selection where session_id = ${sessionId}`.execute(this.db);
    const messages = await sql<{ id: string }>`delete from assist_messages
      where session_id = ${sessionId} returning id`.execute(this.db);
    const session = await sql<{ id: string }>`delete from assist_sessions
      where id = ${sessionId} and revision = ${expectedRevision} returning id`.execute(this.db);
    if (session.rows.length === 0) return undefined;
    return { messages: messages.rows.length, attachments: attachments.rows.length };
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
      working_directory_source = ${resourceId === null ? null : 'USER_PICKED'},
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
    learningRecordDisabled?: boolean | undefined;
    /**
     * 0127：这条消息受理时的行为模式快照；缺省 CHAT，既有调用方行为不变。
     * 目标是执行模式，不是身份——它不改变会话的 `conversation_mode`。
     */
    chatMode?: 'CHAT' | 'PLAN' | 'GOAL' | undefined;
    /** 0127：目标轮次消息所属的目标；只由服务端推进器写入。 */
    goalId?: string | null | undefined }): Promise<void> {
    await sql`insert into assist_messages (id, session_id, seq, role, status, intent,
      content, sources, skill_snapshot, skill_input, method_snapshot, method_action,
      method_argument, learning_record_disabled, model_selection_snapshot, model_attempt_state,
      chat_mode, goal_id)
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
        JSON.stringify(input.modelAttemptState)}::jsonb,
      ${input.chatMode ?? 'CHAT'}, ${input.goalId ?? null})`.execute(this.db);
    // 0111：消息落库即活动，用户消息与预插的 ASSISTANT 行都推进同一个排序键。
    await this.touchLastMessage(input.sessionId);
  }

  /**
   * 0127：写入目标轮次的结构化结论。
   *
   * 只写这一列、不动正文与状态：正文由结算按 Worker CAS 写，结论是同一轮的另一份事实。
   * 两处分开写但同属一次结算事务，因此读到的永远是「这一轮的正文 + 这一轮的结论」。
   */
  async setGoalOutcome(messageId: string, outcome: JsonObject): Promise<void> {
    await sql`update assist_messages set goal_outcome = ${JSON.stringify(outcome)}::jsonb,
      updated_at = now() where id = ${messageId}`.execute(this.db);
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
   *
   * `returning id` 不是装饰：没有它时驱动只回「命令完成」，`rows` 恒为空，
   * 绑定数永远是 0——2026-10-18 的真实 PG 用例就是这样暴露的（`affected` 被读成 0，
   * 每条带图消息都按「附件在作用域内不可见」拒绝）。
   */
  async bindAttachments(sessionId: string, messageId: string,
    ids: readonly string[]): Promise<number> {
    if (ids.length === 0) return 0;
    return (await sql<{ id: string }>`update assist_message_attachments
      set message_id = ${messageId}
      where session_id = ${sessionId} and message_id is null
        and id in (${sql.join(ids)})
      returning id`.execute(this.db)).rows.length;
  }

  /** 组装与投影读取：按消息取附件（含内容字节，多模态组装与回放都要用）。 */
  async listAttachmentsByMessage(
    messageId: string): Promise<readonly AssistMessageAttachmentRow[]> {
    return (await sql<AssistMessageAttachmentRow>`select * from assist_message_attachments
      where message_id = ${messageId} order by created_at, id`.execute(this.db)).rows;
  }

  /** 0122：这条消息是否带图片附件。插话通道只送原文，因此带图的消息不能插话；
   *  只查存在性，不读 bytea。 */
  async messageHasAttachments(messageId: string): Promise<boolean> {
    const rows = await sql<{ present: boolean }>`select exists(
      select 1 from assist_message_attachments where message_id = ${messageId}) as present`
      .execute(this.db);
    return rows.rows[0]?.present === true;
  }

  /** 0093：历史轮次的附件占位读取；空入参直接返回，不产生 `in ()` 空列表查询。 */
  async listAttachmentsByMessages(
    messageIds: readonly string[]): Promise<readonly AssistMessageAttachmentRow[]> {
    if (messageIds.length === 0) return [];
    return (await sql<AssistMessageAttachmentRow>`select * from assist_message_attachments
      where message_id in (${sql.join(messageIds)}) order by created_at, id`
      .execute(this.db)).rows;
  }

  /**
   * 0093：消息列表投影用的**元数据**读取——刻意不选 `content`。
   * 列表是每轮都要读的只读投影，把 bytea 带进去会让一次列表读取变成几 MB；
   * 内容只在 `readAssistMessageAttachment` 里按单张读取。
   */
  async listAttachmentMetaByMessages(sessionId: string, messageIds: readonly string[]):
  Promise<readonly AssistMessageAttachmentMetaRow[]> {
    if (messageIds.length === 0) return [];
    return (await sql<AssistMessageAttachmentMetaRow>`select id, message_id, name,
      media_type, byte_length from assist_message_attachments
      where session_id = ${sessionId} and message_id in (${sql.join(messageIds)})
      order by created_at, id`.execute(this.db)).rows;
  }

  async readLivePreview(messageId: string): Promise<AssistMessagePreviewRow | undefined> {
    return (await sql<AssistMessagePreviewRow>`select * from assist_message_previews
      where message_id = ${messageId}`.execute(this.db)).rows[0];
  }

  /** SSE 节流信号（preview-events-api）：只取 revision 与截断标志；授权与内容都在 readAssistLivePreview。 */
  async readLivePreviewFinger(messageId: string): Promise<{
    revision: bigint; truncated: boolean;
  } | undefined> {
    return (await sql<{ revision: bigint; truncated: boolean }>`select revision, truncated
      from assist_message_previews where message_id = ${messageId}`
      .execute(this.db)).rows[0];
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
    // 0122：插话被消费的那一行是「没有回复」的占位行（CANCELLED + STEERED），
    // 它的用户原文与答案都在原在途回复里；列出来只会多一条读起来像「已取消」的回复。
    return (await sql<AssistMessageRow>`select * from assist_messages
      where session_id = ${sessionId}
        and not (role = 'ASSISTANT' and status = 'CANCELLED' and error_code = 'STEERED')
      order by seq ${bounded}`.execute(this.db)).rows;
  }

  async listCompletedHistory(sessionId: string, throughSeq: bigint,
    limit = 20): Promise<readonly AssistMessageRow[]> {
    const rows = (await sql<AssistMessageRow>`select * from assist_messages
      where session_id = ${sessionId} and seq <= ${throughSeq} and status = 'COMPLETED'
      order by seq desc limit ${limit}`.execute(this.db)).rows;
    return rows.reverse();
  }

  async recordGenerationSources(messageId: string, workerId: string,
    sources: readonly JsonObject[]): Promise<boolean> {
    return (await sql<{ id: string }>`update assist_messages
      set sources = ${JSON.stringify(sources)}::jsonb
      where id = ${messageId} and status = 'RUNNING' and worker_id = ${workerId}
        and cancel_requested = false returning id`.execute(this.db)).rows.length === 1;
  }

  /** 监督器只为可领取消息或待清扫的失联领取启动子 Worker。 */
  async hasRunnableGeneration(olderThan: Date): Promise<boolean> {
    const result = await sql<{ id: string }>`select m.id from assist_messages m
      join assist_sessions s on s.id = m.session_id
      left join projects p on p.id = s.project_id
      where (m.status = 'PENDING' and (s.project_id is null or p.archived_at is null))
        or (m.status = 'RUNNING' and m.updated_at < ${olderThan})
      union all
      select j.anchor_message_id as id from assist_memory_requests j
      where j.status = 'PENDING'
        or (j.status = 'RUNNING' and j.lease_until < now())
      limit 1`.execute(this.db);
    return result.rows.length > 0;
  }

  /** 原子领取：for update skip locked 保证多 Worker/多 tick 恰好一个领取者。
   *  0122：同一句里清掉插话意图——这一行开始自己生成后，就不再是别人的插话对象。 */
  async claimNextPendingMessage(workerId: string): Promise<AssistMessageRow | undefined> {
    return (await sql<AssistMessageRow>`update assist_messages set status = 'RUNNING',
      worker_id = ${workerId}, steer_requested = false, updated_at = now()
      where id = (select m.id from assist_messages m
        join assist_sessions s on s.id = m.session_id
        left join projects p on p.id = s.project_id
        where m.status = 'PENDING' and (s.project_id is null or p.archived_at is null)
            and not exists (select 1 from assist_memory_requests j where j.session_id = s.id
              and j.status in ('PENDING', 'RUNNING'))
          order by m.session_id, m.created_at, m.id limit 1 for update of m, s skip locked)
      returning *`.execute(this.db)).rows[0];
  }

  async requeueForMemory(messageId: string, workerId: string): Promise<boolean> {
    return (await sql<{ id: string }>`update assist_messages set status = 'PENDING', worker_id = null,
      updated_at = now() where id = ${messageId} and status = 'RUNNING'
        and worker_id = ${workerId} and cancel_requested = false returning id`.execute(this.db)).rows.length === 1;
  }

  /**
   * 0128：按 id 领取一条已存在的 PENDING 消息（子 Agent 执行用）。
   *
   * 与 `claimNextPendingMessage` 同一纪律（RUNNING + worker_id 一次性落定），但目标行由
   * 调用方给出：子会话消息在委派创建时就已插入，执行时按原身份领取，不重新选行。
   * 已有人领取或状态已变时返回 false，调用方不得重试执行。
   */
  async claimPendingMessage(messageId: string, workerId: string): Promise<boolean> {
    return (await sql<{ id: string }>`update assist_messages set status = 'RUNNING',
      worker_id = ${workerId}, steer_requested = false, updated_at = now()
      where id = ${messageId} and status = 'PENDING' and role = 'ASSISTANT'
      returning id`.execute(this.db)).rows.length === 1;
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

  /**
   * 0122：请求把一条排队消息并入正在生成的那一轮。
   *
   * 只接受 `PENDING`：`RUNNING` 的那条正在被消费，`COMPLETED`/`FAILED`/`CANCELLED`
   * 已经结束——三者都不该再改投递方式。幂等：已置位的行再请求一次仍返回 `REQUESTED`。
   */
  async setSteerRequested(id: string): Promise<'REQUESTED' | 'UNSETTLED'> {
    const updated = (await sql<{ id: string }>`update assist_messages
      set steer_requested = true, updated_at = now()
      where id = ${id} and role = 'ASSISTANT' and status = 'PENDING'
      returning id`.execute(this.db)).rows.length === 1;
    if (updated) return 'REQUESTED';
    return (await this.readMessage(id))?.steer_requested === true ? 'REQUESTED' : 'UNSETTLED';
  }

  /**
   * 0122：消费插话请求（生成方在下一次模型请求前调用）。
   *
   * 一条语句完成三件事，避免「先读后写」留下重复消费的窗口：
   *   * 选中本条消息之后、仍 `PENDING`、已置 `steer_requested` 的行；
   *   * 把它们收口为 `CANCELLED` + `error_code = 'STEERED'`——这一行不再自己生成回复；
   *   * 带回各自紧邻的用户原文（同一会话里 seq 小于该行、最近的一条 USER）。
   *
   * 返回按 `seq` 升序，与用户发送顺序一致。同一行不会被第二次消费：状态已离开 PENDING。
   */
  async drainSteerRequests(sessionId: string, afterSeq: bigint):
  Promise<readonly { messageId: string; content: string }[]> {
    const rows = (await sql<{ id: string; content: string | null }>`
      with steered as (
        update assist_messages set status = 'CANCELLED', error_code = 'STEERED',
          worker_id = null, updated_at = now()
        where session_id = ${sessionId} and seq > ${afterSeq}
          and role = 'ASSISTANT' and status = 'PENDING' and steer_requested = true
          and cancel_requested = false
        returning id, seq
      )
      select steered.id, source.content
      from steered
      join lateral (
        select m.content from assist_messages m
        where m.session_id = ${sessionId} and m.seq < steered.seq and m.role = 'USER'
        order by m.seq desc limit 1
      ) source on true
      order by steered.seq`.execute(this.db)).rows;
    return rows.map((row) => ({ messageId: row.id, content: row.content ?? '' }));
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
    const settled = (await sql<{ session_id: string }>`update assist_messages set status = ${input.status},
      content = ${input.content}, error_code = ${input.errorCode},
      provider_error_kind = ${input.providerErrorKind ?? null},
      provider_request_id = ${input.providerRequestId},
      usage_input_tokens = ${input.usageInputTokens},
      usage_output_tokens = ${input.usageOutputTokens},
      usage_cache_read_tokens = ${input.usageCacheReadTokens ?? null},
      usage_cache_creation_tokens = ${input.usageCacheCreationTokens ?? null},
      worker_id = ${input.workerId}, updated_at = now()${sources}${skillOutput}
      where id = ${input.messageId} and status = 'RUNNING' and worker_id = ${input.workerId}
      returning session_id`.execute(this.db)).rows[0];
    if (settled !== undefined) {
      await sql`delete from assist_message_previews where message_id = ${input.messageId}`
        .execute(this.db);
      // 0111：AI 说完（含失败与取消）算一次活动；迟到的旧 Worker 结算失败不推进排序键。
      await this.touchLastMessage(settled.session_id);
    }
    return settled !== undefined;
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
