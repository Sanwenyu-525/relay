import { randomUUID } from 'node:crypto';

import type { AssistGoalRow, AssistGoalStatus, AssistPlanRow } from '../infrastructure/database-schema.js';
import type { DbExecutor } from '../infrastructure/database.js';
import type { JsonObject } from '../infrastructure/json.js';
import { toDecimalString } from '../shared/decimal.js';
import { httpCommandScopeKey } from './actor.js';
import { runIdempotentCommand, type CommandOutcome } from './command.js';
import { DomainError, invalidTransition, resourceNotFound } from './domain-error.js';
import { readModelPortConfig } from '../workflow/model-port-config.js';
import { createRepositories, type Repositories } from './unit-of-work.js';

/**
 * 0127：`/goal` 的持久目标（工作台 §44.2、运行架构 §9）。
 *
 * 这个模块只负责**意图与状态**，不推进：组织下一轮、读取结算结果、把状态往前挪
 * 全部由 `goal-advance.ts` 的那一次 Worker tick 完成。用户命令（暂停/取消/继续/确认完成）
 * 只写「控制意图」，由同一个 tick 安全处理在途轮次后再落定——因此界面永远不会因为
 * 只改了一个本地状态就显示「已暂停」。
 *
 * 不变量：
 *   * 一条会话最多一个未终结目标（迁移里的部分唯一索引）；
 *   * 已冻结的成功条件不因新计划版本而改变；
 *   * 取消不撤销任何已经发生的修改或外部效果，只停止后续推进；
 *   * 额度耗尽后不自动执行，必须用户点一次「继续」，且那次授予写入独立账本。
 */

export interface GoalCriterion {
  readonly key: string;
  readonly statement: string;
  readonly status: 'MET' | 'UNMET' | 'PENDING';
  readonly evidence: string | null;
  readonly required: boolean;
}

export interface GoalStep {
  readonly title: string;
  readonly status: 'PENDING' | 'DOING' | 'DONE';
}

export interface GoalStopReason {
  /** 类型化代码，客户端按它决定显示哪一句与哪个按钮。 */
  readonly code: string;
  /** 用户可读的具体原因（不是「出错了」）。 */
  readonly detail: string;
  /** 需要用户决定时的问题；只用于等待决定。 */
  readonly questions: readonly string[];
  /** 这条原因是否可以通过「继续」重试。 */
  readonly resumable: boolean;
}

export interface GoalRoundProjection {
  readonly round_index: number;
  readonly outcome: string;
  readonly note: string | null;
  readonly created_at: string;
}

export interface GoalProjection {
  readonly goal_id: string;
  readonly session_id: string;
  readonly objective: string;
  readonly status: AssistGoalStatus;
  readonly current_step: string | null;
  readonly progress: string | null;
  readonly stop_reason: GoalStopReason | null;
  readonly criteria: readonly GoalCriterion[];
  readonly steps: readonly GoalStep[];
  readonly round_count: number;
  readonly no_progress_rounds: number;
  readonly plan_version_id: string | null;
  readonly plan_version: number | null;
  readonly last_round_at: string | null;
  /** 用户可以做的下一步；由服务端判定，客户端不自行推断。 */
  readonly actions: {
    readonly pause: boolean;
    readonly cancel: boolean;
    readonly resume: boolean;
    readonly confirm_completion: boolean;
  };
  readonly revision: string;
  readonly created_at: string;
  readonly updated_at: string;
}

const TERMINAL: readonly AssistGoalStatus[] = ['COMPLETED', 'CANCELLED', 'FAILED'];
const PAUSABLE: readonly AssistGoalStatus[] = ['ACTIVE', 'WAITING_USER', 'BLOCKED'];
const RESUMABLE: readonly AssistGoalStatus[] = ['PAUSED', 'WAITING_USER', 'BLOCKED',
  'BUDGET_EXHAUSTED'];

