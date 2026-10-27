import { createHash, randomUUID } from 'node:crypto';

import type { AssistGoalRow, AssistMessageRow, AssistPlanRow } from '../infrastructure/database-schema.js';
import type { DbExecutor } from '../infrastructure/database.js';
import type { JsonObject } from '../infrastructure/json.js';
import { PlanGoalRepository } from '../assist/plan-goal-repository.js';
import { freezeAssistModelSnapshot } from './assist-model-snapshot.js';
import { goalStateForPrompt } from './assist-goals.js';
import { goalEnvelopeFromJson, goalEnvelopeToJson,
  type GoalEnvelope } from './plan-goal-envelope.js';
import { createRepositories, withTransaction, type Repositories } from './unit-of-work.js';

/**
 * 0127：目标的唯一推进 Owner（运行架构 §9）。
 *
 * 一次 tick 做三件有界的事，每一件都以「一条目标的一步」为单位：
 *   1. **落定控制意图**：暂停/取消先把在途轮次收干净，再显示已暂停/已取消；
 *   2. **结算已结束的轮次**：读回那条消息的结果，更新成功条件、步骤、状态与无进展计数；
 *   3. **组织下一轮**：没有在途轮次时投递一条新的目标轮次消息，交给既有的会话生成队列。
 *
 * 前两件各自用**阶段化候选**，不对全部未终结目标截一页：控制落定只看
 * `PAUSING/CANCELLING`，轮次结算只看「最新已结算消息尚无轮次账」的目标。否则历史
 * PAUSED/WAITING_USER 行会长期占满窗口，较新的控制意图与待记账轮次永远轮不到。
 *
 * 刻意**没有**「总轮次上限」：目标推进的停止条件只有四种——用户暂停/取消、真实阻塞、
 * 需要用户决定、额度耗尽。单轮模型请求的技术边界（轮次/工具调用上限）仍由会话轮次自己
 * 管，一轮用尽时这里只把「本轮没走完」记成一次无进展，下一轮继续；连续无进展才会
 * 变成「等你决定」，而不是偷偷把目标判成结束。
 *
 * 也没有第二个执行框架：目标轮次就是一条普通的 ASSISTANT 消息，由既有
 * `runAssistGenerationTick` 领取、按既有 CAS 结算，工具仍走 Gateway 准入。
 */

export interface GoalTickRound {
  readonly goalId: string;
  readonly messageId: string;
  readonly roundIndex: number;
}

export interface GoalTickResult {
  /* 结果数组本身可变（tick 内部追加），元素只读；对外仍是只读投影。 */
  readonly advanced: GoalTickRound[];
  readonly settled: { readonly goalId: string; readonly messageId: string;
    readonly outcome: string; readonly status: string }[];
  readonly controls: { readonly goalId: string;
    readonly status: AssistGoalRow['status'] }[];
  readonly skipped: { readonly goalId: string; readonly reason: string }[];
}

/** 连续多少轮没有可核对的进展后转为「等你决定」。这是等待阈值，不是总轮次上限。 */
const NO_PROGRESS_LIMIT = 3;
/** 连续多少次可重试的失败（限流/超时）后转为阻塞。 */
const FAILURE_LIMIT = 3;

const TERMINAL: readonly AssistGoalRow['status'][] = ['COMPLETED', 'CANCELLED', 'FAILED'];

