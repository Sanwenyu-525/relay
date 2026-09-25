import { Annotation, Command, END, START, StateGraph, interrupt } from '@langchain/langgraph';
import { PostgresSaver } from '@langchain/langgraph-checkpoint-postgres';
import { sql } from 'kysely';

import type { AdvanceRunStepResult } from '../application/run-steps.js';
import { advanceRunStep } from '../application/run-steps.js';
import type { ClaimedRunCommand } from '../application/run-dispatch.js';
import type { DbExecutor } from '../infrastructure/database.js';
import { GRAPH_CHECKPOINT_SCHEMA } from '../infrastructure/graph-checkpoints.js';
import { ManagedContentStore } from '../storage/managed-content-store.js';
import { createRepositories } from '../application/unit-of-work.js';
import { readMockGatewayAction } from '../workflow/execution-contract.js';
import { executeMockGatewayStep, type MockGatewayStepResult } from './mock-gateway-action.js';

const RunGraphState = Annotation.Root({
  runId: Annotation<string>(),
  lastStatus: Annotation<string>(),
  runStatus: Annotation<string>(),
  operationId: Annotation<string>(),
  reviewId: Annotation<string>(),
  reviewKind: Annotation<string>(),
});

const REPEAT = new Set(['RETRYABLE', 'REPLAYED', 'CORRECTION_SCHEDULED']);
const TERMINAL = new Set(['COMPLETED', 'FAILED', 'CANCELLED']);

export class RunGraphInvocationLost extends Error {
  override readonly name = 'RunGraphInvocationLost';
}

export interface GraphDeliveryOutcome {
  readonly settlement: 'DONE' | 'BLOCKED';
  readonly holdForRecovery: boolean;
}