/**
 * 目标/计划上的 criteria、steps、verification 在库里都是**JSON 数组**
 * （迁移 0127：`DEFAULT '[]'::jsonb`；写入方 `insertGoal` / `updateGoal` /
 * `insertPlanVersion` 直接存数组）。以前这里按 `value['items']` 取，数组上永远取不到，
 * 于是已冻结的成功条件与步骤在投影和推进器里都读成空——「条件不丢」这条不变量
 * 实际上没有事实可核对。
 */
function objectItems(value: JsonObject): JsonObject[] {
  return (Array.isArray(value) ? value as unknown as readonly unknown[] : [])
    .filter((item): item is JsonObject =>
      typeof item === 'object' && item !== null && !Array.isArray(item));
}

function criteriaOf(row: AssistGoalRow): GoalCriterion[] {
  return objectItems(row.criteria).map((item) => ({
    key: String(item.key ?? ''), statement: String(item.statement ?? ''),
    status: item.status === 'MET' || item.status === 'UNMET' ? item.status : 'PENDING',
    evidence: typeof item.evidence === 'string' ? item.evidence : null,
    required: item.required !== false,
  }));
}

function stepsOf(row: AssistGoalRow): GoalStep[] {
  return objectItems(row.steps).map((item) => ({
    title: String(item.title ?? ''),
    status: item.status === 'DOING' || item.status === 'DONE' ? item.status : 'PENDING',
  }));
}

function stopReasonOf(row: AssistGoalRow): GoalStopReason | null {
  const raw = row.stop_reason;
  if (raw === null) return null;
  const questions = Array.isArray(raw.questions)
    ? raw.questions.filter((item): item is string => typeof item === 'string') : [];
  return { code: typeof raw.code === 'string' ? raw.code : 'UNKNOWN',
    detail: typeof raw.detail === 'string' ? raw.detail : '',
    questions,
    resumable: raw.resumable === true };
}

export function goalProjection(row: AssistGoalRow, planVersion: number | null,
  lastRoundAt: Date | null): GoalProjection {
  return {
    goal_id: row.id, session_id: row.session_id, objective: row.objective,
    status: row.status, current_step: row.current_step, progress: row.progress,
    stop_reason: stopReasonOf(row), criteria: criteriaOf(row), steps: stepsOf(row),
    round_count: row.round_count, no_progress_rounds: row.no_progress_rounds,
    plan_version_id: row.plan_version_id, plan_version: planVersion,
    last_round_at: lastRoundAt === null ? null : lastRoundAt.toISOString(),
    actions: {
      pause: PAUSABLE.includes(row.status),
      cancel: !TERMINAL.includes(row.status),
      resume: RESUMABLE.includes(row.status),
      confirm_completion: row.status === 'AWAITING_ACCEPTANCE',
    },
    revision: toDecimalString(row.revision),
    created_at: row.created_at.toISOString(), updated_at: row.updated_at.toISOString(),
  };
}

export interface SessionGoalView {
  readonly goal: GoalProjection | null;
  readonly rounds: readonly GoalRoundProjection[];
}

async function planVersionOf(repositories: Repositories,
  row: AssistGoalRow): Promise<number | null> {
  if (row.plan_version_id === null) return null;
  const plan = await repositories.planGoals.readPlan(row.plan_version_id);
  return plan?.version ?? null;
}

async function projectRow(repositories: Repositories, row: AssistGoalRow): Promise<GoalProjection> {
  const latest = await repositories.planGoals.readLatestSettledRoundMessage(row.id);
  return goalProjection(row, await planVersionOf(repositories, row), latest?.updated_at ?? null);
}

