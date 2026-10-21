import { sql } from 'kysely';

import type { DbExecutor } from '../infrastructure/database.js';
import type {
  AssistGoalBudgetGrantRow, AssistGoalRoundRow, AssistGoalRow, AssistGoalStatus,
  AssistMessageRow, AssistPlanRow, ChatMode,
} from '../infrastructure/database-schema.js';
import type { JsonObject } from '../infrastructure/json.js';

/**
 * 0127：聊天 `/plan` 与 `/goal` 的持久化（总纲 §0.15、运行架构 §9）。
 *
 * 这张仓储只做**读写与 CAS**，不解释业务：
 *   * 计划版本不可变——修改＝插入新版本，旧版本标 `SUPERSEDED`；
 *   * 目标状态只经 `updateGoal()` 的修订号 CAS 前进，任何「先读后写」都不会覆盖别人的决定；
 *   * 目标推进租约是**排他**的唯一手段：一条目标的下一轮只由持租约的那次 tick 组织；
 *   * 轮次结算按 `message_id` 唯一——恢复重扫只会读回同一行，不重复推进。
 *
 * 没有任何方法写第二套 Task/Run 状态：目标只是会话里的持续意图，实际动作仍走
 * Gateway 准入与会话工具账本。
 */

export interface SessionChatModeState {
  readonly chatMode: ChatMode;
  readonly revision: bigint;
}

export interface InsertPlanInput {
  readonly id: string;
  readonly workspaceId: string;
  readonly sessionId: string;
  readonly goal: string;
  readonly scope: readonly JsonObject[];
  readonly steps: readonly JsonObject[];
  readonly verification: readonly JsonObject[];
  readonly openQuestions: readonly JsonObject[];
  readonly sourceMessageId: string;
}

export interface InsertGoalInput {
  readonly id: string;
  readonly workspaceId: string;
  readonly sessionId: string;
  readonly planVersionId: string | null;
  readonly objective: string;
  readonly criteria: readonly JsonObject[];
  readonly steps: readonly JsonObject[];
}

/** 一次 CAS 更新的补丁；未给出的字段保持原值。`status` 决定终结时刻。 */
export interface GoalPatch {
  readonly status?: AssistGoalStatus;
  readonly currentStep?: string | null;
  readonly progress?: string | null;
  readonly stopReason?: JsonObject | null;
  readonly criteria?: readonly JsonObject[];
  readonly steps?: readonly JsonObject[];
  readonly roundCount?: number;
  readonly noProgressRounds?: number;
  readonly nextRoundAt?: Date | null;
  readonly lastRoundMessageId?: string | null;
  readonly leaseOwner?: string | null;
  readonly leaseExpiresAt?: Date | null;
}

const TERMINAL: readonly AssistGoalStatus[] = ['COMPLETED', 'CANCELLED', 'FAILED'];

export class PlanGoalRepository {
  constructor(private readonly db: DbExecutor) {}

  // ------------------------------------------------------------------ 会话模式

  async readSessionChatMode(sessionId: string, lock = false): Promise<SessionChatModeState | undefined> {
    const suffix = lock ? sql`for update` : sql``;
    const row = (await sql<{ chat_mode: ChatMode; revision: bigint }>`
      select chat_mode, revision from assist_sessions where id = ${sessionId} ${suffix}`
      .execute(this.db)).rows[0];
    return row === undefined ? undefined : { chatMode: row.chat_mode, revision: row.revision };
  }

  /**
   * 切换行为模式。
   *
   * 修订号 CAS 是唯一闸门：界面上的选择器与「用户随后发的 `/plan`」可能并发，
   * 后到的那个必须失败并让用户重新读取，而不是悄悄覆盖前一个决定。
   */
  async setSessionChatMode(input: { sessionId: string; mode: ChatMode;
    expectedRevision?: bigint | undefined }): Promise<boolean> {
    const expected = input.expectedRevision === undefined
      ? sql`` : sql`and revision = ${input.expectedRevision}`;
    const updated = (await sql<{ id: string }>`update assist_sessions
      set chat_mode = ${input.mode}, revision = revision + 1, updated_at = now()
      where id = ${input.sessionId} and status = 'ACTIVE' ${expected}
      returning id`.execute(this.db)).rows;
    return updated.length === 1;
  }