/** One versioned root graph per Run. Business facts remain in Relay tables. */
export async function executeClaimedRunGraph(db: DbExecutor, input: {
  claim: ClaimedRunCommand;
  checkpointUrl: string;
  dataRoot: string;
  leaseMs: number;
  maxSteps: number;
  signal: AbortSignal;
  fakeModelDelayMs?: number;
  afterStep?: (step: AdvanceRunStepResult, claim: ClaimedRunCommand) => Promise<void>;
  afterGatewayPrepared?: (result: MockGatewayStepResult, claim: ClaimedRunCommand) => Promise<void>;
  afterGatewayAdmit?: (claim: ClaimedRunCommand) => Promise<void>;
  afterGatewayFakeEffect?: (claim: ClaimedRunCommand) => Promise<void>;
}): Promise<GraphDeliveryOutcome> {
  const saver = PostgresSaver.fromConnString(input.checkpointUrl, { schema: GRAPH_CHECKPOINT_SCHEMA });
  let steps = 0;
  try {
    const graph = new StateGraph(RunGraphState)
      .addNode('advance', async (state) => {
        if (input.signal.aborted) throw new RunGraphInvocationLost();
        const result = await advanceRunStep(db, {
          runId: state.runId, workerId: input.claim.workerId,
          invocationEpoch: input.claim.epoch,
          storage: new ManagedContentStore(input.dataRoot),
          leaseMs: input.leaseMs, signal: input.signal,
          ...(input.fakeModelDelayMs === undefined ? {} : { fakeModelDelayMs: input.fakeModelDelayMs }),
        });
        steps += 1;
        await input.afterStep?.(result, input.claim);
        if (input.signal.aborted || result.status === 'INVOCATION_LOST' ||
            result.status === 'STALE_RESULT' ||
            !(await createRepositories(db).dispatch.hasCurrentInvocation(state.runId,
              input.claim.workerId, input.claim.epoch))) throw new RunGraphInvocationLost();
        const waiting = result.status === 'WAITING_REVIEW' ||
          (result.status === 'STEP_SUCCEEDED' && result.run_status === 'WAITING_APPROVAL');
        const openReview = waiting ? await openValidationReview(db, state.runId) : undefined;
        return {
          lastStatus: openReview ? 'WAITING_REVIEW' :
            waiting ? 'WAITING_WITHOUT_VALIDATION_REVIEW' : result.status,
          runStatus: result.status === 'STEP_SUCCEEDED' ? result.run_status : '',
          operationId: result.status === 'GATEWAY_ACTION_REQUIRED' ? result.operation_id : '',
          reviewId: openReview?.id ?? '', reviewKind: openReview?.kind ?? '',
        };
      })
      .addNode('gatewayAction', async (state) => {
        if (input.signal.aborted) throw new RunGraphInvocationLost();
        const result = await executeMockGatewayStep(db, {
          claim: input.claim, leaseMs: input.leaseMs, signal: input.signal,
          ...(input.afterGatewayPrepared === undefined ? {} : {
            afterPrepared: (prepared: MockGatewayStepResult) =>
              input.afterGatewayPrepared!(prepared, input.claim),
          }),
          ...(input.afterGatewayFakeEffect === undefined ? {} : {
            afterFakeEffect: () => input.afterGatewayFakeEffect!(input.claim),
          }),
          ...(input.afterGatewayAdmit === undefined ? {} : {
            afterAdmit: () => input.afterGatewayAdmit!(input.claim),
          }),
        });
        if (input.signal.aborted ||
            !(await createRepositories(db).dispatch.hasCurrentCommandInvocation(
              state.runId, input.claim.commandId, input.claim.workerId, input.claim.epoch))) {
          throw new RunGraphInvocationLost();
        }
        return { operationId: result.operationId,
          reviewId: result.status === 'WAITING' ? result.reviewId ?? '' : '',
          reviewKind: result.status === 'WAITING' ? 'ACTION_APPROVAL' : '',
          lastStatus: result.status === 'WAITING' ? 'GATEWAY_WAITING' :
            result.status === 'SUCCEEDED' ? 'GATEWAY_SUCCEEDED' :
              result.status === 'UNKNOWN' ? 'ACTION_UNKNOWN' : 'GATEWAY_ACTION_DENIED' };
      })
      .addNode('awaitCommand', (state) => {
        // Keep the interrupt before any business action: this node re-enters on
        // Command.resume, and only the original claimed RESUME may wake it.
        const resumed: unknown = interrupt({ run_id: state.runId, reason: 'VALIDATION_REVIEW',
          review_id: state.reviewId, review_kind: state.reviewKind });
        if (typeof resumed !== 'object' || resumed === null ||
            !('command_id' in resumed) || resumed.command_id !== input.claim.commandId ||
            !('review_decision_id' in resumed) ||
            resumed.review_decision_id !== input.claim.reviewDecisionId ||
            !('review_id' in resumed) || resumed.review_id !== state.reviewId) {
          throw new Error('Run graph Review resume identity mismatch');
        }
        return { lastStatus: 'RESUMED' };
      })
      .addNode('awaitAction', (state) => {
        const resumed: unknown = interrupt({ run_id: state.runId,
          reason: 'ACTION_APPROVAL', operation_id: state.operationId,
          review_id: state.reviewId });
        if (typeof resumed !== 'object' || resumed === null ||
            !('command_id' in resumed) || resumed.command_id !== input.claim.commandId ||
            !('review_decision_id' in resumed) ||
            resumed.review_decision_id !== input.claim.reviewDecisionId ||
            !('review_id' in resumed) || resumed.review_id !== state.reviewId ||
            !('operation_id' in resumed) || resumed.operation_id !== state.operationId) {
          throw new Error('Run graph action approval resume identity mismatch');
        }
        return { lastStatus: 'ACTION_RESUMED' };
      })
      .addEdge(START, 'advance')
      .addConditionalEdges('advance', (state) => {
        if (state.lastStatus === 'WAITING_REVIEW') return 'awaitCommand';
        if (state.lastStatus === 'GATEWAY_ACTION_REQUIRED') return 'gatewayAction';
        if (REPEAT.has(state.lastStatus) || state.lastStatus === 'STEP_SUCCEEDED') {
          if (TERMINAL.has(state.runStatus)) return END;
          return steps >= input.maxSteps ? END : 'advance';
        }
        return END;
      })
      .addEdge('awaitCommand', 'advance')
      .addConditionalEdges('gatewayAction', (state) => {
        if (state.lastStatus === 'GATEWAY_WAITING') return 'awaitAction';
        if (state.lastStatus === 'GATEWAY_SUCCEEDED') return 'advance';
        return END;
      })
      .addEdge('awaitAction', 'gatewayAction')
      .compile({ checkpointer: saver });
    const config = { configurable: { thread_id: input.claim.runId }, durability: 'sync' as const,
      recursionLimit: Math.max(10, input.maxSteps * 2 + 8), signal: input.signal };
    const snapshot = await graph.getState(config);
    if (input.signal.aborted) throw new RunGraphInvocationLost();
    const interrupted = snapshot.tasks.some((task) => task.interrupts.length > 0);
    if (interrupted && input.claim.kind !== 'RESUME') {
      // A START that crashed after saving its wait has already reached its
      // durable barrier; it may acknowledge without executing the successor.
      return { settlement: 'DONE', holdForRecovery: false };
    }
    if (interrupted) {
      if (input.claim.reviewDecisionId === null ||
          snapshot.values.reviewId === '') {
        throw new Error('Run graph Review interrupt has no bound Review');
      }
      if (!(await validReviewResume(db, input.claim, snapshot.values.reviewId,
        snapshot.values.reviewKind, snapshot.values.operationId))) {
        if (await isPriorReviewDecision(db, input.claim, snapshot.values.reviewId)) {
          return { settlement: 'DONE', holdForRecovery: false };
        }
        throw new Error('Run graph Review resume is no longer valid');
      }
      await graph.invoke(new Command({ resume: { command_id: input.claim.commandId,
        review_decision_id: input.claim.reviewDecisionId,
        review_id: snapshot.values.reviewId,
        operation_id: snapshot.values.operationId } }), config);
    } else if (snapshot.next.length > 0) {
      await graph.invoke(null, config);
    } else {
      await graph.invoke({ runId: input.claim.runId, lastStatus: '', runStatus: '',
        operationId: '', reviewId: '', reviewKind: '' }, config);
    }
    if (input.signal.aborted) throw new RunGraphInvocationLost();
    const final = await graph.getState(config);
    if (input.signal.aborted) throw new RunGraphInvocationLost();
    if (final.tasks.some((task) => task.interrupts.length > 0)) {
      return { settlement: 'DONE', holdForRecovery: false };
    }
    const status = final.values.lastStatus;
    if (!TERMINAL.has(final.values.runStatus) &&
        (REPEAT.has(status) || status === 'STEP_SUCCEEDED') && steps >= input.maxSteps) {
      return { settlement: 'BLOCKED', holdForRecovery: false };
    }
    const blocked = status === 'ACTION_UNKNOWN' || status === 'CLAIM_CONFLICT' ||
      status === 'STALE_OWNERSHIP' || status === 'STEP_NOT_IMPLEMENTED';
    return { settlement: blocked ? 'BLOCKED' : 'DONE',
      holdForRecovery: status === 'ACTION_UNKNOWN' || status === 'CLAIM_CONFLICT' };
  } finally {
    await saver.end();
  }
}