export async function readSessionGoal(db: DbExecutor, input: {
  workspaceId: string; sessionId: string }): Promise<SessionGoalView> {
  const repositories = createRepositories(db);
  const session = await repositories.assist.readSession(input.sessionId);
  if (session === undefined || session.workspace_id !== input.workspaceId) {
    throw resourceNotFound('Assist session');
  }
  const row = await repositories.planGoals.readOpenGoal(session.id);
  if (row === undefined) return { goal: null, rounds: [] };
  const rounds = await repositories.planGoals.listRounds(row.id, 12);
  return { goal: await projectRow(repositories, row),
    rounds: rounds.map((round) => ({ round_index: round.round_index,
      outcome: round.outcome, note: round.note,
      created_at: round.created_at.toISOString() })) };
}

/**
 * 由一条 `/goal` 消息建立目标（与消息命令同一事务）。
 *
 * 目标一开始**没有成功条件**：条件由第一轮在真实读取之后整理（简单目标自动整理，
 * 复杂目标先问用户）。这里只固定目标原文与启动时选定的计划版本。
 */
export async function createGoalForMessage(repositories: Repositories, input: {
  workspaceId: string; sessionId: string; objective: string;
  planVersionId?: string | null; criteria?: readonly JsonObject[];
  steps?: readonly JsonObject[] }): Promise<AssistGoalRow> {
  const open = await repositories.planGoals.readOpenGoal(input.sessionId);
  if (open !== undefined) {
    throw new DomainError({ code: 'GOAL_ALREADY_OPEN', status: 409,
      type: '/problems/goal-already-open', title: '这段会话已有目标',
      detail: '同一段会话同时只有一个目标。请先继续、取消或完成当前目标，再开始新的目标。',
      retryable: false, retryAction: 'REFRESH_AND_REDECIDE', conflict: {
        sessionId: input.sessionId, goalId: open.id } });
  }
  return repositories.planGoals.insertGoal({
    id: randomUUID(), workspaceId: input.workspaceId, sessionId: input.sessionId,
    planVersionId: input.planVersionId ?? null, objective: input.objective,
    criteria: input.criteria ?? [], steps: input.steps ?? [],
  });
}

/**
 * 控制命令的统一外壳。
 *
 * 每条命令都在**同一事务**里读目标、写目标、返回投影；修订号 CAS 失败按
 * 「别人先改了」拒绝，让客户端重新读取，而不是把过期决定覆盖上去。
 */
async function runGoalCommand(db: DbExecutor, input: {
  workspaceId: string; goalId: string; commandId: string; commandType: string;
  body: JsonObject;
  apply: (repositories: Repositories, goal: AssistGoalRow) => Promise<void>;
}): Promise<CommandOutcome<{ goal: JsonObject }>> {
  return runIdempotentCommand<{ goal: JsonObject }>(db, {
    scopeKey: httpCommandScopeKey(input.workspaceId), commandId: input.commandId,
    commandType: input.commandType, target: { goal_id: input.goalId }, body: input.body,
    execute: async (repositories) => {
      const goal = await repositories.planGoals.readGoal(input.goalId, true);
      if (goal === undefined || goal.workspace_id !== input.workspaceId) {
        throw resourceNotFound('Assist goal');
      }
      await input.apply(repositories, goal);
      const fresh = await repositories.planGoals.readGoal(input.goalId);
      if (fresh === undefined) throw resourceNotFound('Assist goal');
      return { goal: await projectRow(repositories, fresh) as unknown as JsonObject };
    },
  });
}

/** 按修订号推进状态；失败即代表并发竞争，按可重读冲突拒绝。 */
async function advance(repositories: Repositories, goal: AssistGoalRow,
  patch: Parameters<Repositories['planGoals']['updateGoal']>[2]): Promise<void> {
  const updated = await repositories.planGoals.updateGoal(goal.id, goal.revision, patch);
  if (!updated) {
    throw new DomainError({ code: 'GOAL_STATE_CHANGED', status: 409,
      type: '/problems/goal-state-changed', title: '目标状态刚被其他操作改变',
      detail: '这条目标的推进状态已被另一个操作改写；请重新读取目标后再决定。',
      retryable: true, retryAction: 'REFRESH_AND_REDECIDE',
      conflict: { goalId: goal.id, sessionId: goal.session_id } });
  }
}

