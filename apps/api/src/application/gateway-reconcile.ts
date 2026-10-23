import { randomUUID } from 'node:crypto';

import type { DbExecutor } from '../infrastructure/database.js';
import type { InvocationAttemptRow, LogicalOperationRow } from '../infrastructure/database-schema.js';
import type { JsonObject } from '../infrastructure/json.js';
import { reconcileFileQuery } from '../files/file-query.js';
import { githubExecute } from '../github/github-adapter.js';
import { computePayloadHash } from '../receipt/payload-hash.js';
import { webFetchExecute } from '../web/web-fetch.js';
import { LOCAL_ACTOR_REF, httpCommandScopeKey } from './actor.js';
import { runIdempotentCommand, resolveExistingReceipt, type CommandOutcome } from './command.js';
import { invalidTransition, resourceNotFound } from './domain-error.js';
import { fileReadExecute, gitExecute } from './gateway-actions.js';
import { lockWritableProjectInWorkspace } from './guards.js';
import { lockTaskAndRun } from './lock-task-run.js';
import { createRepositories, type Repositories } from './unit-of-work.js';

/**
 * Gateway 未决动作的**手动核对**（2026-10-22，DEV-0054）。
 *
 * 背景：服务端早就有完整的核对逻辑（`reconcileGatewayInvocation`），但它只挂在
 * Worker 停机恢复路径上（supervisor 回收旧进程后逐条核对），且以「旧执行进程已停」
 * 为前提。结果是：Worker 没有停机、或停机恢复没有覆盖到的未决动作，用户在 Run 页
 * 只能反复看到「待核对」，没有任何结清入口——契约要求 UNKNOWN 先核对，核对闭环
 * 却缺了人工这一半。
 *
 * 本命令补上人工入口，边界按能力族划：
 *   * **只读能力族**（FILE_READ / FILE_QUERY / WEB_FETCH / GIT_READ / GITHUB_READ）
 *     没有外部效果，核对就是按同一冻结输入**安全重读**一次——即使执行进程还活着，
 *     重读也不改变任何状态，因此不要求停机证明。RUN 来源仍要求当前占有者就是该
 *     调用的旧 Worker（`run.worker_id` 为 null 或等于 `invocation.worker_id`，
 *     与恢复路径的 GATEWAY_STALE_WORKER 同一条边界）：被新 epoch 接管的 Run 不
 *     接受手动核对——那才是跨执行进程的混淆。
 *   * **写能力族**（FILE_WRITE / GIT_WRITE / CLI_RUN / COMPUTER_* / BROWSER_*）
 *     一律拒绝：它们的外部效果只能经停机证明核对（恢复路径或
 *     ClosePartialFileWrite 那样的可信停机证明），手动按钮放行等于把「猜」升级成
 *     「结清」。页面照实说明走哪条路。
 *
 * 三条不变量：
 *   * 复用恢复路径同一批执行/重读函数（`fileReadExecute` / `reconcileFileQuery` /
 *     `webFetchExecute` / `gitExecute` / `githubExecute`）：核对的期望与执行的期望
 *     不允许漂移；
 *   * 落库走 CAS（`transitionInvocation` 从当前状态出发），并发下另一方胜出；
 *   * 命令幂等：同 command_id + 同载荷重放返回原结果，不重复核对。
 */

/** 没有外部效果、可安全重读核对的能力族。与 `reconcileGatewayInvocation` 的
 * safeReread 集合保持同一名单——两边漂移会让「恢复能核对、手动不能」或反向。 */
const SAFE_REREAD_CAPABILITIES: readonly string[] =
  ['FILE_READ', 'FILE_QUERY', 'WEB_FETCH', 'GIT_READ', 'GITHUB_READ'];

/** 未决调用状态集合（普通数组：includes 需要接受任意 InvocationStatus 收窄前的宽类型）。 */
const UNRESOLVED_INVOCATION_STATUSES: string[] = ['PREPARED', 'DISPATCHING', 'UNKNOWN'];

export interface ReconcileGatewayOperationResult extends JsonObject {
  readonly operation_id: string;
  readonly invocation_id: string;
  readonly capability_key: string;
  readonly status: 'SUCCEEDED' | 'NOT_EXECUTED' | 'FAILED';
  readonly reconciliation: 'SAFE_REREAD' | 'PREPARED_NOT_EXECUTED';
}

interface RereadOutcome {
  readonly status: 'SUCCEEDED' | 'NOT_EXECUTED' | 'FAILED';
  readonly reconciliation: 'SAFE_REREAD' | 'PREPARED_NOT_EXECUTED';
  readonly result: JsonObject;
}

