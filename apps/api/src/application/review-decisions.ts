import { randomUUID } from 'node:crypto';

import type { DbExecutor } from '../infrastructure/database.js';
import type { CheckResultRow, ImportJobRow, LogicalOperationRow, ProjectStateRow, ReviewDecision, ReviewRequestRow, RunRow, TaskRow, VerificationSessionRow } from '../infrastructure/database-schema.js';
import type { JsonObject } from '../infrastructure/json.js';
import { toDecimalString } from '../shared/decimal.js';
import { buildCheckPlan, planFromFrozenSnapshot } from '../workflow/check-plan.js';
import { readMockActionOperationId } from '../workflow/execution-contract.js';
import { computeVerdict, DEFAULT_CORRECTION_BUDGET } from '../workflow/verdict.js';
import { LOCAL_ACTOR_REF, httpCommandScopeKey } from './actor.js';
import { runIdempotentCommand, type CommandOutcome } from './command.js';
import { invalidTransition, resourceNotFound, revisionConflict, validationFailed } from './domain-error.js';
import { requireRevision } from './revisions.js';
import { reviewTargetHash } from './review-requests.js';
import { normalizeStateAction, type NormalizedStateAction } from './state-action.js';
import { applyAction } from './state-commands.js';
import { lockWritableProjectInWorkspace } from './guards.js';
import type { Repositories } from './unit-of-work.js';

export interface ResolveReviewInput {
  readonly workspaceId: string;
  readonly reviewId: string;
  readonly commandId: string;
  readonly expectedRevision: string;
  readonly targetHash: string;
  readonly decision: ReviewDecision;
  readonly feedback?: string | null;
  readonly retryBudget?: number | null;
}

export type ResolveReviewResult = {
  readonly review_id: string;
  readonly decision_id: string;
  readonly decision: ReviewDecision;
  readonly effect: JsonObject;
  readonly revision: string;
};

