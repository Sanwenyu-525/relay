import { randomUUID } from 'node:crypto';

import type { DbExecutor } from '../infrastructure/database.js';
import type { JsonObject } from '../infrastructure/json.js';
import { toDecimalString } from '../shared/decimal.js';
import { httpCommandScopeKey, LOCAL_ACTOR_REF } from './actor.js';
import { runIdempotentCommand, type CommandOutcome } from './command.js';
import { invalidTransition, resourceNotFound, revisionConflict } from './domain-error.js';
import { requireRevision } from './revisions.js';
import { reviewTargetHash } from './review-requests.js';
import { normalizeStateAction } from './state-action.js';
import { withTransaction } from './unit-of-work.js';
import { lockTaskAndRun } from './lock-task-run.js';
import { lockWritableProjectInWorkspace } from './guards.js';

/** P09 Gateway 后续消费此批准；P07 仅预分配稳定 operation_id 并保存决定。 */
export async function requestActionApproval(db: DbExecutor, input: {
  readonly workspaceId: string;
  readonly runId: string;
  readonly stepId: string;
  readonly operationId: string;
  readonly actionType: string;
  readonly normalizedTarget: string;
  readonly paramsHash: string;
  readonly contentHash: string | null;
  readonly reason: string;
  readonly expiresAt: Date;
}): Promise<{ readonly reviewId: string; readonly targetHash: string }> {
  if (input.expiresAt.getTime() <= Date.now()) throw invalidTransition('操作审批有效期必须晚于当前时间。');
  return withTransaction(db, async (repositories) => {
    const { run, task } = await lockTaskAndRun(repositories, input.runId, input.workspaceId);
    if (task.executor_run_id !== run.id || task.ownership_epoch !== run.ownership_epoch) throw invalidTransition('Run 未持有该 Task 的执行权。');
    const step = await repositories.runs.readStep(input.stepId);
    if (step === undefined || step.run_id !== run.id) throw resourceNotFound('Run step');
    const contract = await repositories.runs.readContract(run.id);
    if (contract === undefined) throw invalidTransition('Run 缺少冻结执行契约。');
    const target: JsonObject = {
      run_id: run.id, step_id: step.id, operation_id: input.operationId,
      action_type: input.actionType, normalized_target: input.normalizedTarget,
      params_hash: input.paramsHash, content_hash: input.contentHash,
      acceptance_revision: toDecimalString(contract.acceptance_revision),
    };
    const targetHash = reviewTargetHash(target);
    const existing = await repositories.reviews.readByOperationId(input.operationId);
    if (existing !== undefined) {
      if (!existing.target_hash.equals(targetHash)) throw invalidTransition('同一 operation_id 已绑定不同的操作目标。');
      return { reviewId: existing.id, targetHash: targetHash.toString('hex') };
    }
    if (run.status !== 'RUNNING') throw invalidTransition('只有 RUNNING 的 Run 可以请求新操作审批。');
    const review = await repositories.reviews.insertRequest({
      id: randomUUID(), workspaceId: input.workspaceId, projectId: task.project_id, taskId: task.id,
      runId: run.id, verificationSessionId: null, criterionId: null, operationId: input.operationId,
      importJobId: null,
      kind: 'ACTION_APPROVAL', reason: input.reason, targetHash, target,
      evidence: { step_id: step.id, action_type: input.actionType, normalized_target: input.normalizedTarget },
      effect: { summary: '批准只授权此逻辑操作；外部执行由后续 Gateway 在再次校验权限后进行。', external_effect_executed: false },
      allowedDecisions: ['APPROVE', 'DENY'], expiresAt: input.expiresAt,
    });
    const changed = await repositories.runs.advanceRun({ runId: run.id, expectedRevision: run.revision, status: 'WAITING_APPROVAL', waitReason: 'ACTION_APPROVAL_REQUIRED', resumePhase: 'RUNNING' });
    if (changed === undefined) throw new Error('approval request Run CAS failed');
    if (task.status === 'IN_PROGRESS') {
      const waiting = await repositories.tasks.applyTaskStatus({ taskId: task.id,
        expectedRevision: task.revision, fromStatus: 'IN_PROGRESS', toStatus: 'WAITING' });
      if (waiting === undefined) throw new Error('approval request Task CAS failed');
    }
    await repositories.activities.insertActivityRecord({ id: randomUUID(),
      workspaceId: run.workspace_id, runId: run.id,
      actorKind: 'AI', actorRef: `run:${run.id}`, commandId: null,
      projectId: task.project_id, taskId: task.id, eventType: 'REVIEW_REQUESTED',
      factRefs: { review_id: review.id, run_id: run.id, operation_id: input.operationId,
        kind: review.kind } });
    return { reviewId: review.id, targetHash: targetHash.toString('hex') };
  });
}

/** State 建议冻结 base_revision 和类型化命令；接受仍走 Project State Owner 的既有写入口。 */
export async function requestStateProposal(db: DbExecutor, input: {
  readonly workspaceId: string;
  readonly projectId: string;
  readonly commandId: string;
  readonly baseRevision: string;
  readonly action: string;
  readonly params: Readonly<Record<string, unknown>>;
  readonly reason: string;
}): Promise<CommandOutcome<{ readonly review_id: string; readonly target_hash: string }>> {
  const base = requireRevision(input.baseRevision, 'base_revision');
  const normalized = normalizeStateAction(input.action, input.params);
  return runIdempotentCommand(db, {
    scopeKey: httpCommandScopeKey(input.workspaceId), commandId: input.commandId, commandType: 'RequestStateProposal',
    target: { project_id: input.projectId },
    body: { base_revision: toDecimalString(base), action: normalized.body, reason: input.reason },
    execute: async (repositories) => {
      const project = await lockWritableProjectInWorkspace(repositories, input.workspaceId, input.projectId);
      const state = await repositories.projects.readProjectState(project.id);
      if (state === undefined) throw resourceNotFound('Project State');
      if (state.revision !== base) throw revisionConflict({ entityType: 'PROJECT_STATE', expectedRevision: toDecimalString(base), actualRevision: toDecimalString(state.revision) });
      const { action, ...params } = normalized.body;
      const target: JsonObject = { project_id: project.id, base_revision: toDecimalString(base), action: normalized.action, params };
      const targetHash = reviewTargetHash(target);
      const review = await repositories.reviews.insertRequest({
        id: randomUUID(), workspaceId: input.workspaceId, projectId: project.id, taskId: null,
        runId: null, verificationSessionId: null, criterionId: null, operationId: null,
        importJobId: null,
        kind: 'STATE_PROPOSAL', reason: input.reason, targetHash, target,
        evidence: { base_revision: toDecimalString(base), source_command_id: input.commandId },
        effect: { summary: '接受后对当前 Project State 应用类型化命令；若基线已变化则拒绝。', action: normalized.action },
        allowedDecisions: ['ACCEPT', 'DENY'], expiresAt: null,
      });
      await repositories.activities.insertActivityRecord({ id: randomUUID(),
        workspaceId: input.workspaceId, actorKind: 'HUMAN', actorRef: LOCAL_ACTOR_REF,
        commandId: input.commandId, projectId: project.id, taskId: null,
        eventType: 'REVIEW_REQUESTED', factRefs: { review_id: review.id, kind: review.kind } });
      return { review_id: review.id, target_hash: targetHash.toString('hex') };
    },
  });
}