/** 事务外定位与门控：能力族、来源、未决调用、RUN 的活跃 Worker。 */
async function locateReconcilable(repositories: Repositories, workspaceId: string,
  operationId: string): Promise<{ readonly operation: LogicalOperationRow;
  readonly invocation: InvocationAttemptRow }> {
  const operation = await repositories.gateway.readOperation(operationId);
  if (operation?.workspace_id !== workspaceId) throw resourceNotFound('Gateway operation');
  if (!SAFE_REREAD_CAPABILITIES.includes(operation.capability_key)) {
    throw invalidTransition(`手动核对只对没有外部效果的只读能力开放；${operation.capability_key} `
      + '有外部效果，须经停机恢复路径或人工处置入口核对。');
  }
  if (operation.origin !== 'RUN' && operation.origin !== 'USER_ACTION' &&
      operation.origin !== 'USER_IMPORT') {
    throw invalidTransition('该动作的来源不支持手动核对。');
  }
  const invocation = await repositories.gateway.lastInvocation(operation.id);
  if (invocation === undefined || !UNRESOLVED_INVOCATION_STATUSES.includes(invocation.status)) {
    throw invalidTransition('该动作没有未决调用，可能已结清；请刷新后查看最新状态。');
  }
  if (operation.origin === 'RUN' && operation.run_id !== null) {
    const run = await repositories.runs.readRun(operation.run_id);
    // 被新 Worker 接管的 Run 不接受手动核对：旧调用的核对会跨执行进程混淆（与恢复路径
    // 的 GATEWAY_STALE_WORKER 同一边界）。占有者仍是该调用自己的旧 Worker、或已释放时，
    // 只读能力可以核对——重读无外部效果，结算竞争由 CAS 裁决。
    if (run !== undefined && run.worker_id !== null && run.worker_id !== invocation.worker_id) {
      throw invalidTransition('该 Run 已被新的执行进程接管：请等新进程自行结算，或经停机恢复'
        + '路径核对；手动核对不接跨进程的旧调用。');
    }
  }
  return { operation, invocation };
}

/**
 * 按能力族安全重读。PREPARED 是唯一能证明「适配器调用未开始」的状态，直接判
 * NOT_EXECUTED；其余状态按同一冻结输入重读，结果即结论（读失败是明确 FAILED，
 * 不折叠成 UNKNOWN——那会把「查不清」伪装成「有疑问」）。
 */
async function rereadOutcome(repositories: Repositories, operation: LogicalOperationRow,
  invocation: InvocationAttemptRow): Promise<RereadOutcome> {
  if (invocation.status === 'PREPARED') {
    return { status: 'NOT_EXECUTED', reconciliation: 'PREPARED_NOT_EXECUTED',
      result: { reason: 'PREPARED_NOT_EXECUTED', invocation_id: invocation.id } };
  }
  if (operation.capability_key === 'FILE_READ') {
    const outcome = await fileReadExecute(operation, invocation);
    return { status: outcome.outcome === 'SUCCEEDED' ? 'SUCCEEDED' : 'FAILED',
      reconciliation: 'SAFE_REREAD', result: outcome.result };
  }
  if (operation.capability_key === 'FILE_QUERY') {
    const managedRoot = operation.resource_id === null ? operation.normalized_target
      : (await repositories.gateway.readResource(operation.resource_id))?.canonical_root
        ?? operation.normalized_target;
    const recheck = await reconcileFileQuery(operation, managedRoot);
    return { status: recheck.status === 'NOT_EXECUTED' ? 'NOT_EXECUTED'
      : recheck.status === 'SUCCEEDED' ? 'SUCCEEDED' : 'FAILED',
      reconciliation: 'SAFE_REREAD', result: recheck.result };
  }
  if (operation.capability_key === 'WEB_FETCH') {
    const fetch = await webFetchExecute(operation, invocation);
    return { status: fetch.outcome === 'SUCCEEDED' ? 'SUCCEEDED' : 'FAILED',
      reconciliation: 'SAFE_REREAD', result: fetch.result };
  }
  if (operation.capability_key === 'GIT_READ') {
    const read = await gitExecute(operation, invocation);
    return { status: read.outcome === 'SUCCEEDED' ? 'SUCCEEDED' : 'FAILED',
      reconciliation: 'SAFE_REREAD', result: read.result };
  }
  const read = await githubExecute(operation, invocation);
  return { status: read.outcome === 'SUCCEEDED' ? 'SUCCEEDED' : 'FAILED',
    reconciliation: 'SAFE_REREAD', result: read.result };
}

/**
 * 手动核对命令。先无锁定位与门控，再事务外重读（与恢复路径同序：计算不进事务），
 * 最后在同一短事务里 CAS 落库：调用状态、动作状态、资源隔离与审计。
 */