/** Review 决定和业务效果使用同一个短事务与命令回执。 */
export async function resolveReview(db: DbExecutor, input: ResolveReviewInput): Promise<CommandOutcome<ResolveReviewResult>> {
  const expectedRevision = requireRevision(input.expectedRevision, 'expected_revision');
  if (!/^[0-9a-f]{64}$/u.test(input.targetHash)) throw validationFailed([{ field: 'target_hash', message: 'must be a lowercase SHA-256 hex digest' }]);
  const feedback = input.feedback?.trim() || null;
  const retryBudget = input.retryBudget ?? null;
  if (retryBudget !== null && (!Number.isInteger(retryBudget) || retryBudget < 1 || retryBudget > 6)) {
    throw validationFailed([{ field: 'retry_budget', message: 'must be an integer from 1 to 6' }]);
  }
  if (input.decision === 'SET_RETRY_BUDGET' && retryBudget === null) {
    throw validationFailed([{ field: 'retry_budget', message: 'is required for SET_RETRY_BUDGET' }]);
  }
  if (input.decision !== 'SET_RETRY_BUDGET' && retryBudget !== null) {
    throw validationFailed([{ field: 'retry_budget', message: 'is only valid for SET_RETRY_BUDGET' }]);
  }

  return runIdempotentCommand<ResolveReviewResult>(db, {
    scopeKey: httpCommandScopeKey(input.workspaceId),
    commandId: input.commandId,
    commandType: 'ResolveReview',
    target: { review_id: input.reviewId },
    body: { expected_revision: toDecimalString(expectedRevision), target_hash: input.targetHash, decision: input.decision, feedback, retry_budget: retryBudget },
    execute: async (repositories) => {
      // 先读不可变定位字段，再按 Task → Run → Review 或 Task → ProjectState → Review 锁序加锁。
      const located = await repositories.reviews.readRequest(input.reviewId);
      if (located === undefined || located.workspace_id !== input.workspaceId) throw resourceNotFound('Review');
      let run: RunRow | undefined;
      let task: TaskRow | undefined;
      let stateTarget: LockedStateReviewTarget | undefined;
      let importTarget: { readonly job: ImportJobRow; readonly operation: LogicalOperationRow } | undefined;
      if (located.run_id !== null) {
        task = located.task_id === null ? undefined : await repositories.tasks.lockTask(located.task_id);
        if (task === undefined || task.workspace_id !== input.workspaceId) throw resourceNotFound('Task');
        run = await repositories.runs.lockRun(located.run_id);
        if (run === undefined || run.workspace_id !== input.workspaceId || run.task_id !== task.id) throw resourceNotFound('Run');
      } else if (located.kind === 'STATE_PROPOSAL') {
        stateTarget = await lockStateReviewTarget(repositories, located);
      } else if (located.kind === 'ACTION_APPROVAL' && located.operation_id !== null) {
        const operation = await repositories.gateway.readOperation(located.operation_id);
        if (operation?.origin !== 'USER_IMPORT' || operation.import_job_id === null ||
            operation.workspace_id !== input.workspaceId) throw invalidTransition('Review 没有可处理的用户导入操作。');
        const job = await repositories.gateway.lockImportJob(operation.import_job_id);
        if (job?.workspace_id !== input.workspaceId || job.project_id !== operation.project_id) {
          throw resourceNotFound('Import job');
        }
        importTarget = { job, operation };
      }

      if (located.project_id !== null) {
        await lockWritableProjectInWorkspace(repositories, input.workspaceId, located.project_id);
      }
      const review = await repositories.reviews.lockRequest(input.reviewId);
      if (review === undefined || review.workspace_id !== input.workspaceId) throw resourceNotFound('Review');
      if (stateTarget !== undefined && (review.project_id !== located.project_id || !review.target_hash.equals(located.target_hash))) {
        throw invalidTransition('State 提案的锁定目标已变化。');
      }
      if (review.revision !== expectedRevision) throw revisionConflict({ entityType: 'REVIEW', expectedRevision: toDecimalString(expectedRevision), actualRevision: toDecimalString(review.revision) });
      if (review.status !== 'OPEN') throw invalidTransition('该 Review 已有决定或已过期。');
      if (review.expires_at !== null && review.expires_at.getTime() <= Date.now()) throw invalidTransition('该 Review 已过有效期，请重新发起。');
      if (review.target_hash.toString('hex') !== input.targetHash || !reviewTargetHash(review.target).equals(review.target_hash)) throw invalidTransition('Review 目标摘要不匹配，不能应用决定。');
      if (!review.allowed_decisions.includes(input.decision)) throw validationFailed([{ field: 'decision', message: `not allowed for ${review.kind}` }]);

      const decisionId = randomUUID();
      const effect = run !== undefined && task !== undefined
        ? await resolveRunReview(repositories, { review, run, task, decision: input.decision, decisionId, retryBudget, feedback })
        : importTarget !== undefined
          ? await resolveImportActionReview(repositories, review, importTarget, input.decision)
        : await resolveStateReview(repositories, review, input.decision, stateTarget);

      if (run !== undefined && task?.status === 'WAITING' &&
          !(review.kind === 'ACTION_APPROVAL' && input.decision === 'DENY')) {
        const currentRun = await repositories.runs.readRun(run.id);
        if (currentRun !== undefined && currentRun.status !== 'WAITING_APPROVAL' && currentRun.status !== 'PAUSED') {
          const active = await repositories.tasks.applyTaskStatus({ taskId: task.id,
            expectedRevision: task.revision, fromStatus: 'WAITING', toStatus: 'IN_PROGRESS' });
          if (active === undefined) throw new Error('Review Task wake CAS failed');
        }
      }

      const decided = await repositories.reviews.decideRequest(review.id, expectedRevision);
      if (decided === undefined) throw new Error('Review CAS failed while holding review lock');
      await repositories.reviews.insertDecision({
        id: decisionId, reviewId: review.id, commandId: input.commandId, decision: input.decision,
        feedback, retryBudget: retryBudget === null ? null : BigInt(retryBudget),
        targetHash: review.target_hash, effect,
      });
      if (run !== undefined) {
        const current = await repositories.runs.readRun(run.id);
        if (current === undefined) throw new Error('reviewed Run disappeared');
        const frozen = review.kind === 'ACTION_APPROVAL'
          ? await repositories.runs.readContract(run.id) : undefined;
        const frozenActionOperationId = frozen === undefined ? undefined :
          readMockActionOperationId(frozen.frozen_snapshot);
        const actionApproved = review.kind === 'ACTION_APPROVAL' && input.decision === 'APPROVE' &&
          frozenActionOperationId === review.operation_id;
        const runnable = run.status === 'WAITING_APPROVAL' &&
          !['WAITING_APPROVAL', 'PAUSED', 'COMPLETED', 'FAILED', 'CANCELLED'].includes(current.status);
        if (actionApproved || runnable) {
          await repositories.dispatch.insertCommand({
            id: randomUUID(), workspaceId: run.workspace_id, runId: run.id,
            sourceCommandId: input.commandId, kind: 'RESUME', reviewDecisionId: decisionId,
          });
        }
      }
      await repositories.activities.insertActivityRecord({
        id: randomUUID(), actorKind: 'HUMAN', actorRef: LOCAL_ACTOR_REF, commandId: input.commandId,
        workspaceId: review.workspace_id, runId: review.run_id,
        projectId: review.project_id, taskId: review.task_id, eventType: 'REVIEW_DECIDED',
        factRefs: { review_id: review.id, decision_id: decisionId, decision: input.decision, effect },
      });
      return { review_id: review.id, decision_id: decisionId, decision: input.decision, effect, revision: toDecimalString(decided.revision) };
    },
  });
}