function derivedUuid(seed: string): string {
  const hex = createHash('sha256').update(seed, 'utf8').digest('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-`
    + `${((parseInt(hex.slice(16, 17), 16) & 0x3) | 0x8).toString(16)}${hex.slice(17, 20)}-`
    + `${hex.slice(20, 32)}`;
}

/** 目标轮次消息的身份由「目标 + 第几轮」确定性派生：重扫不会长出第二条。 */
export function goalRoundMessageId(goalId: string, roundIndex: number): string {
  return derivedUuid(`relay:goal-round:${goalId}:${roundIndex}`);
}

// ---------------------------------------------------------------- 1. 控制落定

async function settleControls(db: DbExecutor, now: Date,
  result: GoalTickResult): Promise<void> {
  const repositories = createRepositories(db);
  // 只扫带控制意图的目标：静止的 PAUSED/WAITING_USER 再多也不占用这一阶段的窗口。
  const goals = await repositories.planGoals.listControlGoalsForTick(50);
  for (const goal of goals) {
    if (goal.status !== 'PAUSING' && goal.status !== 'CANCELLING') continue;
    const inflight = await repositories.planGoals.readInflightRoundMessage(goal.id);
    if (goal.status === 'CANCELLING' && inflight !== undefined) {
      // 取消只请求停止在途轮次；它已经产生的外部效果不会被撤销。
      await repositories.planGoals.markMessageCancelRequested(inflight.id);
      continue;
    }
    if (inflight !== undefined) continue;
    if (goal.status === 'CANCELLING') {
      // 终态会让 settleRounds 不再扫描这条目标。先让它把名下**所有**已结算轮次记账
      // （#143：不只最新一条），再由 settleRounds 在最后一条缺账消息的结算事务里归一为
      // CANCELLED，避免取消丢掉任何轮次事实。
      if ((await repositories.planGoals.listUnsettledRoundMessages(goal.id, 1)).length > 0) {
        continue;
      }
    }
    const next = goal.status === 'PAUSING' ? 'PAUSED' : 'CANCELLED';
    const updated = await repositories.planGoals.updateGoal(goal.id, goal.revision,
      { status: next, nextRoundAt: null,
        ...(next === 'PAUSED' ? { stopReason: {
          code: 'PAUSED_BY_USER', detail: '你暂停了目标；点「继续」会沿原目标接续。',
          questions: [], resumable: true } } : {}) });
    if (updated) result.controls.push({ goalId: goal.id, status: next });
  }
}

// ---------------------------------------------------------------- 2. 轮次结算

interface RoundDecision {
  readonly outcome: string;
  readonly note: string | null;
  readonly patch: Parameters<PlanGoalRepository['updateGoal']>[2];
}

/**
 * `assist_goals.criteria` / `steps` 存的就是 JSON 数组（迁移 0127 `DEFAULT '[]'::jsonb`，
 * 写入方 `updateGoal` 直接 `JSON.stringify(array)`）。按 `value.items` 取会把已冻结的
 * 成功条件与步骤读成空数组，推进器因此每轮都以为「目标还没有条件」而重新采用模型这一轮
 * 给的清单——「条件不因新版本改变」这条不变量就落不到事实上。
 */
function jsonArray(value: JsonObject): JsonObject[] {
  return (Array.isArray(value) ? value as unknown as readonly unknown[] : [])
    .filter((item): item is JsonObject =>
      typeof item === 'object' && item !== null && !Array.isArray(item));
}

function criterionList(goal: AssistGoalRow): JsonObject[] {
  return jsonArray(goal.criteria);
}

function stepList(goal: AssistGoalRow): JsonObject[] {
  return jsonArray(goal.steps);
}

function unmetRequired(criteria: readonly JsonObject[]): string[] {
  return criteria.filter((item) => item.required !== false && item.status !== 'MET')
    .map((item) => String(item.statement ?? ''));
}

/**
 * 把一次目标轮次的结果翻译成目标状态变更。
 *
 * 完成判定在这里，而且只认证据：所有**必需**成功条件都 `MET` 才进入「等待人工验收」；
 * 模型说完成但条件没满足（或还没有条件）时，目标继续推进并记一条具体缺口。
 */
function decideFromEnvelope(goal: AssistGoalRow, envelope: GoalEnvelope,
  now: Date): RoundDecision {
  const body = envelope.goal;
  if (body === null) {
    return { outcome: 'NO_STRUCTURE', note: '这一轮没有给出结构化进展，按正文继续下一轮。',
      patch: { progress: envelope.reply.slice(0, 2_000),
        noProgressRounds: goal.no_progress_rounds + 1,
        nextRoundAt: now,
        ...(goal.no_progress_rounds + 1 >= NO_PROGRESS_LIMIT ? {
          status: 'WAITING_USER' as const, nextRoundAt: null,
          stopReason: { code: 'NO_PROGRESS',
            detail: `连续 ${NO_PROGRESS_LIMIT} 轮没有可核对的进展，先停下来等你决定。`,
            questions: ['接下来希望它先做哪一步？或需要改变成功条件吗？'], resumable: true },
        } : {}) } };
  }

  // 成功条件：只接受「目标还没有条件」时的首次定义；之后的变化不覆盖已冻结的条件。
  const frozen = criterionList(goal);
  const criteria = frozen.length > 0 ? frozen
    : body.criteria.map((item): JsonObject => ({ key: item.key, statement: item.statement,
      status: 'PENDING', evidence: null, required: item.required, method: 'HUMAN' }));
  // 逐条报告只更新已冻结条目的状态，未知 key 一律忽略（模型不能凭空加条件）。
  const byKey = new Map(body.criteria_status.map((report) => [report.key, report]));
  let changed = false;
  const merged = criteria.map((item): JsonObject => {
    const report = byKey.get(String(item.key ?? ''));
    if (report === undefined) return item;
    if (item.status === report.status && item.evidence === report.evidence) return item;
    changed = true;
    return { ...item, status: report.status, evidence: report.evidence };
  });

  const steps = body.steps.length > 0
    ? body.steps.map((step): JsonObject => ({ title: step.title, status: step.status }))
    : stepList(goal);
  const stepsChanged = JSON.stringify(steps) !== JSON.stringify(stepList(goal));
  if (stepsChanged) changed = true;

  const noProgress = changed ? 0 : goal.no_progress_rounds + 1;
  const progress = body.progress ?? goal.progress;
  const currentStep = body.current_step ?? goal.current_step;

  if (body.state === 'COMPLETE') {
    const missing = unmetRequired(merged);
    if (frozen.length === 0 && merged.length === 0) {
      return { outcome: 'COMPLETE_UNVERIFIED',
        note: '模型声称完成，但目标还没有可核对的成功条件；先补上成功条件再判定完成。',
        patch: { criteria: merged, steps, currentStep, progress,
          noProgressRounds: noProgress, nextRoundAt: now,
          ...(noProgress >= NO_PROGRESS_LIMIT ? {
            status: 'WAITING_USER' as const, nextRoundAt: null,
            stopReason: { code: 'NO_CRITERIA',
              detail: '目标没有可核对的成功条件，无法判定完成。',
              questions: ['这件事怎样才算做完？请给出可核对的成功条件。'], resumable: true },
          } : {}) } };
    }
    if (missing.length > 0) {
      return { outcome: 'COMPLETE_UNVERIFIED',
        note: `模型声称完成，但这些必需条件还没有证据：${missing.slice(0, 5).join('；')}`,
        patch: { criteria: merged, steps, currentStep, progress,
          noProgressRounds: noProgress, nextRoundAt: now,
          ...(noProgress >= NO_PROGRESS_LIMIT ? {
            status: 'WAITING_USER' as const, nextRoundAt: null,
            stopReason: { code: 'NO_PROGRESS', detail: '多轮之后仍有必需条件没有证据。',
              questions: [missing.slice(0, 5).join('；')], resumable: true },
          } : {}) } };
    }
    // 全部必需条件有证据：进入等待人工验收。模型声明不直接写成 COMPLETED。
    return { outcome: 'AWAITING_ACCEPTANCE',
      note: '成功条件都已有证据；等待你确认完成。',
      patch: { status: 'AWAITING_ACCEPTANCE', criteria: merged, steps, currentStep, progress,
        noProgressRounds: 0, nextRoundAt: null,
        stopReason: { code: 'AWAITING_ACCEPTANCE',
          detail: '目标已按成功条件完成自检，需要你确认后才会记作完成。',
          questions: [], resumable: false } } };
  }

  if (body.state === 'NEEDS_USER') {
    const questions = body.questions.length > 0 ? body.questions
      : ['需要你决定下一步；补充说明后点「继续」。'];
    return { outcome: 'NEEDS_USER', note: questions.join('；'),
      patch: { criteria: merged, steps, currentStep, progress, noProgressRounds: 0,
        nextRoundAt: null, status: 'WAITING_USER',
        stopReason: { code: 'NEEDS_USER',
          detail: body.blocked_reason ?? '目标遇到需要你决定的事，先停下来问你。',
          questions, resumable: true } } };
  }

  if (body.state === 'BLOCKED') {
    return { outcome: 'BLOCKED',
      note: body.blocked_reason ?? '目标报告真实阻塞。',
      patch: { criteria: merged, steps, currentStep, progress, noProgressRounds: 0,
        nextRoundAt: null, status: 'BLOCKED',
        stopReason: { code: 'BLOCKED',
          detail: body.blocked_reason ?? '目标报告真实阻塞，无法自行继续。',
          questions: body.questions, resumable: true } } };
  }

  return { outcome: 'CONTINUE',
    note: body.adjustment ?? (changed ? '本轮有进展。' : '本轮没有可核对的进展。'),
    patch: { criteria: merged, steps, currentStep, progress, noProgressRounds: noProgress,
      nextRoundAt: now,
      ...(noProgress >= NO_PROGRESS_LIMIT ? {
        status: 'WAITING_USER' as const, nextRoundAt: null,
        stopReason: { code: 'NO_PROGRESS',
          detail: `连续 ${NO_PROGRESS_LIMIT} 轮没有可核对的进展，先停下来等你决定。`,
          questions: ['接下来希望它先做哪一步？或需要改变成功条件吗？'], resumable: true },
      } : {}) } };
}

function budgetStop(goal: AssistGoalRow): RoundDecision {
  return { outcome: 'BUDGET_EXHAUSTED',
    note: '本次会话可用的模型调用额度已用尽；进度已保存。',
    patch: { status: 'BUDGET_EXHAUSTED', nextRoundAt: null, lastRoundMessageId: null,
      stopReason: { code: 'MODEL_BUDGET_EXHAUSTED',
        detail: '这段会话可用的模型调用/用量额度已经用尽。进度已保存；'
          + '额度恢复后点「继续」会沿原目标接续，不会自动重跑。',
        questions: [], resumable: true } } };
}

function decideFromMessage(goal: AssistGoalRow, message: AssistMessageRow,
  now: Date): RoundDecision {
  if (message.status === 'CANCELLED') {
    return { outcome: 'CANCELLED_ROUND',
      note: '这一轮被停止；目标没有继续推进。',
      patch: { noProgressRounds: goal.no_progress_rounds + 1, nextRoundAt: null,
        status: 'PAUSED',
        stopReason: { code: 'ROUND_CANCELLED',
          detail: '这一轮生成被停止。目标保持暂停，点「继续」可以接着做。',
          questions: [], resumable: true } } };
  }
  if (message.status === 'FAILED') {
    if (message.error_code === 'MODEL_BUDGET_EXHAUSTED') return budgetStop(goal);
    const rateLimited = message.provider_error_kind === 'RATE_LIMIT'
      || message.provider_error_kind === 'TIMEOUT' || message.provider_error_kind === 'NETWORK';
    const failures = goal.no_progress_rounds + 1;
    // 限流/超时/网络是**暂时**故障，不是账户额度：给下一轮留一点退避，不宣称额度耗尽。
    const detail = rateLimited
      ? `模型服务这次没成功（${message.provider_error_kind ?? 'UNKNOWN'}）。`
        + '这属于暂时性失败，不是账户额度耗尽。'
      : `这一轮执行失败（${message.error_code ?? 'UNKNOWN'}）。`;
    if (!rateLimited || failures >= FAILURE_LIMIT) {
      return { outcome: 'BLOCKED',
        note: detail,
        patch: { noProgressRounds: failures, nextRoundAt: null, status: 'BLOCKED',
          stopReason: { code: rateLimited ? 'PROVIDER_UNAVAILABLE' : 'ROUND_FAILED',
            detail, questions: [], resumable: true } } };
    }
    return { outcome: 'RETRY_SCHEDULED', note: detail,
      patch: { noProgressRounds: failures,
        nextRoundAt: new Date(now.getTime() + 30_000) } };
  }
  return decideFromEnvelope(goal, goalEnvelopeFromJson(message.goal_outcome), now);
}

/** 控制意图（暂停/取消）未落定前，轮次结算只记事实，不能改写用户的选择。 */
function controlFactPatch(patch: RoundDecision['patch']): RoundDecision['patch'] {
  return {
    ...(patch.criteria === undefined ? {} : { criteria: patch.criteria }),
    ...(patch.steps === undefined ? {} : { steps: patch.steps }),
    ...(patch.currentStep === undefined ? {} : { currentStep: patch.currentStep }),
    ...(patch.progress === undefined ? {} : { progress: patch.progress }),
    ...(patch.noProgressRounds === undefined ? {} : { noProgressRounds: patch.noProgressRounds }),
    nextRoundAt: null,
  };
}

async function settleRounds(db: DbExecutor, now: Date, result: GoalTickResult): Promise<void> {
  const repositories = createRepositories(db);
  // 按「名下还有已终结消息没记账」筛选，而不是按状态截一页：否则静止目标会饿死轮次结算。
  // #143：候选判定是「任一条缺账」——最新消息先记账不能把更早的缺账消息挤出候选集。
  const goals = await repositories.planGoals.listGoalsWithUnsettledRounds(50);
  for (const goal of goals) {
    if (TERMINAL.includes(goal.status)) continue;
    // #143：按目标消息**原始顺序**有界结算所有未记账的终结消息。早到的回复先记自己的
    // 轮次与条件冻结，晚到的补充再在已冻结条件上重放；一轮结算不完的余量（每目标 50 条）
    // 留给下一个 tick，候选查询仍按「缺账」捞到它们，不饥饿也不双记。
    const backlog = await repositories.planGoals.listUnsettledRoundMessages(goal.id, 50);
    for (const message of backlog) {
      // 判定与落库放进**锁定目标行**的同一短事务：并发 tick/恢复先在这里排队，读到的一定
      // 是前一次结算提交后的状态——round_count、条件冻结与取消归一都不会基于旧快照重放；
      // 消息已被他方记账时跳过这条继续下一条，重复记账与漏账都进不了账本。
      const applied = await withTransaction(db, async (tx): Promise<
        'STOP' | 'SKIP' | { readonly status: AssistGoalRow['status']; readonly outcome: string }
      > => {
        const fresh = await tx.planGoals.readGoal(goal.id, true);
        if (fresh === undefined || TERMINAL.includes(fresh.status)) return 'STOP';
        if (await tx.planGoals.readRoundByMessage(message.id) !== undefined) return 'SKIP';
        const controlIntent = fresh.status === 'PAUSING' || fresh.status === 'PAUSED'
          || fresh.status === 'CANCELLING';
        const decision = decideFromMessage(fresh, message, now);
        const roundIndex = fresh.round_count + 1;
        let patch = controlIntent ? controlFactPatch(decision.patch) : decision.patch;
        let status = controlIntent ? fresh.status : (decision.patch.status ?? fresh.status);
        if (fresh.status === 'CANCELLING'
          && await tx.planGoals.readInflightRoundMessage(fresh.id) === undefined) {
          // 取消归一只放在**最后一条**缺账消息的结算事务里：同事务内重查缺账集合，
          // 还有更早积压未记账时保持 CANCELLING，不让控制落定先于事实终结（#143）。
          const remaining = await tx.planGoals.listUnsettledRoundMessages(fresh.id, 2);
          if (remaining.length === 1 && remaining[0]!.id === message.id) {
            patch = { ...patch, status: 'CANCELLED' };
            status = 'CANCELLED';
          }
        }
        const updated = await tx.planGoals.updateGoal(fresh.id, fresh.revision, {
          ...patch, roundCount: roundIndex, lastRoundMessageId: message.id });
        if (!updated) return 'STOP';
        await tx.planGoals.insertRound({ id: randomUUID(), goalId: fresh.id,
          messageId: message.id, roundIndex, outcome: decision.outcome, note: decision.note,
          criteriaSnapshot: (decision.patch.criteria ?? criterionList(fresh)) as readonly JsonObject[] });
        return { status, outcome: decision.outcome };
      });
      // CAS 竞争（并发已推进/目标已终结）：停止本目标这一批，下一个 tick 重扫补齐。
      if (applied === 'STOP') break;
      if (applied === 'SKIP') continue;
      result.settled.push({ goalId: goal.id, messageId: message.id,
        outcome: applied.outcome, status: applied.status });
    }
  }
}

// ---------------------------------------------------------------- 3. 组织下一轮

async function enqueueRound(db: DbExecutor, repositories: Repositories, goal: AssistGoalRow,
  roundIndex: number): Promise<string | undefined> {
  const session = await repositories.assist.readSession(goal.session_id);
  if (session === undefined || session.status !== 'ACTIVE') return undefined;
  const messageId = goalRoundMessageId(goal.id, roundIndex);
  const existing = await repositories.assist.readMessage(messageId);
  if (existing !== undefined) return existing.id;
  const selection = await repositories.modelSelection.readForSession(session.id);
  const snapshot = await freezeAssistModelSnapshot(repositories, selection, process.env,
    { requiresTools: true, requiresJsonOutput: true }, session.workspace_id);
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const seq = await repositories.assist.nextMessageSeq(session.id);
    try {
      await repositories.assist.insertMessage({ id: messageId, sessionId: session.id,
        seq, role: 'ASSISTANT', status: 'PENDING', intent: 'DISCUSS', content: null,
        sources: [], chatMode: 'GOAL', goalId: goal.id,
        ...(snapshot === undefined ? {} : { modelSelectionSnapshot: snapshot.snapshot,
          modelAttemptState: snapshot.attemptState,
          modelCredentialFingerprint: snapshot.credentialFingerprint }) });
      break;
    } catch (error) {
      // (session_id, seq) 竞争：用户恰好同时发了一条消息。重算序号再来一次。
      if (attempt === 1) throw error;
    }
  }
  return messageId;
}