export async function reconcileReadonlyGatewayOperationCommand(db: DbExecutor, input: {
  readonly workspaceId: string; readonly operationId: string; readonly commandId: string;
}): Promise<CommandOutcome<ReconcileGatewayOperationResult>> {
  const scopeKey = httpCommandScopeKey(input.workspaceId);
  // 重放必须在定位与重读之前拿回原回执：核对成功后未决调用已结清，先跑门控会让
  // 同 command_id 的第二次调用报 INVALID_TRANSITION，把幂等重放变成一次新的失败。
  const payloadHash = computePayloadHash({ commandType: 'ReconcileGatewayOperation',
    target: input.operationId, body: {} });
  const prior = await createRepositories(db).receipts.findReceipt({ scopeKey,
    commandId: input.commandId });
  if (prior !== undefined) {
    return resolveExistingReceipt<ReconcileGatewayOperationResult>(prior, payloadHash);
  }
  const source = await locateReconcilable(createRepositories(db), input.workspaceId,
    input.operationId);
  const computed = await rereadOutcome(createRepositories(db), source.operation,
    source.invocation);
  return runIdempotentCommand(db, {
    scopeKey, commandId: input.commandId,
    commandType: 'ReconcileGatewayOperation', target: input.operationId,
    body: {},
    execute: async (repositories) => {
      const located = await repositories.gateway.readOperation(input.operationId);
      if (located?.workspace_id !== input.workspaceId) throw resourceNotFound('Gateway operation');
      if (!SAFE_REREAD_CAPABILITIES.includes(located.capability_key)) {
        throw invalidTransition('能力族在核对过程中变化，请刷新后重试。');
      }
      // 按来源加行锁：与 settle 同一边界顺序（Task→Run / ImportJob / Project+Resource）。
      if (located.origin === 'RUN') {
        if (located.run_id === null) throw resourceNotFound('Run');
        const { run } = await lockTaskAndRun(repositories, located.run_id, input.workspaceId);
        if (run.worker_id !== null && run.worker_id !== source.invocation.worker_id) {
          throw invalidTransition('该 Run 在核对过程中被新的执行进程接管，本次核对作废。');
        }
      } else if (located.origin === 'USER_IMPORT') {
        if (located.import_job_id === null) throw resourceNotFound('Import job');
        await repositories.gateway.lockImportJob(located.import_job_id);
        await lockWritableProjectInWorkspace(repositories, located.workspace_id, located.project_id);
      } else {
        await lockWritableProjectInWorkspace(repositories, located.workspace_id, located.project_id);
        if (located.resource_id !== null) await repositories.gateway.lockResource(located.resource_id);
      }
      const operation = await repositories.gateway.lockOperation(located.id);
      const invocation = await repositories.gateway.lockInvocation(source.invocation.id);
      if (operation === undefined || invocation === undefined ||
          invocation.operation_id !== operation.id ||
          !UNRESOLVED_INVOCATION_STATUSES.includes(invocation.status)) {
        throw invalidTransition('未决调用已经变化，请刷新后重新核对。');
      }
      const evidence: JsonObject = { reconciliation: computed.reconciliation,
        invocation_id: invocation.id, manual: true, ...computed.result };
      const changed = await repositories.gateway.transitionInvocation(invocation.id,
        invocation.status, computed.status, evidence);
      if (changed === undefined) throw new Error('reconcile CAS failed');
      // NOT_EXECUTED 回到 PREPARED：动作没有发生，保持可被后续投递的原状（与恢复路径同口径）。
      await repositories.gateway.setOperationStatus(operation.id,
        computed.status === 'NOT_EXECUTED' ? 'PREPARED' : computed.status, evidence);
      // 只读核对的结论只有 SUCCEEDED / FAILED / NOT_EXECUTED，没有 UNKNOWN：重读失败是
      // 明确失败（读不到、HTTP 错误），不是「查不清」。因此资源隔离一律释放，不保留
      // QUARANTINED——那是留给写能力与真未知的。
      if (invocation.resource_claim_id !== null) {
        await repositories.gateway.setClaimStatus(invocation.resource_claim_id, 'RELEASED');
      }
      await repositories.activities.insertActivityRecord({ id: randomUUID(),
        workspaceId: operation.workspace_id, actorKind: 'HUMAN', actorRef: LOCAL_ACTOR_REF,
        commandId: input.commandId, projectId: operation.project_id,
        taskId: operation.run_id === null ? null : (await repositories.runs.readRun(operation.run_id))?.task_id ?? null,
        ...(operation.run_id === null ? {} : { runId: operation.run_id }),
        eventType: 'GATEWAY_OPERATION_RECONCILED',
        factRefs: { operation_id: operation.id, invocation_id: invocation.id,
          capability_key: operation.capability_key, origin: operation.origin,
          status: computed.status, reconciliation: computed.reconciliation } });
      return { operation_id: operation.id, invocation_id: invocation.id,
        capability_key: operation.capability_key, status: computed.status,
        reconciliation: computed.reconciliation };
    },
  });
}
