import { join } from 'node:path';
import { sql } from 'kysely';
import { claimGatewayWorker, claimRunForGateway, denyGraphActionBeforeInvocation, dispatchGatewayAction, failGraphActionAfterInvocation, prepareGatewayAction, releaseGatewayWorker, } from '../application/gateway-actions.js';
import { DomainError, resourceNotFound } from '../application/domain-error.js';
import { applySafeControl } from '../application/control-requests.js';
import { readPendingFrozenRunAction } from '../application/frozen-run-actions.js';
import { createRepositories } from '../application/unit-of-work.js';
async function approvedResume(db, claim, operationId) {
    if (claim.kind !== 'RESUME' || claim.reviewDecisionId === null)
        return false;
    const rows = await sql `select exists (
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
/** One fixed Mock action per frozen Run contract; Gateway owns authorization and effect identity. */
export async function executeMockGatewayStep(db, input) {
    const { claim } = input;
    if (input.signal.aborted)
        throw new Error('Mock Gateway delivery aborted');
    const repositories = createRepositories(db);
    const pending = await readPendingFrozenRunAction(repositories, claim.runId);
    if (pending === undefined)
        throw new Error('Mock Gateway action has no frozen intent');
    const action = pending.action;
    let operation = pending.operation;
    const draft = await repositories.runs.readStepByKind(claim.runId, 'DRAFT');
    const built = await repositories.runs.readStepByKind(claim.runId, 'BUILD_CONTEXT');
    const writeGroup = action.kind === 'WRITE' || action.kind === 'FILE_WRITE' || action.kind === 'CLI';
    // Existing Runs bound their read to DRAFT. A pending read in a new Run is
    // bound to BUILD_CONTEXT so its result is available before model generation.
    const step = operation === undefined
        ? (writeGroup || draft?.status === 'SUCCEEDED' ? draft : built)
        : operation.step_id === draft?.id ? draft : operation.step_id === built?.id ? built : undefined;
    if (step?.status !== 'SUCCEEDED' ||
        (writeGroup && step.step_kind !== 'DRAFT') ||
        (!writeGroup && step.step_kind === 'DRAFT' && draft?.status !== 'SUCCEEDED')) {
        throw new Error('Mock Gateway action has no completed owner step');
    }
    const delivery = { commandId: claim.commandId, invocationEpoch: claim.epoch };
    const deniedBeforeInvocation = async (error, ownedWorkerEpoch) => {
        // Deterministic admission refusals converge the Run to FAILED instead of
        // retry-looping. Missing targets are permanent for reads (file: the file
        // must exist behind a frozen path; web: the frozen URL host is binding).
        const authorizationRefusal = error instanceof DomainError && new Set([
            'GATEWAY_CONNECTION_STALE', 'GATEWAY_CONNECTION_DENIED',
            'GATEWAY_PERMISSION_STALE', 'GATEWAY_PERMISSION_DENIED',
            'GATEWAY_APPROVAL_REQUIRED', 'GATEWAY_APPROVAL_STALE', 'GATEWAY_CONTEXT_STALE',
            ...(action.kind === 'READ'
                ? ['GATEWAY_TARGET_DENIED', 'RESOURCE_NOT_FOUND'] : []),
            ...(action.kind === 'WEB'
                ? ['GATEWAY_TARGET_DENIED'] : []),
            ...(action.kind === 'FILE_WRITE' || action.kind === 'CLI'
                ? ['GATEWAY_TARGET_DENIED', 'RESOURCE_NOT_FOUND'] : []),
        ]).has(error.code);
        if (authorizationRefusal) {
            const denied = await denyGraphActionBeforeInvocation(db, {
                workspaceId: claim.workspaceId, runId: claim.runId, operationId: action.operation_id,
                ...(action.kind === 'WEB' ? {} : { resourceId: action.resource_id }),
                workerId: claim.workerId,
                ...(ownedWorkerEpoch === undefined ? {} : { workerEpoch: ownedWorkerEpoch }),
                delivery, reason: error.code,
            });
            if (denied || (await applySafeControl(db, claim.runId))?.status === 'APPLIED') {
                return { status: 'DENIED', operationId: action.operation_id };
            }
        }
        throw error;
    };
    // WEB_FETCH targets a URL and binds no managed resource; file/write origins
    // keep their resource identity for the Gateway fence.
    const gatewayOrigin = (workerEpoch) => ({
        kind: 'RUN', runId: claim.runId, stepId: step.id,
        ...(action.kind === 'WEB' ? {} : { resourceId: action.resource_id }),
        workerId: claim.workerId, workerEpoch, delivery,
    });
    const failedNoEffect = async (workerEpoch) => {
        const settled = await failGraphActionAfterInvocation(db, {
            workspaceId: claim.workspaceId, runId: claim.runId, operationId: action.operation_id,
            workerId: claim.workerId, ...(workerEpoch === undefined ? {} : { workerEpoch }), delivery,
        });
        if (settled === 'STALE')
            throw new Error('Failed Gateway action no longer owns this Run');
        // A pending control is applied after this outer command is settled.
        return { status: 'DENIED', operationId: action.operation_id };
    };
    if (operation !== undefined && (operation.run_id !== claim.runId || operation.step_id !== step.id ||
        operation.workspace_id !== claim.workspaceId)) {
        throw new Error('Mock Gateway persisted operation does not match frozen intent');
    }
    let workerEpoch;
    if (operation === undefined) {
        if (claim.kind !== 'START' && claim.kind !== 'RECOVER') {
            throw new Error('Mock Gateway RESUME has no prepared operation');
        }
        workerEpoch = BigInt((await claimRunForGateway(db, {
            workspaceId: claim.workspaceId, runId: claim.runId,
            workerId: claim.workerId, leaseMs: input.leaseMs, delivery,
        })).worker_epoch);
        const origin = gatewayOrigin(workerEpoch);
        let prepared;
        try {
            if (action.kind === 'WRITE') {
                prepared = await prepareGatewayAction(db, {
                    workspaceId: claim.workspaceId, operationId: action.operation_id,
                    intentKey: action.intent_key, connectionId: action.connection_id,
                    origin, actionType: 'WRITE_MARKER', target: action.target,
                    params: { content: action.content },
                });
            }
            else if (action.kind === 'READ') {
                const resource = await repositories.gateway.readResource(action.resource_id);
                if (resource?.workspace_id !== claim.workspaceId) {
                    return deniedBeforeInvocation(resourceNotFound('File read resource'));
                }
                prepared = await prepareGatewayAction(db, {
                    workspaceId: claim.workspaceId, operationId: action.operation_id,
                    intentKey: action.intent_key, connectionId: action.connection_id,
                    origin, actionType: 'READ_FILE',
                    target: join(resource.canonical_root, action.relative_target), params: {},
                });
            }
            else if (action.kind === 'FILE_WRITE') {
                const run = await repositories.runs.readRun(claim.runId);
                const task = run === undefined ? undefined : await repositories.tasks.readTask(run.task_id);
                const resource = await repositories.gateway.readResource(action.resource_id);
                if (resource?.workspace_id !== claim.workspaceId || resource.project_id !== task?.project_id) {
                    return deniedBeforeInvocation(resourceNotFound('File write resource'));
                }
                prepared = await prepareGatewayAction(db, {
                    workspaceId: claim.workspaceId, operationId: action.operation_id,
                    intentKey: action.intent_key, connectionId: action.connection_id,
                    origin, actionType: 'APPLY_CHANGESET', target: resource.canonical_root,
                    params: { changes: action.changes },
                });
            }
            else if (action.kind === 'CLI') {
                const run = await repositories.runs.readRun(claim.runId);
                const task = run === undefined ? undefined : await repositories.tasks.readTask(run.task_id);
                const resource = await repositories.gateway.readResource(action.resource_id);
                if (resource?.workspace_id !== claim.workspaceId || resource.project_id !== task?.project_id) {
                    return deniedBeforeInvocation(resourceNotFound('Command resource'));
                }
                prepared = await prepareGatewayAction(db, {
                    workspaceId: claim.workspaceId, operationId: action.operation_id,
                    intentKey: action.intent_key, connectionId: action.connection_id,
                    origin, actionType: 'CLI_RUN', target: resource.canonical_root,
                    params: { executable: action.executable, args: [...action.args],
                        ...(action.max_output_bytes === undefined ? {} : { max_output_bytes: action.max_output_bytes }) },
                });
            }
            else {
                prepared = await prepareGatewayAction(db, {
                    workspaceId: claim.workspaceId, operationId: action.operation_id,
                    intentKey: action.intent_key, connectionId: action.connection_id,
                    origin, actionType: 'WEB_FETCH', target: action.url, params: {},
                });
            }
        }
        catch (error) {
            return deniedBeforeInvocation(error, workerEpoch);
        }
        operation = await repositories.gateway.readOperation(action.operation_id);
        if (prepared.status === 'WAITING_APPROVAL') {
            if (prepared.review_id === null)
                throw new Error('Mock Gateway wait has no Review');
            const waiting = { status: 'WAITING', operationId: action.operation_id,
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
            if (claim.kind === 'RESUME')
                throw new Error('Mock Gateway RESUME has no matching approved decision');
            const review = await repositories.reviews.readByOperationId(action.operation_id);
            if (review === undefined)
                throw new Error('Mock Gateway wait has no Review');
            const waiting = { status: 'WAITING', operationId: action.operation_id,
                reviewId: review.id };
            await input.afterPrepared?.(waiting);
            return waiting;
        }
        try {
            workerEpoch = BigInt((await claimGatewayWorker(db, {
                workspaceId: claim.workspaceId, operationId: action.operation_id,
                workerId: claim.workerId, leaseMs: input.leaseMs, delivery,
            })).worker_epoch);
        }
        catch (error) {
            return deniedBeforeInvocation(error, workerEpoch);
        }
    }
    else if (operation?.status === 'PREPARED' && workerEpoch === undefined) {
        try {
            workerEpoch = BigInt((await claimGatewayWorker(db, {
                workspaceId: claim.workspaceId, operationId: action.operation_id,
                workerId: claim.workerId, leaseMs: input.leaseMs, delivery,
            })).worker_epoch);
        }
        catch (error) {
            return deniedBeforeInvocation(error, workerEpoch);
        }
    }
    else if (operation?.status === 'SUCCEEDED') {
        const run = await repositories.runs.readRun(claim.runId);
        if (run?.worker_id === claim.workerId) {
            await releaseGatewayWorker(db, { workspaceId: claim.workspaceId, runId: claim.runId,
                workerId: claim.workerId, workerEpoch: run.worker_epoch, delivery });
        }
        return { status: 'SUCCEEDED', operationId: action.operation_id };
    }
    else if (operation?.status === 'FAILED' && action.kind !== 'WRITE') {
        const run = await repositories.runs.readRun(claim.runId);
        return failedNoEffect(run?.worker_id === claim.workerId ? run.worker_epoch : undefined);
    }
    else if (operation?.status === 'DENIED' || operation?.status === 'FAILED') {
        return { status: 'DENIED', operationId: action.operation_id };
    }
    else if (operation?.status === 'DISPATCHING' || operation?.status === 'UNKNOWN') {
        return { status: 'UNKNOWN', operationId: action.operation_id };
    }
    if (workerEpoch === undefined)
        throw new Error('Mock Gateway Worker claim is missing');
    const origin = gatewayOrigin(workerEpoch);
    let dispatched;
    try {
        dispatched = await dispatchGatewayAction(db, {
            workspaceId: claim.workspaceId, operationId: action.operation_id, origin,
            signal: input.signal,
            // Read-only intents are bounded by the Run worker's own lease deadline.
            ...(action.kind !== 'WRITE' && action.kind !== 'FILE_WRITE' ? await (async () => {
                const run = await repositories.runs.readRun(claim.runId);
                return run?.worker_lease_until === null || run === undefined ? {} : { deadline: run.worker_lease_until };
            })() : {}),
            hooks: { ...(input.afterAdmit === undefined ? {} : { afterAdmit: input.afterAdmit }),
                ...(input.afterFakeEffect === undefined ? {} : { afterFakeEffect: input.afterFakeEffect }) },
        });
    }
    catch (error) {
        return deniedBeforeInvocation(error, workerEpoch);
    }
    if (dispatched.status === 'SUCCEEDED') {
        await releaseGatewayWorker(db, { workspaceId: claim.workspaceId, runId: claim.runId,
            workerId: claim.workerId, workerEpoch, delivery });
    }
    else if (dispatched.status === 'FAILED' && action.kind !== 'WRITE') {
        return failedNoEffect(workerEpoch);
    }
    return { status: dispatched.status === 'SUCCEEDED' ? 'SUCCEEDED' : 'UNKNOWN',
        operationId: action.operation_id };
}
