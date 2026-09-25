import { sql } from 'kysely';

import {
  claimGatewayWorker, claimRunForGateway, denyGraphActionBeforeInvocation, dispatchGatewayAction,
  prepareGatewayAction, releaseGatewayWorker, type GatewayOrigin,
} from '../application/gateway-actions.js';
import type { ClaimedRunCommand } from '../application/run-dispatch.js';
import { DomainError } from '../application/domain-error.js';
import { applySafeControl } from '../application/control-requests.js';
import { createRepositories } from '../application/unit-of-work.js';
import type { DbExecutor } from '../infrastructure/database.js';
import { readMockGatewayAction } from '../workflow/execution-contract.js';

export interface MockGatewayStepResult {
  readonly status: 'PREPARED' | 'WAITING' | 'SUCCEEDED' | 'UNKNOWN' | 'DENIED';
  readonly operationId: string;
  readonly reviewId?: string;
}

async function approvedResume(db: DbExecutor, claim: ClaimedRunCommand,
  operationId: string): Promise<boolean> {
  if (claim.kind !== 'RESUME' || claim.reviewDecisionId === null) return false;
  const rows = await sql<{ approved: boolean }>`select exists (
    select 1 from run_commands c
    join review_decisions d on d.id = c.review_decision_id
    join review_requests r on r.id = d.review_id
    join logical_operations o on o.id = r.operation_id
    where c.id = ${claim.commandId} and c.run_id = ${claim.runId}
      and c.review_decision_id = ${claim.reviewDecisionId}
      and d.decision = 'APPROVE' and r.kind = 'ACTION_APPROVAL'
      and r.status = 'DECIDED' and r.run_id = ${claim.runId}
      and r.target_hash = d.target_hash and r.operation_id = ${operationId}
      and o.id = ${operationId} and o.run_id = ${claim.runId}
  ) as approved`.execute(db);
  return rows.rows[0]?.approved === true;
}

