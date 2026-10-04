import type { DbExecutor } from '../infrastructure/database.js';
import type { JsonObject } from '../infrastructure/json.js';
import type { RunToolCallRow } from '../infrastructure/database-schema.js';
import { claimGatewayWorker, claimRunForGateway, codeOf, dispatchGatewayAction,
  prepareGatewayAction, readGatewayOperation, releaseGatewayWorker,
  type GatewayOrigin } from '../application/gateway-actions.js';
import { applySafeControl } from '../application/control-requests.js';
import { gatewayParamsFor, resolveToolLoopPlan, toolTargetFor,
  type ToolLoopPlan } from '../application/tool-loop.js';
import { createRepositories } from '../application/unit-of-work.js';
import { readInternalTool, type InternalToolDefinition } from '../workflow/tool-catalog.js';
import { RunToolCallRepository } from '../run/run-tool-call-repository.js';
import type { ClaimedRunCommand } from '../application/run-dispatch.js';

/**
 * 一次模型工具请求的派发（docs/architecture/runtime-context.md §2.3）。
 *
 * 与固定动作链的 mock-gateway-action 同一形状：领取 → prepare → 派发 → 结算 → 释放。
 * 差别只有一处——动作身份不是 Delegate 冻结的，而是模型请求落库时产生的 run_tool_calls 行 id，
 * 因此重放永远回到同一个 Operation，不会因为模型再想一次就产生第二次执行。
 */

export type ToolLoopStepStatus = 'PREPARED' | 'WAITING' | 'SUCCEEDED' | 'FAILED' | 'UNKNOWN';

export interface ToolLoopStepResult {
  readonly status: ToolLoopStepStatus;
  readonly toolCallId: string;
  readonly operationId: string | null;
  readonly reviewId?: string;
}

export interface ExecuteToolLoopStepInput {
  readonly claim: ClaimedRunCommand;
  readonly toolCallId: string;
  readonly leaseMs?: number;
  readonly signal?: AbortSignal;
  /** 只读动作与 Worker 租约同期限：查询不会拖住下一次领取。 */
  readonly deadline?: Date | null;
  /** 图驱动时始终提供；直接驱动该步骤的测试可以省略，从而不伪造 run_commands 身份。 */
  readonly delivery?: { readonly commandId: string; readonly invocationEpoch: bigint };
}