/**
 * 暂停：只持久化控制意图。
 *
 * `ACTIVE` → `PAUSING`。真正显示「已暂停」要等推进器确认没有在途轮次——
 * 「点了暂停就显示已暂停」等于假装已经安全停下。
 */
export async function pauseGoal(db: DbExecutor, input: {
  workspaceId: string; goalId: string; commandId: string;
}) {
  return runGoalCommand(db, { workspaceId: input.workspaceId, goalId: input.goalId,
    commandId: input.commandId, commandType: 'PauseAssistGoal', body: {},
    apply: async (repositories, goal) => {
      if (goal.status === 'PAUSING' || goal.status === 'PAUSED') return;
      if (!PAUSABLE.includes(goal.status)) {
        throw invalidTransition(`当前目标状态（${goal.status}）不能暂停。`,
          { goalId: goal.id, sessionId: goal.session_id });
      }
      await advance(repositories, goal, { status: 'PAUSING' });
    } });
}

/** 取消：先记取消意图；在途轮次由推进器请求停止，结算后才落 `CANCELLED`。 */
export async function cancelGoal(db: DbExecutor, input: {
  workspaceId: string; goalId: string; commandId: string;
}) {
  return runGoalCommand(db, { workspaceId: input.workspaceId, goalId: input.goalId,
    commandId: input.commandId, commandType: 'CancelAssistGoal', body: {},
    apply: async (repositories, goal) => {
      if (goal.status === 'CANCELLING' || goal.status === 'CANCELLED') return;
      if (TERMINAL.includes(goal.status)) {
        throw invalidTransition('目标已经结束，没有可取消的推进。',
          { goalId: goal.id, sessionId: goal.session_id });
      }
      await advance(repositories, goal, { status: 'CANCELLING' });
    } });
}

/**
 * 继续。
 *
 * 两种入口共用一条命令，但**只有额度耗尽时才授予额度**：
 *   * `PAUSED` / `WAITING_USER` / `BLOCKED` → 恢复推进，不额外授予任何额度；
 *   * `BUDGET_EXHAUSTED` → 先写一行授权账本（授予量由失败轮次的冻结模型快照给出，
 *     不编造余额或重置时间），再恢复推进。
 *
 * 连点两次不会翻倍：同一 `command_id` 重放原回执，不同命令的授予由账本逐行记录。
 */
export async function resumeGoal(db: DbExecutor, input: {
  workspaceId: string; goalId: string; commandId: string;
  grant?: { readonly calls: number; readonly tokens: number } | undefined;
}) {
  const grant = input.grant;
  return runGoalCommand(db, { workspaceId: input.workspaceId, goalId: input.goalId,
    commandId: input.commandId, commandType: 'ResumeAssistGoal',
    body: { grant_calls: grant?.calls ?? null, grant_tokens: grant?.tokens ?? null },
    apply: async (repositories, goal) => {
      if (goal.status === 'ACTIVE') return;
      if (!RESUMABLE.includes(goal.status)) {
        throw invalidTransition(`当前目标状态（${goal.status}）不能继续；`
          + '完成与否请用「确认完成」，或重新发起一个目标。',
        { goalId: goal.id, sessionId: goal.session_id });
      }
      if (goal.status === 'BUDGET_EXHAUSTED') {
        if (grant === undefined || grant.calls <= 0 || grant.tokens <= 0) {
          throw invalidTransition('额度已耗尽，但这次继续没有带上可授予的额度；'
            + '请重新读取目标后重试。', { goalId: goal.id, sessionId: goal.session_id });
        }
        await repositories.planGoals.insertGrant({ id: randomUUID(), goalId: goal.id,
          commandId: input.commandId, grantedCalls: grant.calls, grantedTokens: grant.tokens });
      }
      await advance(repositories, goal, { status: 'ACTIVE', nextRoundAt: new Date(),
        noProgressRounds: 0, stopReason: null, leaseOwner: null, leaseExpiresAt: null });
    } });
}