async function resolveImportActionReview(repositories: Repositories, review: ReviewRequestRow,
  target: { readonly job: ImportJobRow; readonly operation: LogicalOperationRow },
  decision: ReviewDecision): Promise<JsonObject> {
  const op = await repositories.gateway.lockOperation(target.operation.id);
  if (op?.origin !== 'USER_IMPORT' || op.status !== 'WAITING_APPROVAL' ||
      op.import_job_id !== target.job.id || review.operation_id !== op.id ||
      review.target.operation_id !== op.id || review.target.import_job_id !== target.job.id ||
      review.target.normalized_target !== op.normalized_target ||
      review.target.params_hash !== op.params_hash.toString('hex') ||
      review.target.connection_id !== op.connection_id ||
      review.target.connection_version !== op.connection_version.toString() ||
      review.target.policy_id !== op.policy_id ||
      review.target.policy_version !== op.policy_version.toString()) {
    throw invalidTransition('用户导入 Review 的动作绑定已失效。');
  }
  if (target.job.status !== 'QUEUED' && target.job.status !== 'RUNNING') {
    throw invalidTransition('用户导入已离开排队或执行状态。');
  }
  if (decision !== 'APPROVE' && decision !== 'DENY') throw invalidTransition('操作批准只接受 APPROVE 或 DENY。');
  if (decision === 'DENY') {
    await repositories.gateway.setOperationStatus(op.id, 'DENIED', { reason: 'HUMAN_DENIED' });
    await repositories.gateway.setImportJobStatus(target.job.id, 'FAILED', 'HUMAN_DENIED');
  }
  return { action_authorized: decision === 'APPROVE', operation_id: op.id, external_effect_executed: false };
}