  // ------------------------------------------------------------------ 计划版本

  async readPlan(id: string): Promise<AssistPlanRow | undefined> {
    return (await sql<AssistPlanRow>`select * from assist_plans where id = ${id}`
      .execute(this.db)).rows[0];
  }

  async readPlanBySourceMessage(sessionId: string,
    messageId: string): Promise<AssistPlanRow | undefined> {
    return (await sql<AssistPlanRow>`select * from assist_plans
      where session_id = ${sessionId} and source_message_id = ${messageId}`
      .execute(this.db)).rows[0];
  }

  async readLatestPlan(sessionId: string): Promise<AssistPlanRow | undefined> {
    return (await sql<AssistPlanRow>`select * from assist_plans
      where session_id = ${sessionId} order by version desc limit 1`
      .execute(this.db)).rows[0];
  }

  async listPlans(sessionId: string, limit = 20): Promise<readonly AssistPlanRow[]> {
    return (await sql<AssistPlanRow>`select * from assist_plans
      where session_id = ${sessionId} order by version desc limit ${Math.max(1, Math.min(100, limit))}`
      .execute(this.db)).rows;
  }

  /**
   * 落一版新计划：同一条原消息只产生一版（唯一键），并把它之前的 CURRENT 标为 SUPERSEDED。
   *
   * 版本号由服务端在此刻取 `max+1`，不接受调用方传入——「不靠标题匹配版本」的另一半
   * 是「版本号不能由模型给」。并发两次插入由 `uq_assist_plan_version` 兜底，后到者失败。
   */
  async insertPlanVersion(input: InsertPlanInput): Promise<AssistPlanRow> {
    const next = (await sql<{ version: number }>`select coalesce(max(version), 0) + 1 as version
      from assist_plans where session_id = ${input.sessionId}`.execute(this.db)).rows[0]!.version;
    await sql`update assist_plans set status = 'SUPERSEDED'
      where session_id = ${input.sessionId} and status = 'CURRENT'`.execute(this.db);
    await sql`insert into assist_plans (id, workspace_id, session_id, version, status, goal,
      scope, steps, verification, open_questions, source_message_id)
      values (${input.id}, ${input.workspaceId}, ${input.sessionId}, ${next}, 'CURRENT',
        ${input.goal}, ${JSON.stringify(input.scope)}::jsonb,
        ${JSON.stringify(input.steps)}::jsonb, ${JSON.stringify(input.verification)}::jsonb,
        ${JSON.stringify(input.openQuestions)}::jsonb, ${input.sourceMessageId})`
      .execute(this.db);
    const row = await this.readPlan(input.id);
    if (row === undefined) throw new Error('assist plan disappeared during insertion');
    return row;
  }

  // ------------------------------------------------------------------ 目标

  async readGoal(id: string, lock = false): Promise<AssistGoalRow | undefined> {
    const suffix = lock ? sql`for update` : sql``;
    return (await sql<AssistGoalRow>`select * from assist_goals
      where id = ${id} ${suffix}`.execute(this.db)).rows[0];
  }

  /** 会话当前占用槽位的目标（终结态不算）；没有则为 undefined。 */
  async readOpenGoal(sessionId: string, lock = false): Promise<AssistGoalRow | undefined> {
    const suffix = lock ? sql`for update` : sql``;
    return (await sql<AssistGoalRow>`select * from assist_goals
      where session_id = ${sessionId}
        and status not in ('COMPLETED', 'CANCELLED', 'FAILED')
      ${suffix}`.execute(this.db)).rows[0];
  }