/**
 * 人工确认完成（工作台 §44.2 的「等待人工验收」出口）。
 *
 * 模型声明完成只会把目标带到 `AWAITING_ACCEPTANCE`；把状态写成 `COMPLETED` 的只有这一条
 * 由用户显式触发的命令。这是「模型声称完成不算完成」在代码里的落点。
 */
export async function confirmGoalCompletion(db: DbExecutor, input: {
  workspaceId: string; goalId: string; commandId: string;
}) {
  return runGoalCommand(db, { workspaceId: input.workspaceId, goalId: input.goalId,
    commandId: input.commandId, commandType: 'ConfirmAssistGoal', body: {},
    apply: async (repositories, goal) => {
      if (goal.status === 'COMPLETED') return;
      if (goal.status !== 'AWAITING_ACCEPTANCE') {
        throw invalidTransition('目标还没有走到「等待验收」，不能直接确认完成。',
          { goalId: goal.id, sessionId: goal.session_id });
      }
      await advance(repositories, goal, { status: 'COMPLETED', nextRoundAt: null });
    } });
}

/** 计划里的「验证方式」就是目标的成功条件：一条验证对应一条必需条件。 */
function criteriaFromPlan(plan: AssistPlanRow): JsonObject[] {
  return objectItems(plan.verification).map((item, index): JsonObject => ({
    key: `c${index + 1}`, statement: String(item.statement ?? ''),
    status: 'PENDING', evidence: null, required: true, method: String(item.method ?? 'HUMAN'),
  })).filter((item) => String(item.statement ?? '').trim() !== '');
}

/**
 * 由一版计划启动目标（「按此计划执行」）。
 *
 * 选定版本**必须**是调用方明确给出的那一版：服务端核对它是否仍是当前最新版，
 * 过期时要求显式确认（`allow_superseded`），从不静默改用另一版。
 */
export async function startGoalFromPlan(db: DbExecutor, input: {
  workspaceId: string; sessionId: string; planId: string; commandId: string;
  allowSuperseded?: boolean | undefined;
}): Promise<CommandOutcome<{ goal: JsonObject }>> {
  return runIdempotentCommand<{ goal: JsonObject }>(db, {
    scopeKey: httpCommandScopeKey(input.workspaceId), commandId: input.commandId,
    commandType: 'StartAssistGoal', target: { session_id: input.sessionId },
    body: { plan_id: input.planId, allow_superseded: input.allowSuperseded === true },
    execute: async (repositories) => {
      const session = await repositories.assist.readSession(input.sessionId, true);
      if (session === undefined || session.workspace_id !== input.workspaceId) {
        throw resourceNotFound('Assist session');
      }
      if (session.status !== 'ACTIVE') {
        throw invalidTransition('会话已归档，不能从这里开始执行。', { sessionId: session.id });
      }
      const plan = await repositories.planGoals.readPlan(input.planId);
      if (plan === undefined || plan.session_id !== session.id) throw resourceNotFound('Assist plan');
      const latest = await repositories.planGoals.readLatestPlan(session.id);
      if (latest !== undefined && latest.version !== plan.version &&
          input.allowSuperseded !== true) {
        throw new DomainError({ code: 'PLAN_VERSION_SUPERSEDED', status: 409,
          type: '/problems/plan-version-superseded', title: '这一版计划已被新的版本取代',
          detail: `选定的第 ${plan.version} 版不是最新版（当前最新为第 ${latest.version} 版）。`
            + `请先核对两版差别；确认仍按第 ${plan.version} 版执行时再提交一次。`,
          retryable: true, retryAction: 'REFRESH_AND_REDECIDE',
          conflict: { sessionId: session.id, field: 'plan_id' } });
      }
      const goal = await createGoalForMessage(repositories, {
        workspaceId: input.workspaceId, sessionId: session.id,
        objective: plan.goal, planVersionId: plan.id,
        // 冻结执行契约：之后写入的新计划版本不改写这一个目标的成功条件与步骤。
        criteria: criteriaFromPlan(plan),
        steps: objectItems(plan.steps).map((step): JsonObject => ({
          title: String(step.title ?? ''), status: 'PENDING' })),
      });
      // 计划一被执行，会话就进入目标模式：后续补充要求按目标轮次处理。
      await repositories.planGoals.setSessionChatMode({ sessionId: session.id, mode: 'GOAL' });
      return { goal: goalProjection(goal, plan.version, null) as unknown as JsonObject };
    },
  });
}