/** One fixed Mock write per frozen Run contract; Gateway owns authorization and effect identity. */
export async function executeMockGatewayStep(db: DbExecutor, input: {
  readonly claim: ClaimedRunCommand;
  readonly leaseMs: number;
  readonly signal: AbortSignal;
  readonly afterPrepared?: (result: MockGatewayStepResult) => Promise<void>;
  readonly afterAdmit?: () => Promise<void>;
  readonly afterFakeEffect?: () => Promise<void>;
}): Promise<MockGatewayStepResult> {
  const { claim } = input;
  if (input.signal.aborted) throw new Error('Mock Gateway delivery aborted');
  const repositories = createRepositories(db);
  const contract = await repositories.runs.readContract(claim.runId);
  const action = contract === undefined ? undefined : readMockGatewayAction(contract.frozen_snapshot);
  const step = await repositories.runs.readStepByKind(claim.runId, 'DRAFT');
  if (action === undefined || step?.status !== 'SUCCEEDED') {
    throw new Error('Mock Gateway action has no frozen intent or completed DRAFT step');
  }
  const delivery = { commandId: claim.commandId, invocationEpoch: claim.epoch };
  const deniedBeforeInvocation = async (error: unknown,
    ownedWorkerEpoch?: bigint): Promise<MockGatewayStepResult> => {
    const authorizationRefusal = error instanceof DomainError && new Set([
      'GATEWAY_CONNECTION_STALE', 'GATEWAY_CONNECTION_DENIED',
      'GATEWAY_PERMISSION_STALE', 'GATEWAY_PERMISSION_DENIED',
      'GATEWAY_APPROVAL_REQUIRED', 'GATEWAY_APPROVAL_STALE', 'GATEWAY_CONTEXT_STALE',
    ]).has(error.code);
    if (authorizationRefusal) {
      const denied = await denyGraphActionBeforeInvocation(db, {
        workspaceId: claim.workspaceId, runId: claim.runId, operationId: action.operation_id,
        resourceId: action.resource_id, workerId: claim.workerId,
        ...(ownedWorkerEpoch === undefined ? {} : { workerEpoch: ownedWorkerEpoch }),
        delivery, reason: error.code,
      });
      if (denied || (await applySafeControl(db, claim.runId))?.status === 'APPLIED') {
        return { status: 'DENIED', operationId: action.operation_id };
      }
    }
    throw error;
  };
  let operation = await repositories.gateway.readOperation(action.operation_id);
  if (operation !== undefined && (operation.run_id !== claim.runId || operation.step_id !== step.id ||
      operation.workspace_id !== claim.workspaceId)) {
    throw new Error('Mock Gateway persisted operation does not match frozen intent');
  }
  let workerEpoch: bigint | undefined;
  if (operation === undefined) {
    if (claim.kind !== 'START' && claim.kind !== 'RECOVER') {
      throw new Error('Mock Gateway RESUME has no prepared operation');
    }
    workerEpoch = BigInt((await claimRunForGateway(db, {
      workspaceId: claim.workspaceId, runId: claim.runId,
      workerId: claim.workerId, leaseMs: input.leaseMs, delivery,
    })).worker_epoch);
    const origin: GatewayOrigin = { kind: 'RUN', runId: claim.runId, stepId: step.id,
      resourceId: action.resource_id, workerId: claim.workerId, workerEpoch, delivery };
    const prepared = await prepareGatewayAction(db, {
      workspaceId: claim.workspaceId, operationId: action.operation_id,
      intentKey: action.intent_key, connectionId: action.connection_id,
      origin, actionType: 'WRITE_MARKER', target: action.target,
      params: { content: action.content },
    });
    operation = await repositories.gateway.readOperation(action.operation_id);
    if (prepared.status === 'WAITING_APPROVAL') {
      if (prepared.review_id === null) throw new Error('Mock Gateway wait has no Review');
      const waiting = { status: 'WAITING' as const, operationId: action.operation_id,
        reviewId: prepared.review_id };
      await input.afterPrepared?.(waiting);
      return waiting;
    }
    if (prepared.status === 'PREPARED') {
      await input.afterPrepared?.({ status: 'PREPARED', operationId: action.operation_id });
    }
  }
  if (operation?.status === 'WAITING_APPROVAL') {
    if (!(await approvedResume(db, claim, action.operation_id))) {
      if (claim.kind === 'RESUME') throw new Error('Mock Gateway RESUME has no matching approved decision');
      const review = await repositories.reviews.readByOperationId(action.operation_id);
      if (review === undefined) throw new Error('Mock Gateway wait has no Review');
      const waiting = { status: 'WAITING' as const, operationId: action.operation_id,
        reviewId: review.id };
      await input.afterPrepared?.(waiting);
      return waiting;
    }
    try {
      workerEpoch = BigInt((await claimGatewayWorker(db, {
        workspaceId: claim.workspaceId, operationId: action.operation_id,
        workerId: claim.workerId, leaseMs: input.leaseMs, delivery,
      })).worker_epoch);
    } catch (error) { return deniedBeforeInvocation(error); }
  } else if (operation?.status === 'PREPARED' && workerEpoch === undefined) {
    try {
      workerEpoch = BigInt((await claimGatewayWorker(db, {
        workspaceId: claim.workspaceId, operationId: action.operation_id,
        workerId: claim.workerId, leaseMs: input.leaseMs, delivery,
      })).worker_epoch);
    } catch (error) { return deniedBeforeInvocation(error); }
  } else if (operation?.status === 'SUCCEEDED') {
    const run = await repositories.runs.readRun(claim.runId);
    if (run?.worker_id === claim.workerId) {
      await releaseGatewayWorker(db, { workspaceId: claim.workspaceId, runId: claim.runId,
        workerId: claim.workerId, workerEpoch: run.worker_epoch, delivery });
    }
    return { status: 'SUCCEEDED', operationId: action.operation_id };
  } else if (operation?.status === 'DENIED' || operation?.status === 'FAILED') {
    return { status: 'DENIED', operationId: action.operation_id };
  } else if (operation?.status === 'DISPATCHING' || operation?.status === 'UNKNOWN') {
    return { status: 'UNKNOWN', operationId: action.operation_id };
  }
  if (workerEpoch === undefined) throw new Error('Mock Gateway Worker claim is missing');
  const origin: GatewayOrigin = { kind: 'RUN', runId: claim.runId, stepId: step.id,
    resourceId: action.resource_id, workerId: claim.workerId, workerEpoch, delivery };
  let dispatched: Awaited<ReturnType<typeof dispatchGatewayAction>>;
  try {
    dispatched = await dispatchGatewayAction(db, {
      workspaceId: claim.workspaceId, operationId: action.operation_id, origin,
      signal: input.signal,
      hooks: { ...(input.afterAdmit === undefined ? {} : { afterAdmit: input.afterAdmit }),
        ...(input.afterFakeEffect === undefined ? {} : { afterFakeEffect: input.afterFakeEffect }) },
    });
  } catch (error) { return deniedBeforeInvocation(error, workerEpoch); }
  if (dispatched.status === 'SUCCEEDED') {
    await releaseGatewayWorker(db, { workspaceId: claim.workspaceId, runId: claim.runId,
      workerId: claim.workerId, workerEpoch, delivery });
  }
  return { status: dispatched.status === 'SUCCEEDED' ? 'SUCCEEDED' : 'UNKNOWN',
    operationId: action.operation_id };
}
