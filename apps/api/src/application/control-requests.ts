import { randomUUID } from 'node:crypto';

import type { DbExecutor } from '../infrastructure/database.js';
import type { RunControlRequestRow, RunControlType, RunRow, TaskRow } from '../infrastructure/database-schema.js';
import type { JsonObject } from '../infrastructure/json.js';
import { toDecimalString } from '../shared/decimal.js';
import { LOCAL_ACTOR_REF, httpCommandScopeKey } from './actor.js';
import { runIdempotentCommand, type CommandOutcome } from './command.js';
import { DomainError, invalidTransition, resourceNotFound, revisionConflict } from './domain-error.js';
import { lockTaskAndRun } from './lock-task-run.js';
import { requireRevision } from './revisions.js';
import { createRepositories, withTransaction, type Repositories } from './unit-of-work.js';
import { readMockActionOperationId } from '../workflow/execution-contract.js';

export interface ControlRequestDto {
  readonly id: string;
  readonly run_id: string;
  readonly task_id: string;
  readonly type: RunControlType;
  readonly status: RunControlRequestRow['status'];
  readonly revision: string;
  readonly requested_at: string;
  readonly decided_at: string | null;
  readonly result_ref: JsonObject | null;
}

export type RequestControlResult = {
  readonly control_request_id: string;
  readonly run_id: string;
  readonly task_id: string;
  readonly type: RunControlType;
  readonly status: 'PENDING';
  readonly run_revision: string;
}

export type ResumeRunResult = {
  readonly run_id: string;
  readonly status: string;
  readonly run_revision: string;
}

export function controlDto(row: RunControlRequestRow): ControlRequestDto {
  return {
    id: row.id, run_id: row.run_id, task_id: row.task_id, type: row.type, status: row.status,
    revision: toDecimalString(row.revision), requested_at: row.requested_at.toISOString(),
    decided_at: row.decided_at?.toISOString() ?? null, result_ref: row.result_ref,
  };
}

export async function readControlRequest(db: DbExecutor, workspaceId: string, runId: string, requestId: string): Promise<ControlRequestDto> {
  const repositories = createRepositories(db);
  const run = await repositories.runs.readRun(runId);
  const row = await repositories.recovery.readControl(requestId);
  if (run === undefined || run.workspace_id !== workspaceId || row === undefined || row.run_id !== run.id) {
    throw resourceNotFound('Control request');
  }
  return controlDto(row);
}

export async function requestRunControl(db: DbExecutor, input: {
  readonly workspaceId: string; readonly runId: string; readonly commandId: string;
  readonly expectedTaskRevision: string; readonly expectedRunRevision: string;
  readonly type: RunControlType; readonly supersedesRequestId?: string | null;
}): Promise<CommandOutcome<RequestControlResult>> {
  const taskRevision = requireRevision(input.expectedTaskRevision, 'expected_task_revision');
  const runRevision = requireRevision(input.expectedRunRevision, 'expected_run_revision');
  return runIdempotentCommand(db, {
    scopeKey: httpCommandScopeKey(input.workspaceId), commandId: input.commandId,
    commandType: 'RequestRunControl', target: { run_id: input.runId },
    body: { expected_task_revision: toDecimalString(taskRevision), expected_run_revision: toDecimalString(runRevision),
      type: input.type, supersedes_request_id: input.supersedesRequestId ?? null },
    execute: async (repositories) => {
      const { task, run } = await lockTaskAndRun(repositories, input.runId, input.workspaceId);
      requireActiveRun(task, run);
      if (input.type === 'PAUSE' && run.status === 'PAUSED') {
        throw invalidTransition('该 Run 已暂停，不能再次请求暂停。');
      }
      requireRevisionMatch(task, run, taskRevision, runRevision);
      const row = await enqueueControlLocked(repositories, { task, run, type: input.type,
        supersedesRequestId: input.supersedesRequestId ?? null,
        commandId: input.commandId });
      const touched = await repositories.runs.touchRun(run.id, run.revision);
      if (touched === undefined) throw new Error('control request Run revision CAS failed');
      return { control_request_id: row.id, run_id: run.id, task_id: task.id, type: row.type,
        status: 'PENDING' as const, run_revision: toDecimalString(touched.revision) };
    },
  });
}