async function openValidationReview(db: DbExecutor, runId: string): Promise<{
  id: string; kind: string;
} | undefined> {
  const rows = await sql<{ id: string; kind: string }>`
    select id, kind from review_requests where run_id = ${runId}
      and status = 'OPEN' and kind in ('CRITERION', 'RETRY_BUDGET', 'CHECKER_RETRY')
      and (expires_at is null or expires_at > clock_timestamp())
    order by created_at, id limit 1
  `.execute(db);
  return rows.rows[0];
}

async function validReviewResume(db: DbExecutor, claim: ClaimedRunCommand,
  reviewId: string, reviewKind: string, interruptedOperationId: string): Promise<boolean> {
  if (!['CRITERION', 'RETRY_BUDGET', 'CHECKER_RETRY', 'ACTION_APPROVAL'].includes(reviewKind)) {
    return false;
  }
  if ((reviewKind === 'ACTION_APPROVAL') !== (interruptedOperationId !== '')) return false;
  if (interruptedOperationId !== '') {
    const contract = await createRepositories(db).runs.readContract(claim.runId);
    const frozen = contract === undefined ? undefined : readMockGatewayAction(contract.frozen_snapshot);
    if (frozen?.operation_id !== interruptedOperationId) return false;
  }
  const rows = await sql<{ exists: boolean }>`
    select exists(select 1 from run_commands c
      join review_decisions d on d.id = c.review_decision_id
      join review_requests r on r.id = d.review_id
      left join logical_operations o on o.id = r.operation_id
      where c.id = ${claim.commandId} and c.run_id = ${claim.runId}
        and c.review_decision_id = ${claim.reviewDecisionId}
        and r.id = ${reviewId} and r.kind = ${reviewKind}
        and r.run_id = ${claim.runId} and r.status = 'DECIDED'
        and ((r.kind in ('CRITERION', 'RETRY_BUDGET', 'CHECKER_RETRY')
              and ${interruptedOperationId} = '') or
          (r.kind = 'ACTION_APPROVAL' and d.decision = 'APPROVE'
            and o.id::text = ${interruptedOperationId} and o.run_id = ${claim.runId}
            and o.status in ('WAITING_APPROVAL', 'PREPARED', 'SUCCEEDED')
            and (o.status = 'SUCCEEDED' or r.expires_at is null
              or r.expires_at > clock_timestamp())))
        and r.target_hash = d.target_hash) as exists
  `.execute(db);
  return rows.rows[0]?.exists === true;
}

async function isPriorReviewDecision(db: DbExecutor, claim: ClaimedRunCommand,
  currentReviewId: string): Promise<boolean> {
  if (claim.reviewDecisionId === null) return false;
  const rows = await sql<{ prior: boolean }>`
    select exists(select 1 from review_decisions decision
      join review_requests old_review on old_review.id = decision.review_id
      left join logical_operations old_operation on old_operation.id = old_review.operation_id
      join review_requests current_review on current_review.id = ${currentReviewId}
      where decision.id = ${claim.reviewDecisionId}
        and old_review.run_id = ${claim.runId} and old_review.status = 'DECIDED'
        and current_review.run_id = ${claim.runId}
        and current_review.id <> old_review.id
        and decision.decided_at < current_review.created_at
        and (old_review.kind <> 'ACTION_APPROVAL' or
          (decision.decision = 'APPROVE' and old_operation.status = 'SUCCEEDED'))
    ) as prior
  `.execute(db);
  return rows.rows[0]?.prior === true;
}