async function resolveRunReview(repositories: Repositories, input: {
  readonly review: ReviewRequestRow;
  readonly run: RunRow;
  readonly task: TaskRow;
  readonly decision: ReviewDecision;
  readonly decisionId: string;
  readonly retryBudget: number | null;
  readonly feedback: string | null;
}): Promise<JsonObject> {
  const { review, run, task, decision, decisionId } = input;
  if (task.executor_kind !== 'AI' || task.executor_run_id !== run.id || task.ownership_epoch !== run.ownership_epoch || run.status === 'COMPLETED' || run.status === 'FAILED' || run.status === 'CANCELLED') {
    throw invalidTransition('Review 的 Run 已不再持有该 Task 的执行权。', { taskId: task.id });
  }
  const contract = await repositories.runs.readContract(run.id);
  if (contract === undefined || contract.acceptance_revision !== task.acceptance_revision) throw invalidTransition('Review 的验收契约已变化。', { taskId: task.id });
  const target = review.target;
  if (target.acceptance_revision !== toDecimalString(task.acceptance_revision) || target.run_id !== run.id) throw invalidTransition('Review 的绑定目标已变化。');

  if (review.kind === 'ACTION_APPROVAL') {
    if (run.status !== 'WAITING_APPROVAL' || target.operation_id !== review.operation_id) throw invalidTransition('操作审批的原 Run 或操作身份已失效。');
    if (decision !== 'APPROVE' && decision !== 'DENY') throw invalidTransition('操作批准只接受 APPROVE 或 DENY。');
    const frozenActionOperationId = readMockActionOperationId(contract.frozen_snapshot);
    if (frozenActionOperationId !== undefined && frozenActionOperationId !== review.operation_id) {
      throw invalidTransition('操作审批与冻结的 Mock 动作身份不匹配。');
    }
    // P07's generic Review port can reserve an operation ID before Gateway has
    // created a row. Only the required fixed Mock action has terminal DENY semantics.
    const operation = frozenActionOperationId === undefined || review.operation_id === null ? undefined :
      await repositories.gateway.lockOperation(review.operation_id);
    if (frozenActionOperationId !== undefined && (operation?.run_id !== run.id ||
        operation.status !== 'WAITING_APPROVAL' || operation.id !== target.operation_id)) {
      throw invalidTransition('操作审批的原动作已失效。');
    }
    if (decision === 'DENY' && operation !== undefined) {
      await repositories.gateway.setOperationStatus(operation.id, 'DENIED', { reason: 'HUMAN_DENIED' });
      const failed = await repositories.runs.advanceRun({ runId: run.id, expectedRevision: run.revision,
        status: 'FAILED', currentStepId: run.current_step_id,
        waitReason: 'ACTION_APPROVAL_DENIED', terminal: true });
      if (failed === undefined) throw new Error('denied Gateway Run CAS failed');
      const released = await repositories.tasks.releaseExecutionFromRun({
        taskId: task.id, runId: run.id, expectedRevision: task.revision, toStatus: 'READY',
      });
      if (released === undefined) throw new Error('denied Gateway Task release CAS failed');
      await repositories.activities.insertActivityRecord({ id: randomUUID(), actorKind: 'SYSTEM',
        workspaceId: run.workspace_id, runId: run.id,
        actorRef: `run:${run.id}`, commandId: null, projectId: task.project_id,
        taskId: task.id, eventType: 'RUN_FAILED',
        factRefs: { run_id: run.id, operation_id: operation.id, reason: 'ACTION_APPROVAL_DENIED' } });
    }
    return { action_authorized: decision === 'APPROVE', operation_id: review.operation_id, external_effect_executed: false };
  }
  if (review.kind !== 'CRITERION' && review.kind !== 'RETRY_BUDGET' && review.kind !== 'CHECKER_RETRY') throw invalidTransition('Review 类型与 Run 不匹配。');
  if (run.status !== 'WAITING_APPROVAL') throw invalidTransition('Run 不在等待人工判断状态。');
  const persist = await repositories.runs.readStepByKind(run.id, 'PERSIST_CANDIDATE');
  const versionId = persist?.result_ref?.artifact_version_id;
  if (typeof versionId !== 'string' || versionId !== target.artifact_version_id) throw invalidTransition('当前候选版本已变化；旧 Review 不适用于新版本。');
  const version = await repositories.artifacts.readArtifactVersion(versionId);
  if (version === undefined || version.content_hash.toString('hex') !== target.content_hash) throw invalidTransition('Review 绑定的产物内容摘要已变化。');
  const sessions = await repositories.verifications.listSessionsByRun(run.id);
  const latest = sessions.at(-1);
  if (latest === undefined || latest.status !== 'HUMAN') throw invalidTransition('当前验证已不再等待人工判断。');
  const latestTargets = await repositories.verifications.listTargets(latest.id);
  if (!latestTargets.some((row) => row.artifact_version_id === versionId && row.content_hash.equals(version.content_hash))) throw invalidTransition('最新验证不再针对 Review 的产物版本。');
  const budget = (await repositories.reviews.readCorrectionBudget(run.id))?.max_corrections ?? DEFAULT_CORRECTION_BUDGET;
  const used = BigInt(sessions.filter((session) => session.status === 'RETRY').length);

  if (review.kind === 'CRITERION' && decision === 'ACCEPT') {
    const criterionId = review.criterion_id;
    if (criterionId === null || target.criterion_id !== criterionId) throw invalidTransition('人工判断缺少确切 criterion。');
    const prior = await repositories.verifications.listLatestCheckResults(latest.id);
    const old = prior.find((row) => row.criterion_id === criterionId);
    if (old === undefined || old.result === 'FAIL' || old.result === 'ERROR' || old.severity === 'PREFERENCE') throw invalidTransition('该条件不能用人工 ACCEPT 覆盖失败或检查器错误。');
    if (old.result !== 'NOT_RUN' && old.result !== 'UNCERTAIN') throw invalidTransition('该条件已经有确定检查结果。');
    const successor = await cloneSession(repositories, latest, prior, { criterionId, decisionId });
    const results = await repositories.verifications.listLatestCheckResults(successor.id);
    const plan = buildCheckPlan(planFromFrozenSnapshot(contract.frozen_snapshot));
    const verdict = computeVerdict({ plan, latestResults: results, correctionBudgetUsed: used, correctionBudget: budget });
    if (verdict.decision !== 'PASS' && verdict.decision !== 'HUMAN') throw invalidTransition('人工判断后仍有必须修正的失败，不能完成。');
    await finalizeSuccessor(repositories, successor, verdict.decision, used);
    if (verdict.decision === 'PASS') await transitionRun(repositories, run, 'VERIFYING', null);
    return { verification_session_id: successor.id, verdict: verdict.decision, accepted_criterion_id: criterionId, run_status: verdict.decision === 'PASS' ? 'VERIFYING' : 'WAITING_APPROVAL' };
  }

  if (review.kind === 'CHECKER_RETRY' && decision === 'RETRY_CHECKS') {
    const verify = await repositories.runs.readStepByKind(run.id, 'VERIFY');
    if (verify === undefined || verify.status !== 'SUCCEEDED') throw invalidTransition('VERIFY 步骤不能重新检查。');
    await resetStep(repositories, verify.id, verify.revision);
    await transitionRun(repositories, run, 'VERIFYING', null);
    return { check_retry_scheduled: true, artifact_version_id: versionId, external_effect_executed: false };
  }

  if (review.kind === 'RETRY_BUDGET' && decision === 'SET_RETRY_BUDGET') {
    const requested = BigInt(input.retryBudget ?? 0);
    if (requested <= budget || requested <= used || requested > 6n) throw validationFailed([{ field: 'retry_budget', message: 'must increase the current limit and remain at most 6' }]);
    await repositories.reviews.setCorrectionBudget(run.id, requested);
    const successor = await cloneSession(repositories, latest, await repositories.verifications.listLatestCheckResults(latest.id));
    await finalizeSuccessor(repositories, successor, 'RETRY', used + 1n);
    await scheduleCorrection(repositories, run);
    await repositories.reviews.expireOpenForRun(run.id, review.id);
    return { correction_budget: toDecimalString(requested), correction_round: toDecimalString(used + 1n), verification_session_id: successor.id, run_status: 'RETRYING' };
  }

  if (review.kind === 'CRITERION' && decision === 'REQUEST_CHANGES') {
    if (used >= budget) throw invalidTransition('修正预算已耗尽，须先增加预算。');
    const successor = await cloneSession(repositories, latest, await repositories.verifications.listLatestCheckResults(latest.id), {
      criterionId: review.criterion_id ?? '', decisionId, requestChangesReason: input.feedback ?? '用户要求修改此项产物。',
    });
    await finalizeSuccessor(repositories, successor, 'RETRY', used + 1n);
    await scheduleCorrection(repositories, run);
    await repositories.reviews.expireOpenForRun(run.id, review.id);
    return { correction_round: toDecimalString(used + 1n), verification_session_id: successor.id, run_status: 'RETRYING' };
  }
  throw invalidTransition('该决定不适用于此 Review。');
}