  async listSessionGoals(sessionId: string, limit = 20): Promise<readonly AssistGoalRow[]> {
    return (await sql<AssistGoalRow>`select * from assist_goals
      where session_id = ${sessionId} order by created_at desc
      limit ${Math.max(1, Math.min(50, limit))}`.execute(this.db)).rows;
  }

  async insertGoal(input: InsertGoalInput): Promise<AssistGoalRow> {
    await sql`insert into assist_goals (id, workspace_id, session_id, plan_version_id,
      objective, criteria, steps, status, next_round_at)
      values (${input.id}, ${input.workspaceId}, ${input.sessionId}, ${input.planVersionId},
        ${input.objective}, ${JSON.stringify(input.criteria)}::jsonb,
        ${JSON.stringify(input.steps)}::jsonb, 'ACTIVE', now())`.execute(this.db);
    const row = await this.readGoal(input.id);
    if (row === undefined) throw new Error('assist goal disappeared during insertion');
    return row;
  }

  /**
   * 按修订号 CAS 更新目标。
   *
   * 返回 false 表示「别人先改了」——调用方必须把它当成**正常竞争**处理（重新读取后再决定），
   * 不能重试覆盖。暂停/取消与完成竞争正是靠这条判定收敛的：迟到结果拿旧修订号写不进去。
   */
  async updateGoal(id: string, expectedRevision: bigint, patch: GoalPatch): Promise<boolean> {
    const assignments = [sql`updated_at = now()`, sql`revision = revision + 1`];
    if (patch.status !== undefined) {
      assignments.push(sql`status = ${patch.status}`);
      assignments.push(TERMINAL.includes(patch.status)
        ? sql`closed_at = now()` : sql`closed_at = null`);
      // 终态与暂停都不再需要推进租约；清掉它，避免下一个 tick 以为还有人持有。
      if (patch.status !== 'ACTIVE' && patch.leaseOwner === undefined) {
        assignments.push(sql`lease_owner = null`, sql`lease_expires_at = null`);
      }
    }
    if (patch.currentStep !== undefined) assignments.push(sql`current_step = ${patch.currentStep}`);
    if (patch.progress !== undefined) assignments.push(sql`progress = ${patch.progress}`);
    if (patch.stopReason !== undefined) {
      assignments.push(sql`stop_reason = ${patch.stopReason === null ? null
        : JSON.stringify(patch.stopReason)}::jsonb`);
    }
    if (patch.criteria !== undefined) {
      assignments.push(sql`criteria = ${JSON.stringify(patch.criteria)}::jsonb`);
    }
    if (patch.steps !== undefined) assignments.push(sql`steps = ${JSON.stringify(patch.steps)}::jsonb`);
    if (patch.roundCount !== undefined) assignments.push(sql`round_count = ${patch.roundCount}`);
    if (patch.noProgressRounds !== undefined) {
      assignments.push(sql`no_progress_rounds = ${patch.noProgressRounds}`);
    }
    if (patch.nextRoundAt !== undefined) assignments.push(sql`next_round_at = ${patch.nextRoundAt}`);
    if (patch.lastRoundMessageId !== undefined) {
      assignments.push(sql`last_round_message_id = ${patch.lastRoundMessageId}`);
    }
    if (patch.leaseOwner !== undefined) assignments.push(sql`lease_owner = ${patch.leaseOwner}`);
    if (patch.leaseExpiresAt !== undefined) {
      assignments.push(sql`lease_expires_at = ${patch.leaseExpiresAt}`);
    }
    const updated = (await sql<{ id: string }>`update assist_goals set
      ${sql.join(assignments, sql`, `)}
      where id = ${id} and revision = ${expectedRevision}
      returning id`.execute(this.db)).rows;
    return updated.length === 1;
  }