/** Task cancel 的 AI 分支复用同一个锁内入队，不开启嵌套事务。 */
export async function enqueueControlLocked(repositories: Repositories, input: {
  readonly task: TaskRow; readonly run: RunRow; readonly type: RunControlType;
  readonly supersedesRequestId?: string | null;
  readonly commandId?: string;
}): Promise<RunControlRequestRow> {
  if (input.type === 'PAUSE' && input.run.status === 'PAUSED') {
    throw invalidTransition('该 Run 已暂停，不能再次请求暂停。');
  }
  const pending = await repositories.recovery.lockPendingControl(input.run.id);
  if (pending !== undefined) {
    if (pending.id !== input.supersedesRequestId) throw controlConflict();
    const superseded = await repositories.recovery.decideControl(pending.id, 'SUPERSEDED',
      { reason: 'EXPLICIT_SUPERSEDE', successor_type: input.type });
    if (superseded === undefined) throw new Error('pending control supersede CAS failed');
  } else if (input.supersedesRequestId !== null && input.supersedesRequestId !== undefined) {
    throw controlConflict();
  }
  const row = await repositories.recovery.insertControl({ id: randomUUID(), workspaceId: input.run.workspace_id,
    taskId: input.task.id, runId: input.run.id, type: input.type, requestedBy: LOCAL_ACTOR_REF,
    supersedesRequestId: input.supersedesRequestId ?? null });
  await repositories.activities.insertActivityRecord({ id: randomUUID(),
    workspaceId: input.run.workspace_id, runId: input.run.id,
    actorKind: 'HUMAN', actorRef: LOCAL_ACTOR_REF, commandId: input.commandId ?? null,
    projectId: input.task.project_id, taskId: input.task.id,
    eventType: 'RUN_CONTROL_REQUESTED',
    factRefs: { run_id: input.run.id, control_request_id: row.id, type: input.type } });
  return row;
}

/** 安全点：同一 Task→Run 锁下核对 worker、UNKNOWN 与控制，才把 PENDING 变为 APPLIED。 */
export async function applySafeControl(db: DbExecutor, runId: string): Promise<ControlRequestDto | null> {
  return withTransaction(db, async (repositories) => {
    const { task, run } = await lockTaskAndRun(repositories, runId);
    const pending = await repositories.recovery.lockPendingControl(run.id);
    if (pending === undefined) return null;
    const delivery = await repositories.dispatch.lockInvocation(run.id);
    if (delivery?.status === 'ACTIVE' || delivery?.status === 'STOP_REQUIRED') {
      return controlDto(pending);
    }
    const gatewayPending = await repositories.gateway.listUnresolvedRunOperations(run.id);
    let gatewayNeedsReconciliation = false;
    for (const operation of gatewayPending) {
      if (operation.status === 'WAITING_APPROVAL') continue;
      const invocation = operation.status === 'PREPARED'
        ? await repositories.gateway.lastInvocation(operation.id) : undefined;
      const resourceClaim = invocation?.resource_claim_id === null || invocation === undefined
        ? undefined : await repositories.gateway.readClaim(invocation.resource_claim_id);
      if (invocation?.status !== 'NOT_EXECUTED' || resourceClaim?.status !== 'RELEASED') {
        gatewayNeedsReconciliation = true;
        break;
      }
    }
    if (run.worker_id !== null || (await repositories.recovery.listUnresolvedEffects(run.id)).length > 0 ||
        gatewayNeedsReconciliation) {
      return controlDto(pending);
    }
    // A Review wait has no external Invocation or resource claim. Control may
    // withdraw that proposal at the safe point before changing Task/Run.
    for (const operation of gatewayPending) {
      const review = await repositories.reviews.readByOperationId(operation.id);
      if (review?.status === 'OPEN') await repositories.reviews.expireRequest(review.id, review.revision);
      await repositories.dispatch.settleInvalidatedApprovalResume(run.id, operation.id);
      await repositories.gateway.setOperationStatus(operation.id, 'DENIED', { reason: 'RUN_CONTROL_APPLIED' });
    }
    if (isTerminal(run.status) || task.executor_run_id !== run.id || task.ownership_epoch !== run.ownership_epoch) {
      const rejected = await repositories.recovery.decideControl(pending.id, 'REJECTED', { reason: 'RUN_TERMINAL_OR_STALE' });
      if (rejected === undefined) throw new Error('control reject CAS failed');
      return controlDto(rejected);
    }
    if (pending.type === 'PAUSE') {
      const resumePhase = run.status === 'CREATED' ? 'CONTEXT_BUILDING'
        : run.status === 'WAITING_APPROVAL' && gatewayPending.length > 0 ? 'RUNNING' : run.status;
      const changed = await repositories.runs.advanceRun({ runId: run.id, expectedRevision: run.revision,
        status: 'PAUSED', currentStepId: run.current_step_id, resumePhase, waitReason: 'PAUSED_BY_USER' });
      if (changed === undefined) throw new Error('pause Run CAS failed');
      if (task.status !== 'WAITING') {
        const waiting = await repositories.tasks.applyTaskStatus({ taskId: task.id, expectedRevision: task.revision,
          fromStatus: task.status, toStatus: 'WAITING' });
        if (waiting === undefined) throw new Error('pause Task CAS failed');
      }
    } else {
      const changed = await repositories.runs.advanceRun({ runId: run.id, expectedRevision: run.revision,
        status: 'CANCELLED', currentStepId: run.current_step_id, waitReason: pending.type, terminal: true });
      if (changed === undefined) throw new Error('cancel Run CAS failed');
      const toStatus = pending.type === 'HANDOFF' ? 'IN_PROGRESS' : pending.type === 'CANCEL_TASK' ? 'CANCELLED' : 'READY';
      const released = await repositories.tasks.releaseExecutionFromRun({ taskId: task.id, runId: run.id,
        expectedRevision: task.revision, toStatus });
      if (released === undefined) throw new Error('control Task release CAS failed');
    }
    const resultRef: JsonObject = pending.type === 'HANDOFF'
      ? { run_status: 'CANCELLED', type: 'HANDOFF', handoff: await buildHandoffRef(repositories, run) }
      : { run_status: pending.type === 'PAUSE' ? 'PAUSED' : 'CANCELLED', type: pending.type };
    const decided = await repositories.recovery.decideControl(pending.id, 'APPLIED', resultRef);
    if (decided === undefined) throw new Error('control apply CAS failed');
    await repositories.activities.insertActivityRecord({ id: randomUUID(), actorKind: 'SYSTEM',
      workspaceId: run.workspace_id, runId: run.id,
      actorRef: `run:${run.id}`, commandId: null, projectId: task.project_id, taskId: task.id,
      eventType: 'RUN_CONTROL_APPLIED', factRefs: { control_request_id: pending.id, type: pending.type } });
    return controlDto(decided);
  });
}