/** 目标轮次消息应带上的目标状态（供提示词使用；不含任何能力声明）。 */
export function goalStateForPrompt(row: AssistGoalRow, planVersion: number | null): JsonObject {
  return {
    objective: row.objective,
    plan_version: planVersion,
    round: row.round_count,
    current_step: row.current_step,
    progress: row.progress,
    criteria: criteriaOf(row).map((criterion): JsonObject => ({
      key: criterion.key, statement: criterion.statement, status: criterion.status,
      evidence: criterion.evidence, required: criterion.required })),
    steps: stepsOf(row).map((step): JsonObject => ({ title: step.title, status: step.status })),
  };
}

/**
 * 额度耗尽后「继续」的授予量。
 *
 * 授予量**只来自可核对的事实**，不编造余额或重置时间：
 *   1. 失败那一轮消息上冻结的模型快照（`budget.scope_call_limit` / `scope_token_limit`）；
 *   2. 快照缺失时退到当前进程的模型配置；
 *   3. 两者都没有（Fake 端口/未配置真实模型）时给一个明确的最小窗口，
 *      让「继续」仍然是可解释的一次显式授权，而不是无声重启。
 *
 * 它只是**把既有上限再加一个窗口**，不是无限额度：下一个窗口用尽会再次落到
 * 「额度耗尽」，同样需要用户再点一次。
 */
export async function knownGrantForGoal(db: DbExecutor, goal: AssistGoalRow): Promise<{
  readonly calls: number; readonly tokens: number }> {
  const repositories = createRepositories(db);
  const message = await repositories.planGoals.readLatestSettledRoundMessage(goal.id);
  const snapshot = message?.model_selection_snapshot ?? null;
  const rawBudget = snapshot === null ? undefined : snapshot.budget;
  const budget = rawBudget !== null && typeof rawBudget === 'object'
    && !Array.isArray(rawBudget) ? rawBudget as JsonObject : undefined;
  if (budget !== undefined) {
    const calls = budget.scope_call_limit;
    const tokens = budget.scope_token_limit;
    if (typeof calls === 'number' && calls > 0 && typeof tokens === 'number' && tokens > 0) {
      return { calls, tokens };
    }
  }
  const config = readModelPortConfig(process.env);
  if (config !== undefined) {
    return { calls: config.maxScopeCalls, tokens: config.maxScopeTokens };
  }
  return { calls: 1, tokens: 1 };
}

/** 「继续」命令：额度耗尽时按可核对事实授予一个窗口，其余状态只是恢复推进。 */
export async function resumeGoalCommand(db: DbExecutor, input: {
  workspaceId: string; goalId: string; commandId: string;
}) {
  const repositories = createRepositories(db);
  const goal = await repositories.planGoals.readGoal(input.goalId);
  if (goal === undefined || goal.workspace_id !== input.workspaceId) {
    throw resourceNotFound('Assist goal');
  }
  const grant = goal.status === 'BUDGET_EXHAUSTED'
    ? await knownGrantForGoal(db, goal) : undefined;
  return resumeGoal(db, { workspaceId: input.workspaceId, goalId: input.goalId,
    commandId: input.commandId, grant });
}