export async function executeToolLoopStep(db: DbExecutor, input: ExecuteToolLoopStepInput,
): Promise<ToolLoopStepResult> {
  const { claim } = input;
  if (input.signal?.aborted === true) throw new Error('Tool loop step aborted before start');
  const repository = new RunToolCallRepository(db);
  const row = await repository.read(input.toolCallId);
  if (row === undefined || row.run_id !== claim.runId || row.workspace_id !== claim.workspaceId) {
    throw new Error('Tool loop request does not belong to this Run');
  }
  if (row.status === 'REJECTED' || row.status === 'ABANDONED') {
    return { status: 'SUCCEEDED', toolCallId: row.id, operationId: row.operation_id };
  }
  if (row.status === 'SETTLED') {
    return { status: 'SUCCEEDED', toolCallId: row.id, operationId: row.operation_id };
  }
  const plan = await resolveToolLoopPlan(db, claim.runId, claim.workspaceId);
  if (plan === undefined) throw new Error('Tool loop request has no frozen envelope on this Run');
  const definition = readInternalTool(row.tool_name);
  if (definition === undefined || !plan.allowed.has(row.tool_name)) {
    throw new Error('Tool loop request names a tool outside the frozen allow list');
  }
  const delivery = input.delivery;
  const origin = (workerEpoch: bigint): GatewayOrigin => ({ kind: 'RUN', runId: claim.runId,
    stepId: row.step_id, resourceId: plan.resourceId, workerId: claim.workerId, workerEpoch, ...(delivery === undefined ? {} : { delivery }) });

  let workerEpoch: bigint | undefined;
  let operationId = row.operation_id;
  if (operationId === null) {
    // 行 id 即动作身份：Gateway 的既有幂等分支因此保证同一请求只准备一次。
    operationId = row.id;
    workerEpoch = BigInt((await claimRunForGateway(db, { workspaceId: claim.workspaceId,
      runId: claim.runId, workerId: claim.workerId, ...(input.leaseMs === undefined ? {} : { leaseMs: input.leaseMs }), ...(delivery === undefined ? {} : { delivery }) })).worker_epoch);
    const prepared = await prepareToolAction(db, { workspaceId: claim.workspaceId, row,
      operationId, workerEpoch, plan, definition, origin: origin(workerEpoch),
      repository });
    if (prepared.kind === 'REFUSED') {
      // 准备阶段被拒的动作从来没有派发，因此该行落 REJECTED 而不是 SETTLED：
      // 它不连 Operation，模型下一轮看到类型化原因并自行收尾。
      await repository.reject(row.id,
        typeof prepared.resultRef.reason === 'string' ? prepared.resultRef.reason
          : 'GATEWAY_ACTION_DENIED',
        typeof prepared.resultRef.detail === 'string' ? prepared.resultRef.detail
          : '工具动作被准入拒绝。');
      await releaseWorkerIfHeld(db, claim, workerEpoch, delivery);
      await applySafeControl(db, claim.runId);
      return { status: 'FAILED', toolCallId: row.id, operationId: null };
    }
    if (prepared.status === 'WAITING_APPROVAL') {
      if (prepared.review_id === null) throw new Error('Tool loop wait has no Review');
      await repository.bindOperation(row.id, operationId, 'WAITING_APPROVAL');
      return { status: 'WAITING', toolCallId: row.id, operationId, reviewId: prepared.review_id };
    }
    await repository.bindOperation(row.id, operationId, 'PREPARED');
  } else {
    const operation = (await readGatewayOperation(db, claim.workspaceId, operationId)).operation;
    if (operation.status === 'WAITING_APPROVAL') {
      const review = await createRepositories(db).reviews.readByOperationId(operationId);
      if (review === undefined) throw new Error('Tool loop wait has no Review');
      return { status: 'WAITING', toolCallId: row.id, operationId, reviewId: review.id };
    }
    if (operation.status === 'SUCCEEDED' || operation.status === 'FAILED' ||
        operation.status === 'DENIED') {
      await repository.settle(row.id, operation.result_ref);
      return { status: operation.status === 'SUCCEEDED' ? 'SUCCEEDED' : 'FAILED',
        toolCallId: row.id, operationId };
    }
    if (operation.status === 'DISPATCHING' || operation.status === 'UNKNOWN') {
      return { status: 'UNKNOWN', toolCallId: row.id, operationId };
    }
    workerEpoch = BigInt((await claimGatewayWorker(db, { workspaceId: claim.workspaceId,
      operationId, workerId: claim.workerId, ...(input.leaseMs === undefined ? {} : { leaseMs: input.leaseMs }), ...(delivery === undefined ? {} : { delivery }) })).worker_epoch);
  }

  if (workerEpoch === undefined) throw new Error('Tool loop Worker claim is missing');
  let dispatched: Awaited<ReturnType<typeof dispatchGatewayAction>>;
  try {
    dispatched = await dispatchGatewayAction(db, { workspaceId: claim.workspaceId, operationId,
      origin: origin(workerEpoch), ...(input.signal === undefined ? {} : { signal: input.signal }), deadline: input.deadline ?? null });
  } catch (error) {
    // 派发前的授权拒绝同样可处理；DISPATCHING/UNKNOWN 不在这里处理，必须走恢复核对。
    if (isAuthorizationRefusal(codeOf(error))) {
      await repository.settle(row.id, { reason: codeOf(error) ?? 'GATEWAY_ACTION_DENIED',
        detail: error instanceof Error ? error.message : '工具动作被准入拒绝。' });
      await releaseWorkerIfHeld(db, claim, workerEpoch, delivery);
      await applySafeControl(db, claim.runId);
      return { status: 'FAILED', toolCallId: row.id, operationId };
    }
    throw error;
  }
  await repository.settle(row.id, dispatched.result_ref);
  if (dispatched.status === 'UNKNOWN') {
    return { status: 'UNKNOWN', toolCallId: row.id, operationId };
  }
  await releaseWorkerIfHeld(db, claim, workerEpoch, delivery);
  return { status: dispatched.status === 'SUCCEEDED' ? 'SUCCEEDED' : 'FAILED',
    toolCallId: row.id, operationId };
}