/** 交接回执仅保存持久事实的 ID 与步骤位置，不拷贝模型正文或主机路径。 */
async function buildHandoffRef(repositories: Repositories, run: RunRow): Promise<JsonObject> {
  const steps = await repositories.runs.listSteps(run.id);
  const candidate = steps.find((step) => step.step_kind === 'PERSIST_CANDIDATE');
  const verification = steps.find((step) => step.step_kind === 'VERIFY');
  return {
    run_id: run.id,
    task_id: run.task_id,
    ownership_epoch: toDecimalString(run.ownership_epoch),
    stopped_at_step_id: run.current_step_id,
    candidate_artifact_id: stringRef(candidate?.result_ref, 'artifact_id'),
    candidate_artifact_version_id: stringRef(candidate?.result_ref, 'artifact_version_id'),
    verification_session_id: stringRef(verification?.result_ref, 'session_id'),
    step_positions: steps.map((step) => ({ step_id: step.id, step_kind: step.step_kind, status: step.status })),
  };
}

function stringRef(value: JsonObject | null | undefined, key: string): string | null {
  const field = value?.[key];
  return typeof field === 'string' ? field : null;
}

export async function resumeRun(db: DbExecutor, input: {
  readonly workspaceId: string; readonly runId: string; readonly commandId: string;
  readonly expectedTaskRevision: string; readonly expectedRunRevision: string;
}): Promise<CommandOutcome<ResumeRunResult>> {
  const taskRevision = requireRevision(input.expectedTaskRevision, 'expected_task_revision');
  const runRevision = requireRevision(input.expectedRunRevision, 'expected_run_revision');
  return runIdempotentCommand(db, {
    scopeKey: httpCommandScopeKey(input.workspaceId), commandId: input.commandId,
    commandType: 'ResumeRun', target: { run_id: input.runId },
    body: { expected_task_revision: toDecimalString(taskRevision), expected_run_revision: toDecimalString(runRevision) },
    execute: async (repositories) => {
      const { task, run } = await lockTaskAndRun(repositories, input.runId, input.workspaceId);
      requireRevisionMatch(task, run, taskRevision, runRevision);
      if (run.status !== 'PAUSED' || task.status !== 'WAITING' || task.executor_run_id !== run.id ||
          task.ownership_epoch !== run.ownership_epoch) throw invalidTransition('只有仍持有 AI 执行权的 PAUSED Run 可恢复。');
      if (await repositories.recovery.findPendingControl(run.id)) throw controlConflict();
      if ((await repositories.recovery.listUnresolvedEffects(run.id)).length > 0) throw unknownActionBlocked();
      if (run.worker_id !== null) throw invalidTransition('Run 仍有在途 Worker，暂不能恢复。');
      const invocation = await repositories.dispatch.lockInvocation(run.id);
      if (invocation?.status !== 'IDLE') {
        throw invalidTransition('旧 Worker 执行槽尚未释放，暂不能恢复。');
      }
      const contract = await repositories.runs.readContract(run.id);
      const frozenActionOperationId = contract === undefined ? undefined :
        readMockActionOperationId(contract.frozen_snapshot);
      const operation = frozenActionOperationId === undefined ? undefined :
        await repositories.gateway.readOperation(frozenActionOperationId);
      if (operation !== undefined && ['DENIED', 'FAILED', 'UNKNOWN', 'DISPATCHING'].includes(operation.status)) {
        throw invalidTransition('原 Run 的必需动作已被拒绝或尚未核对；请取消旧 Run 后重新委派。');
      }
      const status = run.resume_phase === 'WAITING_APPROVAL' ? 'WAITING_APPROVAL' : run.resume_phase ?? 'CONTEXT_BUILDING';
      const changed = await repositories.runs.advanceRun({ runId: run.id, expectedRevision: run.revision,
        status: status as RunRow['status'], currentStepId: run.current_step_id,
        waitReason: status === 'WAITING_APPROVAL' ? 'ACTION_APPROVAL_REQUIRED' : null });
      if (changed === undefined) throw new Error('resume Run CAS failed');
      if (status !== 'WAITING_APPROVAL') {
        const active = await repositories.tasks.applyTaskStatus({ taskId: task.id, expectedRevision: task.revision,
          fromStatus: 'WAITING', toStatus: 'IN_PROGRESS' });
        if (active === undefined) throw new Error('resume Task CAS failed');
        await repositories.dispatch.insertCommand({
          id: randomUUID(), workspaceId: run.workspace_id, runId: run.id,
          sourceCommandId: input.commandId, kind: 'RESUME',
        });
      }
      return { run_id: run.id, status: changed.status, run_revision: toDecimalString(changed.revision) };
    },
  });
}

