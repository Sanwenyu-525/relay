import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';

import { sql } from 'kysely';
import { isNormalCliFailure } from '../cli-worker/cli-adapter.js';

import type { DbExecutor } from '../infrastructure/database.js';
import type { JsonObject } from '../infrastructure/json.js';
import type { RunToolCallRow } from '../infrastructure/database-schema.js';
import { claimGatewayWorker, claimRunForGateway, codeOf, denyGraphActionBeforeInvocation,
  dispatchGatewayAction, prepareGatewayAction, readGatewayOperation, releaseGatewayWorker,
  type GatewayOrigin } from '../application/gateway-actions.js';
import { applySafeControl } from '../application/control-requests.js';
import { gatewayParamsFor, resolveToolLoopPlan, toolTargetFor, ToolRequestRejected,
  type ToolLoopPlan } from '../application/tool-loop.js';
import { resolveFrozenCheck, RunScopeGrantRepository, type FrozenCheck }
  from '../application/run-scope-grant.js';
import { createRepositories, withTransaction } from '../application/unit-of-work.js';
import { lockTaskAndRun } from '../application/lock-task-run.js';
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

export type ToolLoopStepStatus =
  'PREPARED' | 'WAITING' | 'SUCCEEDED' | 'FAILED' | 'CHECK_FAILED' | 'UNKNOWN' | 'STOPPED';

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
    if (row.status === 'REJECTED' &&
      (row.result_ref as { readonly reason?: unknown } | null)?.reason === 'RUN_TERMINAL') {
      return { status: 'STOPPED', toolCallId: row.id, operationId: row.operation_id };
    }
    return { status: 'SUCCEEDED', toolCallId: row.id, operationId: row.operation_id };
  }
  if (row.status === 'SETTLED') {
    if (row.operation_id === null) return { status: 'FAILED', toolCallId: row.id, operationId: null };
    const operation = (await readGatewayOperation(db, claim.workspaceId, row.operation_id)).operation;
    return { status: await settledToolStatus(db, row, operation.status, operation.result_ref),
      toolCallId: row.id, operationId: row.operation_id };
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
    try {
      workerEpoch = BigInt((await claimRunForGateway(db, { workspaceId: claim.workspaceId,
        runId: claim.runId, workerId: claim.workerId,
        ...(input.leaseMs === undefined ? {} : { leaseMs: input.leaseMs }),
        ...(delivery === undefined ? {} : { delivery }) })).worker_epoch);
    } catch (error) {
      // 用户按了暂停/取消/交接，或 Run 已离开可执行状态：派发前就被挡住，一个字节都不写。
      // 这是一次人为停止，不是动作被准入拒绝，因此给独立状态而不是未分类异常或 DENIED。
      if (codeOf(error) !== 'GATEWAY_RUN_NOT_READY') throw error;
      // 暂停可恢复：请求行保持 REQUESTED，恢复后仍走同一个动作身份，不会派生第二次写入。
      // 取消/失败/完成是终态，不会再恢复。此时必须给遗留请求一个终态归属，否则它会永远停在
      // REQUESTED，在历史里看起来仍是一个可能完成的悬空请求（旧 Worker 与取消同时到达时就会这样）。
      await rejectToolCallIfRunTerminal(db, repository, row);
      return { status: 'STOPPED', toolCallId: row.id, operationId: null };
    }
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
      // 已决定且批准的单动作审批必须继续执行，不能再报「仍在等待」：否则批准之后
      // 永远停在 WAITING_APPROVAL，用户看不出工具到底跑没跑。判定沿用固定动作链的
      // 同一条绑定规则（本次 RESUME 命令 + 该决定 + Review 的确切 operation 与 target_hash），
      // 不在这里放宽成「Review 处于 DECIDED 就算批准」。
      const approved = await approvedToolResume(db, claim, operationId);
      if (!approved) {
        return { status: 'WAITING', toolCallId: row.id, operationId, reviewId: review.id };
      }
      // 恢复也要复核批准当时绑定的材料：材料在批准之后被换掉时，领取 Worker 这一步
      // 就已经能挡住，不必等到真正派发。拒绝按与派发同一口径落成类型化原因。
      try {
        workerEpoch = BigInt((await claimGatewayWorker(db, { workspaceId: claim.workspaceId,
          operationId, workerId: claim.workerId,
          ...(input.leaseMs === undefined ? {} : { leaseMs: input.leaseMs }),
          ...(delivery === undefined ? {} : { delivery }) })).worker_epoch);
      } catch (error) {
        if (!isAuthorizationRefusal(codeOf(error))) throw error;
        // 领取失败时事务已回滚，本次没有持有任何 Worker claim。
        if (await deniedBeforeInvocation(db, { claim, row, operationId,
          resourceId: plan.resourceId, delivery, error })) {
          return { status: 'FAILED', toolCallId: row.id, operationId };
        }
        throw error;
      }
    } else if (operation.status === 'SUCCEEDED' || operation.status === 'FAILED' ||
        operation.status === 'DENIED') {
      await repository.settle(row.id, operation.result_ref);
      return { status: await settledToolStatus(db, row, operation.status, operation.result_ref),
        toolCallId: row.id, operationId };
    } else if (operation.status === 'DISPATCHING' || operation.status === 'UNKNOWN') {
      return { status: 'UNKNOWN', toolCallId: row.id, operationId };
    } else {
      workerEpoch = BigInt((await claimGatewayWorker(db, { workspaceId: claim.workspaceId,
        operationId, workerId: claim.workerId,
        ...(input.leaseMs === undefined ? {} : { leaseMs: input.leaseMs }),
        ...(delivery === undefined ? {} : { delivery }) })).worker_epoch);
    }
  }

  if (workerEpoch === undefined) throw new Error('Tool loop Worker claim is missing');
  let dispatched: Awaited<ReturnType<typeof dispatchGatewayAction>>;
  try {
    // 派发时复核可执行入口摘要；args 指向的脚本正文尚不在该摘要覆盖内。
    const check = definition.actionType === 'CLI_RUN'
      ? await resolveToolCheck(db, claim.runId, row.arguments) : undefined;
    dispatched = await dispatchGatewayAction(db, { workspaceId: claim.workspaceId, operationId,
      origin: origin(workerEpoch), ...(input.signal === undefined ? {} : { signal: input.signal }),
      deadline: input.deadline ?? null,
      ...(check === undefined ? {} : { scopeCheck: check,
        observedExecutableSha256: await sha256OfFile(check.executable) }) });
  } catch (error) {
    // 派发前的授权拒绝同样可处理；DISPATCHING/UNKNOWN 不在这里处理，必须走恢复核对。
    if (isAuthorizationRefusal(codeOf(error))) {
      if (await deniedBeforeInvocation(db, { claim, row, operationId,
        resourceId: plan.resourceId, delivery,
        ...(workerEpoch === undefined ? {} : { workerEpoch }), error })) {
        return { status: 'FAILED', toolCallId: row.id, operationId };
      }
    }
    throw error;
  }
  if (dispatched.status === 'UNKNOWN') {
    return { status: 'UNKNOWN', toolCallId: row.id, operationId };
  }
  await repository.settle(row.id, dispatched.result_ref);
  await releaseWorkerIfHeld(db, claim, workerEpoch, delivery);
  return { status: await settledToolStatus(db, { ...row, operation_id: operationId },
    dispatched.status, dispatched.result_ref),
    toolCallId: row.id, operationId };
}