async function cloneSession(repositories: Repositories, source: VerificationSessionRow, results: readonly CheckResultRow[], human?: { readonly criterionId: string; readonly decisionId: string; readonly requestChangesReason?: string }): Promise<VerificationSessionRow> {
  const successor = await repositories.verifications.insertSession({
    id: randomUUID(), taskId: source.task_id, acceptanceRevision: source.acceptance_revision,
    runId: source.run_id, executionContractId: source.execution_contract_id,
    verifierPolicyVersion: source.verifier_policy_version, checkPlanHash: source.check_plan_hash,
    checkPlan: source.check_plan, correctionBudgetUsed: source.correction_budget_used,
    parentSessionId: source.id,
  });
  for (const target of await repositories.verifications.listTargets(source.id)) {
    await repositories.verifications.insertTarget({ sessionId: successor.id, artifactVersionId: target.artifact_version_id, contentHash: target.content_hash });
  }
  for (const row of results) {
    const accepted = human?.criterionId === row.criterion_id;
    const requestedChanges = accepted && human?.requestChangesReason !== undefined;
    await repositories.verifications.insertCheckResult({
      id: randomUUID(), sessionId: successor.id, criterionId: row.criterion_id, checkAttempt: 1,
      checkerId: accepted ? 'human-review-v1' : row.checker_id,
      checkerVersion: accepted ? '1' : row.checker_version,
      result: requestedChanges ? 'FAIL' : accepted ? 'PASS' : row.result, required: row.required, severity: row.severity,
      evidenceRefs: accepted
        ? { review_decision_id: human.decisionId, source_result_id: row.id, artifact_version_id: (await repositories.verifications.listTargets(source.id))[0]?.artifact_version_id ?? '', ...(requestedChanges ? { reason: human.requestChangesReason } : {}) }
        : { ...row.evidence_refs, source_result_id: row.id },
    });
  }
  return successor;
}