function requireActiveRun(task: TaskRow, run: RunRow): void {
  if (isTerminal(run.status)) throw runTerminal();
  if (task.executor_run_id !== run.id || task.ownership_epoch !== run.ownership_epoch) {
    throw invalidTransition('Run 未持有该 Task 的执行权。', { taskId: task.id });
  }
}

function requireRevisionMatch(task: TaskRow, run: RunRow, taskRevision: bigint, runRevision: bigint): void {
  if (task.revision !== taskRevision) throw revisionConflict({ entityType: 'TASK', expectedRevision: toDecimalString(taskRevision), actualRevision: toDecimalString(task.revision) });
  if (run.revision !== runRevision) throw revisionConflict({ entityType: 'RUN', expectedRevision: toDecimalString(runRevision), actualRevision: toDecimalString(run.revision) });
}

function isTerminal(status: RunRow['status']): boolean {
  return status === 'COMPLETED' || status === 'FAILED' || status === 'CANCELLED';
}

function runTerminal(): DomainError {
  return new DomainError({ code: 'RUN_TERMINAL', status: 409, type: '/problems/run-terminal',
    title: 'Run 已结束', detail: '终态 Run 不能接收新的控制意图。', retryable: false,
    retryAction: 'REFRESH_AND_REDECIDE' });
}

function controlConflict(): DomainError {
  return new DomainError({ code: 'CONTROL_CONFLICT', status: 409, type: '/problems/control-conflict',
    title: '已有待处理控制请求', detail: '请先读取当前请求，或明确指定 supersedes_request_id。',
    retryable: false, retryAction: 'REFRESH_AND_REDECIDE' });
}

function unknownActionBlocked(): DomainError {
  return new DomainError({ code: 'UNKNOWN_ACTION_BLOCKED', status: 409, type: '/problems/unknown-action-blocked',
    title: '动作效果尚未核对', detail: '必须先核对在途或 UNKNOWN 动作，不能恢复或交接执行。',
    retryable: false, retryAction: 'POLL_RESOURCE' });
}