  /**
   * 可推进的目标：还在 ACTIVE、到了下一轮的时刻、租约已空或已过期。
   *
   * 「租约过期」只说明可以**重新组织**下一轮，不证明旧 tick 已经停止——所以组织下一轮时
   * 必须再次核对目标当前有没有在途轮次消息（见 `readInflightRoundMessage`），而不是
   * 靠租约时间推断。
   */
  async listAdvanceCandidates(now: Date, limit = 10): Promise<readonly AssistGoalRow[]> {
    return (await sql<AssistGoalRow>`select * from assist_goals
      where status = 'ACTIVE'
        and (next_round_at is null or next_round_at <= ${now})
        and (lease_owner is null or lease_expires_at is null or lease_expires_at <= ${now})
      order by next_round_at nulls first, created_at
      limit ${Math.max(1, Math.min(50, limit))}`.execute(this.db)).rows;
  }

  /**
   * 控制落定阶段只看带控制意图的目标。
   *
   * 不能沿用「所有未终结目标按 updated_at 取一页」：PAUSED / WAITING_USER 等静止行
   * 没有任何要做的动作，却会长期占满窗口，把后来的 PAUSING / CANCELLING 挡在外面。
   * 候选范围按阶段缩小后，静止目标不参与控制扫描；每落定一条就离开集合，逐个 tick
   * 有界推进，不需要提高页大小或改无关目标的时间戳。
   *
   * 在途 CANCELLING 排在没有在途轮次的目标之后：它们每个 tick 只需重复标记停止，
   * 不应挡住同批里本可立即收口的暂停/取消。其余按 updated_at、id 排序，稳定可复现。
   */
  async listControlGoalsForTick(limit = 50): Promise<readonly AssistGoalRow[]> {
    return (await sql<AssistGoalRow>`select g.* from assist_goals g
      where g.status in ('PAUSING', 'CANCELLING')
      order by exists (
        select 1 from assist_messages m
        where m.goal_id = g.id and m.status in ('PENDING', 'RUNNING')
      ), g.updated_at, g.id
      limit ${Math.max(1, Math.min(200, limit))}`.execute(this.db)).rows;
  }

  /**
   * 轮次结算阶段只看「最新一条已结算消息还没有轮次账」的目标。
   *
   * 不能简单排除 PAUSED：暂停/取消先于轮次结算落定时，暂停目标上仍可能压着已结算
   * 但未记账的轮次，排除它会永久丢掉这条事实。这里按消息事实筛选、不按目标状态筛选
   * （终态除外）；每结算一条就离开候选集，静止目标不会饿死后来者。
   */
  async listGoalsWithUnsettledRounds(limit = 50): Promise<readonly AssistGoalRow[]> {
    return (await sql<AssistGoalRow>`select g.* from assist_goals g
      where g.status not in ('COMPLETED', 'CANCELLED', 'FAILED')
        and exists (
          select 1 from assist_messages m
          where m.goal_id = g.id
            and m.status in ('COMPLETED', 'FAILED', 'CANCELLED')
            and m.seq = (
              select max(m2.seq) from assist_messages m2
              where m2.goal_id = g.id and m2.status in ('COMPLETED', 'FAILED', 'CANCELLED')
            )
            and not exists (
              select 1 from assist_goal_rounds r where r.message_id = m.id
            )
        )
      order by g.updated_at, g.id
      limit ${Math.max(1, Math.min(200, limit))}`.execute(this.db)).rows;
  }

  /** 目标还有未结算的轮次消息（PENDING/RUNNING）时，本轮不组织下一轮。 */
  async readInflightRoundMessage(goalId: string): Promise<AssistMessageRow | undefined> {
    return (await sql<AssistMessageRow>`select * from assist_messages
      where goal_id = ${goalId} and status in ('PENDING', 'RUNNING')
      order by seq limit 1`.execute(this.db)).rows[0];
  }