async function finalizeSuccessor(repositories: Repositories, session: VerificationSessionRow, status: 'PASS' | 'RETRY' | 'HUMAN', used: bigint): Promise<void> {
  const finalized = await repositories.verifications.finalizeSession({ sessionId: session.id, expectedRevision: session.revision, status, correctionBudgetUsed: used });
  if (finalized === undefined) throw new Error('Review successor session finalize failed');
}

async function scheduleCorrection(repositories: Repositories, run: RunRow): Promise<void> {
  const steps = await repositories.runs.listSteps(run.id);
  for (const kind of ['BUILD_CONTEXT', 'DRAFT', 'PERSIST_CANDIDATE', 'VERIFY'] as const) {
    const step = steps.find((row) => row.step_kind === kind);
    if (step === undefined || step.status !== 'SUCCEEDED') throw invalidTransition(`修正所需的 ${kind} 步骤尚未完成。`);
    await resetStep(repositories, step.id, step.revision);
  }
  await transitionRun(repositories, run, 'RETRYING', 'HUMAN_REQUESTED_CHANGES');
}

async function resetStep(repositories: Repositories, stepId: string, revision: bigint): Promise<void> {
  const reset = await repositories.runs.resetStepToPending({ stepId, expectedRevision: revision });
  if (reset === undefined) throw new Error('Review step reset CAS failed');
}

async function transitionRun(repositories: Repositories, run: RunRow, status: 'RETRYING' | 'VERIFYING', waitReason: string | null): Promise<void> {
  const changed = await repositories.runs.advanceRun({ runId: run.id, expectedRevision: run.revision, status, waitReason });
  if (changed === undefined) throw new Error('Review Run transition CAS failed');
}

interface LockedStateReviewTarget {
  readonly state: ProjectStateRow;
  readonly action: NormalizedStateAction;
}

async function lockStateReviewTarget(repositories: Repositories, review: ReviewRequestRow): Promise<LockedStateReviewTarget> {
  if (review.project_id === null) throw invalidTransition('Review 缺少可处理的 Project State 提案。');
  const target = review.target;
  const action = target.action;
  const params = target.params;
  if (typeof action !== 'string' || typeof params !== 'object' || params === null || Array.isArray(params)) throw invalidTransition('State 提案结构无效。');
  const normalized = normalizeStateAction(action, params as Readonly<Record<string, unknown>>);
  // 先锁可选 Task、再锁 ProjectState，调用方随后才锁 Review。
  if (normalized.action === 'SET_NEXT_ACTION' && normalized.nextActionTaskId !== null) {
    const task = await repositories.tasks.lockTask(normalized.nextActionTaskId);
    if (task === undefined || task.project_id !== review.project_id) throw invalidTransition('State 提案引用的 Task 已失效。');
  }
  const state = await repositories.projects.lockProjectState(review.project_id);
  if (state === undefined) throw resourceNotFound('Project State');
  return { state, action: normalized };
}

async function resolveStateReview(repositories: Repositories, review: ReviewRequestRow, decision: ReviewDecision, locked: LockedStateReviewTarget | undefined): Promise<JsonObject> {
  if (review.kind !== 'STATE_PROPOSAL' || review.project_id === null || locked === undefined) throw invalidTransition('Review 缺少可处理的 Project State 提案。');
  if (decision !== 'ACCEPT' && decision !== 'DENY') throw invalidTransition('State 提案只接受 ACCEPT 或 DENY。');
  const target = review.target;
  const normalized = locked.action;
  const project = await repositories.projects.readProject(review.project_id);
  const state = locked.state;
  if (project === undefined || project.workspace_id !== review.workspace_id) throw resourceNotFound('Project State');
  const base = typeof target.base_revision === 'string' ? requireRevision(target.base_revision, 'base_revision') : null;
  if (base === null || state.revision !== base) throw revisionConflict({ entityType: 'PROJECT_STATE', expectedRevision: String(target.base_revision), actualRevision: toDecimalString(state.revision) });
  if (decision === 'DENY') return { state_applied: false };
  const nextRevision = await applyAction(repositories, project.id, project.project_type, base, normalized);
  return { state_applied: true, action: normalized.action, state_revision: toDecimalString(nextRevision) };
}