/**
 * 准备阶段的准入拒绝同样要让模型看见类型化原因。
 *
 * prepare 的拒绝发生在写任何 Operation 之前，因此这里没有副作用可核对；但已领取的
 * Worker claim 必须释放，否则下一次派发无法按 RUN 协议领取。
 */
async function prepareToolAction(db: DbExecutor, input: {
  readonly workspaceId: string;
  readonly row: RunToolCallRow;
  readonly operationId: string;
  readonly workerEpoch: bigint;
  readonly plan: ToolLoopPlan;
  readonly definition: InternalToolDefinition;
  readonly origin: GatewayOrigin;
  readonly repository: RunToolCallRepository;
}): Promise<{ readonly kind: 'REFUSED'; readonly resultRef: JsonObject }
| { readonly kind: 'ACCEPTED'; readonly status: 'PREPARED' | 'WAITING_APPROVAL';
    readonly review_id: string | null }> {
  try {
    const prepared = await prepareGatewayAction(db, {
      workspaceId: input.workspaceId, operationId: input.operationId,
      intentKey: `tool-loop-v1#${input.row.round}#${input.row.ordinal}`,
      connectionId: requireConnection(input.plan, input.definition.capability),
      origin: input.origin, actionType: input.definition.actionType,
      target: toolTargetFor(input.plan, input.definition, input.row.arguments),
      params: gatewayParamsFor(input.definition, input.row.arguments),
    });
    if (prepared.status !== 'WAITING_APPROVAL' && prepared.status !== 'PREPARED') {
      // prepare 只可能返回 PREPARED 或 WAITING_APPROVAL；其他状态说明契约被改动。
      throw new Error(`Unexpected Gateway prepare status ${prepared.status}`);
    }
    return { kind: 'ACCEPTED', status: prepared.status, review_id: prepared.review_id };
  } catch (error) {
    if (!isAuthorizationRefusal(codeOf(error))) throw error;
    return { kind: 'REFUSED', resultRef: { reason: codeOf(error) ?? 'GATEWAY_ACTION_DENIED',
      detail: error instanceof Error ? error.message : '工具动作被准入拒绝。' } };
  }
}

/** 只释放仍由本次派发持有的 Worker claim；已被恢复路径 fence 的旧 claim 不动。 */
async function releaseWorkerIfHeld(db: DbExecutor, claim: ClaimedRunCommand, workerEpoch: bigint,
  delivery: { readonly commandId: string; readonly invocationEpoch: bigint } | undefined): Promise<void> {
  const run = await createRepositories(db).runs.readRun(claim.runId);
  if (run?.worker_id !== claim.workerId || run.worker_epoch !== workerEpoch) return;
  await releaseGatewayWorker(db, { workspaceId: claim.workspaceId, runId: claim.runId,
    workerId: claim.workerId, workerEpoch, ...(delivery === undefined ? {} : { delivery }) });
}

const AUTHORIZATION_REFUSALS = new Set([
  'GATEWAY_PERMISSION_DENIED', 'GATEWAY_PERMISSION_STALE', 'GATEWAY_CONNECTION_STALE',
  'GATEWAY_TARGET_DENIED', 'GATEWAY_ORIGIN_DENIED', 'GATEWAY_RESOURCE_NOT_FOUND',
  'GATEWAY_APPROVAL_STALE', 'GATEWAY_CONTEXT_STALE', 'VALIDATION_FAILED',
]);

/** 只把「在派发之前就确定被拒」当作可处理结果；其余异常仍须走核对或抛出。 */
export function isAuthorizationRefusal(code: string | undefined): boolean {
  return code !== undefined && AUTHORIZATION_REFUSALS.has(code);
}

/** 冻结信封已保证每个允许工具都有连接；缺连接说明快照与词表不一致，不能猜一个。 */
function requireConnection(plan: { readonly intent: { readonly connections:
  Readonly<Record<string, string>> } }, capability: string): string {
  const connectionId = plan.intent.connections[capability];
  if (connectionId === undefined) {
    throw new Error(`Tool loop envelope has no connection for capability ${capability}`);
  }
  return connectionId;
}