/**
 * 已终止的 Run 不会再交回它遗留的工具请求。
 *
 * 暂停不是终态，请求行保持 REQUESTED 以便恢复；但取消、失败、完成是终态，恢复入口
 * 明确拒绝它们。若旧 Worker 拿着一个尚未派发的请求走到这里而 Run 已经终止，就必须把
 * 这一行落成 REJECTED 并带上类型化原因：既证明「未派发、未落盘」，又给历史一个可读的
 * 终态归属，而不是留一条永远 REQUESTED、看起来仍可完成的悬空请求。约束要求未连
 * Operation 的行只能落 REQUESTED/REJECTED，所以这里用 reject 而不是 abandon。
 * 准备与绑定之间的竞态会在 logical_operations 留下同 id 的行，此时跳过，走既有
 * 停止与核对流程，不误拒绝已准备/已执行。Task→Run 锁序与控制收口一致，幂等。
 */
async function rejectToolCallIfRunTerminal(db: DbExecutor, repository: RunToolCallRepository,
  row: RunToolCallRow): Promise<void> {
  await withTransaction(db, async (repositories) => {
    const locked = await lockTaskAndRun(repositories, row.run_id, row.workspace_id);
    const run = locked.run;
    if (run.status !== 'COMPLETED' && run.status !== 'FAILED' && run.status !== 'CANCELLED') return;
    await repositories.toolCalls.rejectUndispatchedForTerminalRun(row.run_id, run.status);
  });
}

