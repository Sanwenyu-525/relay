import type { DbExecutor } from '../infrastructure/database.js';
import type { AdvanceRunStepResult } from '../application/run-steps.js';
import {
  claimNextRunCommand, renewRunInvocation, settleRunCommand,
  type ClaimedRunCommand,
} from '../application/run-dispatch.js';
import { createRepositories } from '../application/unit-of-work.js';
import { executeClaimedRunGraph, RunGraphInvocationLost } from './run-graph.js';
import type { MockGatewayStepResult } from './mock-gateway-action.js';

const MAX_GRAPH_STEPS_PER_DELIVERY = 32;
const CONTROL_POLL_MS = 100;

export interface WorkerDeliveryResult {
  readonly commandId: string;
  readonly runId: string;
  readonly outcome: 'DONE' | 'BLOCKED' | 'LOST';
}

/** A durable delivery invokes the one persisted Run graph. */
export async function runOneCommand(db: DbExecutor, input: {
  workerId: string; dataRoot: string; checkpointUrl: string;
  leaseMs?: number; signal?: AbortSignal;
  maxSteps?: number;
  fakeModelDelayMs?: number;
  onClaim?: (claim: ClaimedRunCommand) => Promise<void>;
  afterStep?: (step: AdvanceRunStepResult, claim: ClaimedRunCommand) => Promise<void>;
  afterGraph?: (claim: ClaimedRunCommand) => Promise<void>;
  afterGatewayPrepared?: (result: MockGatewayStepResult, claim: ClaimedRunCommand) => Promise<void>;
  afterGatewayAdmit?: (claim: ClaimedRunCommand) => Promise<void>;
  afterGatewayFakeEffect?: (claim: ClaimedRunCommand) => Promise<void>;
}): Promise<WorkerDeliveryResult | undefined> {
  const leaseMs = input.leaseMs ?? 30_000;
  if (input.signal?.aborted) return undefined;
  const controller = new AbortController();
  const onAbort = (): void => controller.abort();
  input.signal?.addEventListener('abort', onAbort, { once: true });
  if (input.signal?.aborted) controller.abort();
  let heartbeat: NodeJS.Timeout | undefined;
  let controlPoll: NodeJS.Timeout | undefined;
  let renewal: Promise<void> | undefined;
  let controlCheck: Promise<void> | undefined;
  try {
    if (controller.signal.aborted) return undefined;
    const claim = await claimNextRunCommand(db, input.workerId, leaseMs);
    if (claim === undefined) return undefined;
    // The signal may fire while the PostgreSQL claim commits. No step or effect
    // has started; the supervisor will requeue this claim after child close.
    if (controller.signal.aborted) {
      return { commandId: claim.commandId, runId: claim.runId, outcome: 'LOST' };
    }
    await input.onClaim?.(claim);
    if (controller.signal.aborted) {
      return { commandId: claim.commandId, runId: claim.runId, outcome: 'LOST' };
    }

    let lost = false;
    heartbeat = setInterval(() => {
      if (renewal !== undefined || lost) return;
      renewal = renewRunInvocation(db, claim, leaseMs).then((ok) => {
        if (!ok) { lost = true; controller.abort(); }
      }).catch(() => {
        lost = true;
        controller.abort();
      }).finally(() => { renewal = undefined; });
    }, Math.max(100, Math.floor(leaseMs / 3)));

    controlPoll = setInterval(() => {
      if (controlCheck !== undefined || controller.signal.aborted) return;
      controlCheck = createRepositories(db).recovery.findPendingControl(claim.runId).then((pending) => {
        if (pending !== undefined) controller.abort();
      }).catch(() => {
        // Database uncertainty stops the local invocation; the supervisor must
        // witness child exit before it can release or requeue the claim.
        controller.abort();
      }).finally(() => { controlCheck = undefined; });
    }, CONTROL_POLL_MS);

    let graphResult: Awaited<ReturnType<typeof executeClaimedRunGraph>>;
    try {
      graphResult = await executeClaimedRunGraph(db, {
        claim, checkpointUrl: input.checkpointUrl, dataRoot: input.dataRoot,
        leaseMs, maxSteps: input.maxSteps ?? MAX_GRAPH_STEPS_PER_DELIVERY,
        signal: controller.signal,
        ...(input.fakeModelDelayMs === undefined ? {} : { fakeModelDelayMs: input.fakeModelDelayMs }),
        ...(input.afterStep === undefined ? {} : { afterStep: input.afterStep }),
        ...(input.afterGatewayPrepared === undefined ? {} : {
          afterGatewayPrepared: input.afterGatewayPrepared,
        }),
        ...(input.afterGatewayAdmit === undefined ? {} : {
          afterGatewayAdmit: input.afterGatewayAdmit,
        }),
        ...(input.afterGatewayFakeEffect === undefined ? {} : {
          afterGatewayFakeEffect: input.afterGatewayFakeEffect,
        }),
      });
    } catch (error) {
      if (error instanceof RunGraphInvocationLost || lost || controller.signal.aborted) {
        return { commandId: claim.commandId, runId: claim.runId, outcome: 'LOST' };
      }
      throw error;
    }
    await input.afterGraph?.(claim);
    if (lost || controller.signal.aborted) return { commandId: claim.commandId, runId: claim.runId, outcome: 'LOST' };
    if (!(await settleRunCommand(db, claim, graphResult.settlement, graphResult.holdForRecovery))) {
      return { commandId: claim.commandId, runId: claim.runId, outcome: 'LOST' };
    }
    return { commandId: claim.commandId, runId: claim.runId, outcome: graphResult.settlement };
  } finally {
    if (heartbeat !== undefined) clearInterval(heartbeat);
    if (controlPoll !== undefined) clearInterval(controlPoll);
    await Promise.all([renewal, controlCheck]);
    input.signal?.removeEventListener('abort', onAbort);
  }
}
