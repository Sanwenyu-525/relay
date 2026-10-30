import { sql } from 'kysely';

import type { AssistMessageAttachmentMetaRow, AssistMessageAttachmentRow,
  AssistMessagePreviewRow, AssistMessageRow, AssistMessageStatus, ModelCallRow,
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
  | 'SUBAGENT_CHILDREN'
  | 'DELEGATION_LEDGER_REFERENCED'
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
 * 会话的**运行态**：这段讨论此刻有没有在途的一轮。
 *
 * 只有两个值，取自 `assist_messages.status`：`RUNNING` 表示已有 Worker 认领、正在生成；
 * `PENDING` 表示回复行已落库但还没人认领（排队）。终态（COMPLETED/FAILED/CANCELLED）
 * 与「一条在途消息都没有」都归 `null`，不另立一个 `IDLE` 词——那会让客户端以为
 * 服务端在陈述一种状态，而它其实只是「没有在途」。
 */
export type AssistSessionRunState = 'RUNNING' | 'PENDING';

/**
 * 左栏一枚状态图标的取值（2026-10-30）：**读时派生**的展示事实，不是 `assist_sessions`
 * 的列，也不新增写入 Owner。派生只读三类既有事实——
 *
 * 1. `assist_messages.status`：在途（`RUNNING`/`PENDING`）与最后一轮终态
 *    （`COMPLETED`/`FAILED`/`CANCELLED`）。`null` 不等于「完成」：它是「没有在途」，
 *    终态要另外读最后一轮回复行，这条区分就是本类型存在的理由。
 * 2. `assist_proposals.status = 'PENDING'`：一条提案正等人确认。这是仓库里唯一
 *    会话级的「等待人工决定」权威事实，审批态只接它，不从消息正文、时间或工具调用猜。
 * 3. `assist_sessions.status` 与「有没有消息」：归档与未开始是会话自身的生命周期事实。
 *
 * 优先级（前面的压过后面的）：在途 → 等待确认 → 归档 → 未开始 → 最后一轮终态。
 * 在途压过一切，因为它是此刻正在发生的事；终态排在未开始之后，因为「没有消息」
 * 比「上一轮的结局」更能描述这条会话现在是什么。全部读不出（有条目但没有任何助手行）
 * 时为 `null`，界面回退类型图标——不编一个状态。
 */
export type AssistSessionListState =
  | 'RUNNING'
  | 'PENDING'
  | 'WAITING_APPROVAL'
  | 'COMPLETED'
  | 'FAILED'
  | 'CANCELLED'
  | 'NOT_STARTED'
  | 'ARCHIVED';

/** 派生 `AssistSessionListState` 所需的原始事实；列表与单条读取共用一份形状。 */
interface AssistSessionStateFacts {
  readonly status: AssistSessionStatus;
  readonly has_messages: boolean;
  readonly run_state: AssistSessionRunState | null;
  readonly last_assistant_status: AssistMessageStatus | null;
  readonly waiting_approval: boolean;
}

/**
 * 唯一的派生点：列表与单条读取都调用它，不允许第二份判定散落在 SQL 或界面里。
 *
 * `last_assistant_status` 落到 PENDING/RUNNING 时说明有在途行、`run_state` 已先行返回；
 * 真出现「在途但 run_state 为空」只可能是两条读法错位，那时返回 `null`（未知），
 * 不挑一个终态顶上。
 */
function deriveListState(facts: AssistSessionStateFacts): AssistSessionListState | null {
  if (facts.run_state !== null) return facts.run_state;
  if (facts.waiting_approval) return 'WAITING_APPROVAL';
  if (facts.status === 'ARCHIVED') return 'ARCHIVED';
  if (!facts.has_messages) return 'NOT_STARTED';
  return facts.last_assistant_status === 'COMPLETED' || facts.last_assistant_status === 'FAILED' ||
    facts.last_assistant_status === 'CANCELLED' ? facts.last_assistant_status : null;
}

/**
 * 0145：新会话在没有可继承来源时的档位，也是 `assist_sessions.context_budget_tokens`
 * 的插入缺省值。三档里最小的一档——先把上下文从最省的一档起步，用户再按需要往上调。
 */
export const DEFAULT_SESSION_CONTEXT_BUDGET = 262_144;

/** 0145：会话最近一次模型调用的用量行（含分项快照的原始 JSON）。 */
export interface AssistContextUsageCallRow {
  readonly id: string;
  readonly provider: string;
  readonly model: string;
  readonly status: ModelCallRow['status'];
  readonly usage_input_tokens: number | null;
  readonly usage_output_tokens: number | null;
  readonly usage_cache_read_tokens: number | null;
  readonly usage_cache_creation_tokens: number | null;
  /** 该次调用冻结的单次预算；解释历史占比时以它为准，而不是当前档位。 */
  readonly budget_reserved_tokens: number | null;
  readonly context_usage: JsonObject | null;
  readonly settled_at: Date | null;
  readonly started_at: Date;
  readonly assist_message_id: string | null;
}

/**
 * 会话列表投影：`has_messages` 与 `run_state` 都是**读时派生**的事实，不是 `assist_sessions` 的列。
 *
 * `has_messages` 回答「这段讨论有没有消息」，与 `last_message_at` 分开：后者是导航排序键，
 * 由消息落库与生成结算推进；前者直接数 `assist_messages` 行，任何写入路径漏推进
 * 活动键都不会让空会话判断说谎（2026-10-24 用户确认的口径）。
 *
 * `run_state`（2026-10-28）同理只数消息表：左栏要在没点开某条会话时看出它正在生成回复，
 * 唯一可信来源就是这一轮回复行自己的状态。不从界面的发送按钮、`has_messages`、
 * 缓存的最后消息时刻或 `updated_at` 推断——那些在任何一条写入路径漏推进时都会说谎。
 *
 * `list_state`（2026-10-30）是在同一读法上补齐的展示态：在途之外还要看最后一轮终态、
 * 待确认提案、归档与未开始。它同样是读时派生，`run_state` 保留为它的在途子集——
 * 轮询与「有没有在跑」的判据要的正是这个窄口径，不必让调用方自己从八态里再挑一次。
 */
export interface AssistSessionListRow extends AssistSessionRow {
  readonly has_messages: boolean;
  readonly run_state: AssistSessionRunState | null;
  readonly list_state: AssistSessionListState | null;
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
    budgetScopeSessionId?: string | null | undefined;
    /**
     * 0145：建立时写下的上下文档位。缺省 262144（新会话的确定起点）。
     *
     * 由用例层给出「继承自哪条会话」的结论；仓储不做继承判断，也不读工作区默认——
     * 那样会让同一个事实有两个写入 Owner。
     */
    contextBudgetTokens?: number | undefined }): Promise<void> {
    const mode = input.conversationMode ?? 'AGENT';
    const parentSessionId = input.parentSessionId ?? null;
    const budgetScopeSessionId = input.budgetScopeSessionId ?? null;
    if ((parentSessionId === null) !== (budgetScopeSessionId === null)) {
      throw new Error('assist session parent and budget scope must be set together');
    }
    await sql`insert into assist_sessions (id, workspace_id, project_id, task_id, title,
      conversation_mode, chat_mode, working_resource_id, working_directory_source,
      assistant_profile_id, assistant_profile_revision, assistant_role_snapshot,
      parent_session_id, budget_scope_session_id, context_budget_tokens)
      values (${input.id}, ${input.workspaceId}, ${input.projectId}, ${input.taskId},
      ${input.title}, ${mode}, ${input.chatMode ?? 'CHAT'},
      ${input.workingResourceId ?? null}, ${input.workingDirectorySource ?? null},
      ${mode === 'ASSISTANT' ? input.assistantProfileId ?? null : null},
      ${mode === 'ASSISTANT' ? input.assistantProfileRevision ?? null : null},
      ${mode === 'ASSISTANT' && input.assistantRoleSnapshot !== undefined && input.assistantRoleSnapshot !== null
        ? JSON.stringify(input.assistantRoleSnapshot) : null}::jsonb,
      ${parentSessionId}, ${budgetScopeSessionId},
      ${input.contextBudgetTokens ?? DEFAULT_SESSION_CONTEXT_BUDGET})`.execute(this.db);
  }

  /**
   * 0145：保存本会话的上下文档位（唯一写入口）。
   *
   * CAS 打在 `context_budget_revision` 上：不等即 0 行，调用方据此报 409，
   * 不覆盖并发写入的一方。`revision`（会话总修订）不动——档位变化不是会话身份或状态变化，
   * 让它去推进会话修订会把在途的改名、置顶打成冲突。
   */
  async setContextBudget(sessionId: string, tokens: number,
    expectedRevision: bigint): Promise<bigint | undefined> {
    const changed = await sql<{ context_budget_revision: bigint }>`update assist_sessions
      set context_budget_tokens = ${tokens},
        context_budget_revision = context_budget_revision + 1
      where id = ${sessionId} and context_budget_revision = ${expectedRevision}
      returning context_budget_revision`.execute(this.db);
    return changed.rows[0]?.context_budget_revision;
  }

  /**
   * 0145：会话最近一次**已结算**的真实模型调用（含上下文构成）。
   *
   * 绑定确切调用身份：一次外呼一行 `model_calls`，多轮工具调用各自一行。
   * 不把整个会话的多次调用加起来冒充「单次构成」。`FAILED` 的调用没有分项意义，
   * 但保留了实付总用量，因此也接收——由读侧按 status 区分。
   */
  async latestContextUsageCall(sessionId: string): Promise<AssistContextUsageCallRow | undefined> {
    /*
     * 只认**已结算且带用量**的调用。
     *
     * 在途（STARTED）行还没有用量，失败行可能只有一半读数；用它们覆盖「最近一次有效统计」
     * 会让圆环在一次生成进行中突然变成未知或半截数字。排序先按结算时刻、再按开始时刻，
     * 因此「最近一次有效统计」始终是上一次真正完成的调用。
     */
    return (await sql<AssistContextUsageCallRow>`select c.id, c.provider, c.model, c.status,
        c.usage_input_tokens, c.usage_output_tokens, c.usage_cache_read_tokens,
        c.usage_cache_creation_tokens, c.budget_reserved_tokens, c.context_usage,
        c.settled_at, c.started_at, c.assist_message_id
      from model_calls c join assist_messages m on m.id = c.assist_message_id
      where m.session_id = ${sessionId} and c.kind = 'ASSIST' and c.status <> 'STARTED'
        and (c.usage_input_tokens is not null or c.usage_output_tokens is not null)
      order by c.settled_at desc nulls last, c.started_at desc, c.id desc
      limit 1`.execute(this.db)).rows[0];
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
   *
   * 每行附带 `has_messages`：直接按 `assist_messages` 派生「有没有消息」，供界面判断
   * 「未开始」与分叉入口。它与排序键分开，不因活动键漏写而说谎。
   *
   * 每行还附带 `run_state`（2026-10-28）：同一次读取里按 `assist_messages.status` 派生
   * 「有没有在途的一轮」，`RUNNING` 压过 `PENDING`。两条都是相关子查询，
   * 左栏无论有多少行都只有这一条语句——不需要为每个条目单独发请求。
   *
   * `last_assistant_status` 与 `waiting_approval`（2026-10-30）补的是同一行状态图标需要的
   * 另外两类事实：最后一轮回复的终态、有没有待确认提案。它们同样是相关子查询，
   * 仍是一条语句、一次往返；`list_state` 由 `deriveListState` 在内存里合成，
   * 不把八态判定写进 SQL（列表与单条读取必须共用同一个派生点）。
   */
  async listSessions(workspaceId: string, projectId?: string, taskId?: string,
    status?: AssistSessionStatus | 'ALL'): Promise<readonly AssistSessionListRow[]> {
    const project = projectId === undefined ? sql`` : sql`and s.project_id = ${projectId}`;
    const task = taskId === undefined ? sql`` : sql`and s.task_id = ${taskId}`;
    const active = status === undefined || status === 'ALL' ? sql``
      : sql`and s.status = ${status}`;
    const rows = await sql<AssistSessionStateFacts & AssistSessionRow>`select s.*, exists(
        select 1 from assist_messages m where m.session_id = s.id) as has_messages,
      case
        when exists (select 1 from assist_messages m
          where m.session_id = s.id and m.status = 'RUNNING') then 'RUNNING'
        when exists (select 1 from assist_messages m
          where m.session_id = s.id and m.status = 'PENDING') then 'PENDING'
        else null
      end as run_state,
      (select m.status from assist_messages m
        where m.session_id = s.id and m.role = 'ASSISTANT'
        order by m.seq desc limit 1) as last_assistant_status,
      exists(select 1 from assist_proposals p
        where p.session_id = s.id and p.status = 'PENDING') as waiting_approval
      from assist_sessions s
      where s.workspace_id = ${workspaceId} ${project} ${task} ${active}
      order by s.pinned_at desc nulls last,
        coalesce(s.last_message_at, s.created_at) desc, s.id desc`.execute(this.db);
    return rows.rows.map((row) => ({ ...row, list_state: deriveListState(row) }));
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
   * 单条会话的三枚读时派生事实（2026-10-30）：有没有消息、在途的一轮、列表状态。
   *
   * 与列表投影**同一口径**——左栏切会话后按身份重读这一行，若这里另算一套，就会出现
   * 「切走亮、切回灭」。三条子查询合成一次往返：单条读取不是热路径，但也没有理由
   * 为同一行发三次请求。
   *
   * 「有没有消息」直接数 `assist_messages`，不读 `last_message_at`：活动键是排序用的
   * 可空列，任何写入路径漏了 `touchLastMessage` 都会让「NULL ⇒ 没消息」的推断说谎
   * （2026-10-24 的 0111 回填就是这种历史缺陷）。
   *
   * 「在途」同样只看消息状态，不看 `worker_id`、租约或心跳时间——那些是执行侧的恢复
   * 判据，界面不需要也不该据此猜「大概还在跑」。`RUNNING` 压过 `PENDING`。
   */
  async sessionActivity(sessionId: string): Promise<{ readonly hasMessages: boolean;
    readonly runState: AssistSessionRunState | null;
    readonly listState: AssistSessionListState | null } | undefined> {
    const rows = await sql<AssistSessionStateFacts>`select s.status,
        exists(select 1 from assist_messages m
          where m.session_id = s.id) as has_messages,
        case
          when exists (select 1 from assist_messages m
            where m.session_id = s.id and m.status = 'RUNNING') then 'RUNNING'
          when exists (select 1 from assist_messages m
            where m.session_id = s.id and m.status = 'PENDING') then 'PENDING'
          else null
        end as run_state,
        (select m.status from assist_messages m
          where m.session_id = s.id and m.role = 'ASSISTANT'
          order by m.seq desc limit 1) as last_assistant_status,
        exists(select 1 from assist_proposals p
          where p.session_id = s.id and p.status = 'PENDING') as waiting_approval
      from assist_sessions s where s.id = ${sessionId}`.execute(this.db);
    const row = rows.rows[0];
    if (row === undefined) return undefined;
    return { hasMessages: row.has_messages, runState: row.run_state, listState: deriveListState(row) };
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
        forked_from_session_id, context_budget_tokens)
      select ${input.id}, s.workspace_id, s.project_id, s.task_id, ${input.title},
        s.conversation_mode, s.assistant_profile_id, s.assistant_profile_revision,
        s.assistant_role_snapshot, s.remember, s.working_resource_id, s.working_directory_source, s.status,
        null, null, null, s.id,
        -- 0145：分叉沿源会话的档位起步（档位修订从 0 起，子会话自己的保存不回头写父会话）。
        s.context_budget_tokens
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
   *
   * 0128 的主子代理关系同样按跨对象事实阻断：主会话下还有子代理会话时不能删主会话
   * （子会话是独立会话，各有自己的生命周期，不随父级联消失）；反过来，子会话被父会话的
   * 委派账本引用（`child_session_id` 或尝试的结论消息）时也不能删——委派账本是父会话
   * 的执行史，清掉它等于替父会话抹掉一次委派发生过的事实。
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
      union all
      select 14, 'SUBAGENT_CHILDREN' where exists (
        select 1 from assist_sessions where parent_session_id = ${sessionId})
      union all
      select 15, 'DELEGATION_LEDGER_REFERENCED' where exists (
        select 1 from assist_delegations where child_session_id = ${sessionId})
      union all
      select 16, 'DELEGATION_LEDGER_REFERENCED' where exists (
        select 1 from assist_delegation_attempts a
        join assist_delegations d on d.id = a.delegation_id
        join assist_messages m on m.id = a.result_message_id
        where m.session_id = ${sessionId})
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
   * 未进入组合检查的影响检查、辅助模型调用计量、已到期冷却、diff 基线、0127 的计划与目标
   * 账本、0128 的委派账本。学习记录、执行请求与跨对象来源在阻断层就已拒绝，不会走到这里。
   *
   * 0127 的清理顺序由一组 NO ACTION 互指决定：计划引用来源消息、消息引用目标快照、
   * 目标引用计划版本——三方成环，必须先删额度授予与轮次这两张纯子表，再解除消息侧的
   * 目标快照引用（消息随后整批删除，快照列不承载独立事实），然后按目标 → 计划删除，
   * 每一层父行删除时子表都已无引用。目标无论是否从计划启动、无论终结在哪一态，都随
   * 会话消失：目标与计划是这条会话的执行账本，不是被别的对象引用的外部事实。
   * 0128 的委派账本与尝试是主会话自己的执行史，随主会话清理；存在子会话或账本被
   * 反向引用时，删除在阻断层已整条拒绝，走不到这里。
   */
  async deleteSession(sessionId: string, expectedRevision: bigint):
  Promise<{ readonly messages: number; readonly attachments: number } | undefined> {
    await sql`delete from assist_memory_uses where session_id = ${sessionId}`.execute(this.db);
    await sql`delete from assist_memory_state where session_id = ${sessionId}`.execute(this.db);
    await sql`delete from assist_memory_requests where session_id = ${sessionId}`.execute(this.db);
    await sql`delete from assist_memory_checkpoints where session_id = ${sessionId}`.execute(this.db);
    // 0137 / ADR-030：自动记忆的捕获账本与来源绑定都外键指向本会话的消息（NO ACTION），
    // 删消息前必须先摘掉，否则整条删除撞外键失败。只删**凭据**（哪条消息的哪一段），
    // 不动 memory_items / memory_versions——长期记忆有自己的停用入口，删会话不等于遗忘。
    await sql`delete from memory_auto_captures where session_id = ${sessionId}`.execute(this.db);
    await sql`delete from memory_message_sources where session_id = ${sessionId}`.execute(this.db);
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
    await sql`delete from assist_goal_budget_grants where goal_id in (
      select id from assist_goals where session_id = ${sessionId})`.execute(this.db);
    await sql`delete from assist_goal_rounds where goal_id in (
      select id from assist_goals where session_id = ${sessionId})`.execute(this.db);
    await sql`update assist_messages set goal_id = null
      where session_id = ${sessionId}`.execute(this.db);
    await sql`delete from assist_goals where session_id = ${sessionId}`.execute(this.db);
    await sql`delete from assist_plans where session_id = ${sessionId}`.execute(this.db);
    await sql`delete from assist_delegation_attempts where delegation_id in (
      select id from assist_delegations where parent_session_id = ${sessionId})`.execute(this.db);
    await sql`delete from assist_delegations where parent_session_id = ${sessionId}`.execute(this.db);
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
    /** 0142：受理时所用凭据的单向身份；服务端比较用，不返回前端。 */
    modelCredentialFingerprint?: string | null | undefined;
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
      model_credential_fingerprint, chat_mode, goal_id)
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
      ${input.modelCredentialFingerprint ?? null},
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
      where (m.status = 'PENDING' and s.parent_session_id is null
          and (s.project_id is null or p.archived_at is null))
        or (m.status = 'PENDING' and m.updated_at < ${olderThan} and exists (
          select 1 from assist_delegation_attempts a
          where a.result_message_id = m.id and a.status = 'RUNNING'))
        or (m.status = 'RUNNING' and m.updated_at < ${olderThan})
      union all
      select j.anchor_message_id as id from assist_memory_requests j
      where j.status = 'PENDING'
        or (j.status = 'RUNNING' and j.lease_until < now())
      limit 1`.execute(this.db);
    return result.rows.length > 0;
  }

  /** 在调用方短事务内先锁会话，再用新语句快照领取消息；同会话生成期间保留后续排队。
   *  0122：同一句里清掉插话意图——这一行开始自己生成后，就不再是别人的插话对象。 */
  async claimNextPendingMessage(workerId: string): Promise<AssistMessageRow | undefined> {
    // AGENT_SESSION_GENERATION_FENCE：会话锁跨两句持有，第二句重新核对已提交的 RUNNING。
    const session = (await sql<{ id: string }>`select s.id from assist_sessions s
      left join projects p on p.id = s.project_id
      where (s.project_id is null or p.archived_at is null)
          and s.parent_session_id is null
        and exists (select 1 from assist_messages m where m.session_id = s.id and m.status = 'PENDING')
        and not exists (select 1 from assist_messages m where m.session_id = s.id and m.status = 'RUNNING')
        and not exists (select 1 from assist_memory_requests j where j.session_id = s.id
          and j.status in ('PENDING', 'RUNNING'))
      order by s.id limit 1 for update of s skip locked`.execute(this.db)).rows[0];
    if (session === undefined) return undefined;
    return (await sql<AssistMessageRow>`update assist_messages set status = 'RUNNING',
      worker_id = ${workerId}, steer_requested = false, updated_at = now()
      where id = (select m.id from assist_messages m
        where m.session_id = ${session.id} and m.status = 'PENDING'
          and not exists (select 1 from assist_messages running
            where running.session_id = ${session.id} and running.status = 'RUNNING')
        order by m.created_at, m.id limit 1 for update of m skip locked)
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
      where (status = 'RUNNING' or (status = 'PENDING' and exists (
        select 1 from assist_delegation_attempts a
        where a.result_message_id = assist_messages.id and a.status = 'RUNNING')))
        and updated_at < ${olderThan} returning id
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