  /** 目标最近一条已结算的轮次消息（恢复时用它补结算缺失的轮次行）。 */
  async readLatestSettledRoundMessage(goalId: string): Promise<AssistMessageRow | undefined> {
    return (await sql<AssistMessageRow>`select * from assist_messages
      where goal_id = ${goalId} and status in ('COMPLETED', 'FAILED', 'CANCELLED')
      order by seq desc limit 1`.execute(this.db)).rows[0];
  }

  /**
   * 与 `assist-repository.setCancelRequested` 同一语义：PENDING 还没有调用模型，直接
   * 收敛为 CANCELLED；RUNNING 只记录意图，由生成方结算。留着 PENDING 的
   * `cancel_requested=true` 会被领取队列捞走，生成端按失权拒绝并逃出 Worker 主循环。
   */
  async markMessageCancelRequested(messageId: string): Promise<void> {
    await sql`update assist_messages set
      status = case when status = 'PENDING' then 'CANCELLED' else status end,
      cancel_requested = true, updated_at = now()
      where id = ${messageId} and status in ('PENDING', 'RUNNING')`.execute(this.db);
  }

  // ------------------------------------------------------------------ 轮次账本

  async readRoundByMessage(messageId: string): Promise<AssistGoalRoundRow | undefined> {
    return (await sql<AssistGoalRoundRow>`select * from assist_goal_rounds
      where message_id = ${messageId}`.execute(this.db)).rows[0];
  }

  async listRounds(goalId: string, limit = 20): Promise<readonly AssistGoalRoundRow[]> {
    return (await sql<AssistGoalRoundRow>`select * from assist_goal_rounds
      where goal_id = ${goalId} order by round_index desc
      limit ${Math.max(1, Math.min(100, limit))}`.execute(this.db)).rows;
  }

  async insertRound(input: { id: string; goalId: string; messageId: string;
    roundIndex: number; outcome: string; note: string | null;
    criteriaSnapshot: readonly JsonObject[] }): Promise<boolean> {
    const inserted = (await sql<{ id: string }>`insert into assist_goal_rounds
      (id, goal_id, message_id, round_index, outcome, note, criteria_snapshot)
      values (${input.id}, ${input.goalId}, ${input.messageId}, ${input.roundIndex},
        ${input.outcome}, ${input.note}, ${JSON.stringify(input.criteriaSnapshot)}::jsonb)
      on conflict (message_id) do nothing
      returning id`.execute(this.db)).rows;
    return inserted.length === 1;
  }

  // ------------------------------------------------------------------ 额度授权

  async sumGrants(goalId: string): Promise<{ calls: number; tokens: number }> {
    const row = (await sql<{ calls: string; tokens: string }>`select
      coalesce(sum(granted_calls), 0)::text as calls,
      coalesce(sum(granted_tokens), 0)::text as tokens
      from assist_goal_budget_grants where goal_id = ${goalId}`.execute(this.db)).rows[0];
    return { calls: Number(row?.calls ?? '0'), tokens: Number(row?.tokens ?? '0') };
  }

  /**
   * 记录一次「继续」授予的额度。
   *
   * 同一命令只写一行（`uq_assist_goal_grant_command`）：用户连点两次不会让额度翻倍，
   * 也不会让目标被推进两次。
   */
  async insertGrant(input: { id: string; goalId: string; commandId: string;
    grantedCalls: number; grantedTokens: number }): Promise<boolean> {
    const inserted = (await sql<{ id: string }>`insert into assist_goal_budget_grants
      (id, goal_id, command_id, granted_calls, granted_tokens)
      values (${input.id}, ${input.goalId}, ${input.commandId},
        ${input.grantedCalls}, ${input.grantedTokens})
      on conflict (command_id) do nothing
      returning id`.execute(this.db)).rows;
    return inserted.length === 1;
  }

  async readGrantByCommand(commandId: string): Promise<AssistGoalBudgetGrantRow | undefined> {
    return (await sql<AssistGoalBudgetGrantRow>`select * from assist_goal_budget_grants
      where command_id = ${commandId}`.execute(this.db)).rows[0];
  }
}