/**
 * 派发前被确定性拒绝的动作必须沿领域入口收口，而不是只结算工具行。
 *
 * 只落一条类型化原因会留下「已结算的工具行 ＋ 仍等待批准的 Operation ＋ 已 DECIDED 的
 * Review」：原 Run 已被命令队列判定为不可领取，`advanceRunStep` 又会把这条零 Invocation 的
 * 动作投影成 ACTION_UNKNOWN，原 Task 就此悬空。固定动作链对同一类拒绝用的是
 * `denyGraphActionBeforeInvocation`，工具循环在这里复用同一个入口，不新建第二套状态语义。
 *
 * 该入口只在能证明未执行时成立：它要求 Operation 仍处于 WAITING_APPROVAL/PREPARED，且最后
 * 一次 Invocation 只可能是 PREPARED/NOT_EXECUTED。DISPATCHING/UNKNOWN 走不通这里，仍必须
 * 走既有核对与隔离流程。
 *
 * 返回 false 表示本次不属于本 Worker 的确定性拒绝（例如已有待处理控制）：此时调用方继续
 * 抛出原异常，不谎称已经安全结束。
 */
async function deniedBeforeInvocation(db: DbExecutor, input: {
  readonly claim: ClaimedRunCommand;
  readonly row: RunToolCallRow;
  readonly operationId: string;
  readonly resourceId: string;
  readonly delivery: { readonly commandId: string; readonly invocationEpoch: bigint } | undefined;
  readonly workerEpoch?: bigint;
  readonly error: unknown;
}): Promise<boolean> {
  const code = codeOf(input.error) ?? 'GATEWAY_ACTION_DENIED';
  const denied = await denyGraphActionBeforeInvocation(db, {
    workspaceId: input.claim.workspaceId, runId: input.claim.runId,
    operationId: input.operationId, resourceId: input.resourceId,
    workerId: input.claim.workerId,
    ...(input.workerEpoch === undefined ? {} : { workerEpoch: input.workerEpoch }),
    ...(input.delivery === undefined ? {} : { delivery: input.delivery }),
    toolCall: { id: input.row.id, resultRef: { reason: code,
      detail: input.error instanceof Error ? input.error.message : '工具动作被准入拒绝。' } },
    reason: code,
  });
  if (denied) await applySafeControl(db, input.claim.runId);
  return denied;
}