async function advanceGoals(db: DbExecutor, options: {
  workerId: string; now: Date; leaseMs: number; result: GoalTickResult;
}): Promise<void> {
  const { result } = options;
  const repositories = createRepositories(db);
  const candidates = await repositories.planGoals.listAdvanceCandidates(options.now, 10);
  for (const goal of candidates) {
    if (goal.status !== 'ACTIVE') continue;
    if (await repositories.planGoals.readInflightRoundMessage(goal.id) !== undefined) {
      result.skipped.push({ goalId: goal.id, reason: 'INFLIGHT_ROUND' });
      continue;
    }
    // #143：名下还有已终结但未记账的消息（本 tick 结算窗口外或 CAS 竞争遗留）时，
    // 下一轮不能基于不完整的目标状态投递——先把积压按原始顺序记完账再推进。
    if ((await repositories.planGoals.listUnsettledRoundMessages(goal.id, 1)).length > 0) {
      result.skipped.push({ goalId: goal.id, reason: 'UNSETTLED_BACKLOG' });
      continue;
    }
    // 先拿租约：同一目标同一时刻只有一个 tick 能组织下一轮。
    const claimed = await repositories.planGoals.updateGoal(goal.id, goal.revision, {
      leaseOwner: options.workerId,
      leaseExpiresAt: new Date(options.now.getTime() + options.leaseMs),
    });
    if (!claimed) { result.skipped.push({ goalId: goal.id, reason: 'LEASE_RACE' }); continue; }
    const fresh = await repositories.planGoals.readGoal(goal.id);
    if (fresh === undefined) continue;
    const roundIndex = fresh.round_count + 1;
    let messageId: string | undefined;
    try {
      messageId = await enqueueRound(db, repositories, fresh, roundIndex);
    } catch (error) {
      const detail = error instanceof Error && error.message === 'ASSIST_MODEL_CONFIG_CHANGED'
        ? '当前模型连接与会话冻结的模型选择不一致；请在会话里重新选择模型后点「继续」。'
        : `组织下一轮失败：${error instanceof Error ? error.message : String(error)}`;
      await repositories.planGoals.updateGoal(fresh.id, fresh.revision, {
        status: 'WAITING_USER', nextRoundAt: null, leaseOwner: null, leaseExpiresAt: null,
        stopReason: { code: 'ROUND_SETUP_FAILED', detail, questions: [], resumable: true },
      });
      result.skipped.push({ goalId: goal.id, reason: 'ROUND_SETUP_FAILED' });
      continue;
    }
    if (messageId === undefined) {
      await repositories.planGoals.updateGoal(fresh.id, fresh.revision, {
        leaseOwner: null, leaseExpiresAt: null, nextRoundAt: null, status: 'PAUSED',
        stopReason: { code: 'SESSION_NOT_ACTIVE',
          detail: '会话已归档，目标无法继续。', questions: [], resumable: false } });
      result.skipped.push({ goalId: goal.id, reason: 'SESSION_NOT_ACTIVE' });
      continue;
    }
    await repositories.planGoals.updateGoal(fresh.id, fresh.revision, {
      nextRoundAt: null, leaseOwner: null, leaseExpiresAt: null });
    result.advanced.push({ goalId: goal.id, messageId, roundIndex });
  }
}

/**
 * 目标推进的一次有界 tick。
 *
 * 三个阶段的顺序是刻意的：先按用户意图收口（暂停/取消），再结算已结束的轮次，
 * 最后才可能投递下一轮。顺序反过来会出现「用户刚点暂停，下一轮已经发出去了」。
 */
export async function runAssistGoalTick(db: DbExecutor, options: {
  workerId: string;
  now?: Date;
  leaseMs?: number;
}): Promise<GoalTickResult> {
  const now = options.now ?? new Date();
  const leaseMs = options.leaseMs ?? 120_000;
  const result: GoalTickResult = { advanced: [], settled: [], controls: [], skipped: [] };
  await settleControls(db, now, result);
  await settleRounds(db, now, result);
  await advanceGoals(db, { workerId: options.workerId, now, leaseMs, result });
  return result;
}

/** 目标轮次提示词需要的那段状态（纯数据，不含能力）。`plan` 必须是目标绑定的那一版。 */
export function goalRoundState(goal: AssistGoalRow,
  plan: AssistPlanRow | null | undefined): JsonObject {
  return goalStateForPrompt(goal, plan);
}