/** Replaying a settled row must preserve the original outcome, including quarantine. */
async function settledToolStatus(db: DbExecutor, row: RunToolCallRow, status: string,
  result: JsonObject | null): Promise<ToolLoopStepStatus> {
  if (status === 'UNKNOWN' || status === 'DISPATCHING') return 'UNKNOWN';
  if (status === 'SUCCEEDED') return 'SUCCEEDED';
  if (status !== 'FAILED' || row.tool_name !== 'run_check' || !isNormalCliFailure(result) ||
      result?.operation_id !== row.operation_id || typeof result.invocation_id !== 'string') return 'FAILED';
  const repositories = createRepositories(db);
  const invocation = await repositories.gateway.readInvocation(result.invocation_id);
  if (invocation?.operation_id !== row.operation_id || invocation.status !== 'FAILED' ||
      invocation.resource_claim_id === null) return 'FAILED';
  const claim = await repositories.gateway.readClaim(invocation.resource_claim_id);
  return claim?.status === 'RELEASED' ? 'CHECK_FAILED' : 'FAILED';
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
    // run_check 只能按冻结清单里的 check_id 执行：模型不能自带可执行程序或参数，
    // 也不能靠改名绕过命令配置。清单里没有就拒绝，不做模糊匹配。
    const check = input.definition.actionType === 'CLI_RUN' && input.origin.kind === 'RUN'
      ? await resolveToolCheck(db, input.origin.runId, input.row.arguments) : undefined;
    // 准备阶段也要实测程序摘要，否则授权复核会因为「没有实测值」而一律判定配置已变，
    // 已配置检查就永远退不出一致性核对。
    const observed = check === undefined ? undefined : await sha256OfFile(check.executable);
    const prepared = await prepareGatewayAction(db, {
      workspaceId: input.workspaceId, operationId: input.operationId,
      intentKey: `tool-loop-v1#${input.row.round}#${input.row.ordinal}`,
      connectionId: requireConnection(input.plan, input.definition.capability),
      origin: input.origin, actionType: input.definition.actionType,
      target: toolTargetFor(input.plan, input.definition, input.row.arguments, input.origin),
      params: resolveToolParams(input.definition, input.row.arguments, check),
      ...(check === undefined ? {} : { scopeCheck: check, observedExecutableSha256: observed }),
    });
    if (prepared.status !== 'WAITING_APPROVAL' && prepared.status !== 'PREPARED') {
      // prepare 只可能返回 PREPARED 或 WAITING_APPROVAL；其他状态说明契约被改动。
      throw new Error(`Unexpected Gateway prepare status ${prepared.status}`);
    }
    return { kind: 'ACCEPTED', status: prepared.status, review_id: prepared.review_id };
  } catch (error) {
    // 工具参数不合法（检查未配置、check_id 缺失）与准入拒绝一样处理：作为一次
    // 类型化拒绝回到模型，而不是让 Worker 抛出未知异常。两者都不留下 Operation。
    if (error instanceof ToolRequestRejected) {
      return { kind: 'REFUSED', resultRef: { reason: error.reason, detail: error.message } };
    }
    if (!isAuthorizationRefusal(codeOf(error))) throw error;
    return { kind: 'REFUSED', resultRef: { reason: codeOf(error) ?? 'GATEWAY_ACTION_DENIED',
      detail: error instanceof Error ? error.message : '工具动作被准入拒绝。' } };
  }
}

/**
 * 本次 RESUME 是否确实批准了「这一个」动作。
 *
 * 与固定动作链的 `approvedResume` 同一绑定：本次命令、该命令携带的决定、Review 的
 * `operation_id` 与 `target_hash` 必须同时对上。缺任何一项都仍然算等待——批准不能
 * 被另一个 Review 或另一次 Resume 借用。
 */
async function approvedToolResume(db: DbExecutor, claim: ClaimedRunCommand,
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

/**
 * 实测可执行程序（或脚本入口）的内容摘要。
 *
 * 授权时冻结一份、派发时实测一份：两者不同就说明脚本或构建配置在授权之后被改过，
 * 原信任依据不成立。此时实测返回 undefined，授权复核会判定配置已变并退回人工确认，
 * 而不是拿旧摘要继续放行。
 */
async function sha256OfFile(path: string): Promise<string | undefined> {
  try {
    const bytes = await readFile(path);
    return createHash('sha256').update(bytes).digest('hex');
  } catch {
    return undefined;
  }
}

/**
 * 按冻结检查清单解析 run_check 的真实命令。
 *
 * 模型只能提供 check_id；可执行程序与参数来自授权时冻结的清单，因此它无法提交任意
 * shell 字符串，也无法通过改名绕过命令配置。清单里没有该 id 就按类型化原因拒绝。
 */
async function resolveToolCheck(db: DbExecutor, runId: string, args: JsonObject):
Promise<FrozenCheck> {
  const checkId = args.check_id;
  if (typeof checkId !== 'string' || checkId === '') {
    throw new ToolRequestRejected('TOOL_CHECK_ID_REQUIRED', 'run_check 需要一个 check_id。');
  }
  const grant = await new RunScopeGrantRepository(db).readByRun(runId);
  const check = resolveFrozenCheck(grant, checkId);
  if (check === undefined) {
    throw new ToolRequestRejected('TOOL_CHECK_NOT_CONFIGURED',
      `检查 ${checkId} 不在本次任务的已配置清单内。`);
  }
  return check;
}

/** 把冻结检查展开成 Gateway 的结构化参数；模型提供的 check_id 不会出现在这里。 */
function resolveToolParams(definition: InternalToolDefinition, args: JsonObject,
  check: FrozenCheck | undefined): JsonObject {
  if (definition.actionType !== 'CLI_RUN') return gatewayParamsFor(definition, args);
  if (check === undefined) return {};
  return { executable: check.executable, args: [...check.args],
    ...(check.max_output_bytes === undefined ? {} :
      { max_output_bytes: check.max_output_bytes }) };
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
