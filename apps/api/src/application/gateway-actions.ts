import { createHash, randomUUID } from 'node:crypto';
import { lstat, readFile, realpath, writeFile } from 'node:fs/promises';
import { basename, dirname, isAbsolute, relative, resolve, sep } from 'node:path';

import type { DbExecutor } from '../infrastructure/database.js';
import type {
  GatewayCapability, GatewayDecision, GatewayPermissionVersionRow, InvocationAttemptRow,
  LogicalOperationRow, ManagedResourceRow, RunRow, TaskRow,
} from '../infrastructure/database-schema.js';
import type { JsonObject } from '../infrastructure/json.js';
import { canonicalizeJson } from '../receipt/payload-hash.js';
import { reviewTargetHash } from './review-requests.js';
import { rootsOverlap } from './gateway-configuration.js';
import { applySafeControl } from './control-requests.js';
import { DomainError, invalidTransition, resourceNotFound, validationFailed } from './domain-error.js';
import { lockTaskAndRun } from './lock-task-run.js';
import { createRepositories, withTransaction, type Repositories } from './unit-of-work.js';
import { requireCurrentRuleSnapshot } from './rule-fence.js';
import { hasCurrentRunContext } from './context-fence.js';
import { readMockGatewayAction } from '../workflow/execution-contract.js';

export type GatewayOrigin =
  | { readonly kind: 'RUN'; readonly runId: string; readonly stepId: string;
      readonly resourceId: string; readonly workerId: string; readonly workerEpoch: bigint;
      readonly delivery?: { readonly commandId: string; readonly invocationEpoch: bigint } }
  | { readonly kind: 'USER_IMPORT'; readonly importJobId: string;
      readonly actorRef: string; readonly configVersion: string };

export interface PrepareGatewayActionInput {
  readonly workspaceId: string;
  readonly operationId: string;
  readonly intentKey: string;
  readonly connectionId: string;
  readonly origin: GatewayOrigin;
  readonly actionType: 'WRITE_MARKER' | 'READ_PUBLIC';
  readonly target: string;
  readonly params: JsonObject;
}

export interface PreparedGatewayAction {
  readonly operation_id: string;
  readonly status: LogicalOperationRow['status'];
  readonly invocation_id: string | null;
  readonly review_id: string | null;
}

export interface GatewayDispatchResult {
  readonly operation_id: string;
  readonly invocation_id: string;
  readonly status: 'SUCCEEDED' | 'UNKNOWN';
  readonly result_ref: JsonObject | null;
}

export class SimulatedGatewayCrash extends Error {
  override readonly name = 'SimulatedGatewayCrash';
}

function gatewayDenied(code: string, detail: string, retryable = false): DomainError {
  return new DomainError({ code, status: 409, type: `/problems/${code.toLowerCase().replaceAll('_', '-')}`,
    title: 'Gateway 拒绝执行', detail, retryable, retryAction: retryable ? 'POLL_RESOURCE' : 'REFRESH_AND_REDECIDE' });
}

function capabilityFor(action: PrepareGatewayActionInput['actionType']): GatewayCapability {
  return action === 'WRITE_MARKER' ? 'FAKE_WRITE' : 'FAKE_PUBLIC_READ';
}

function normalizedPublicTarget(target: string): string {
  let url: URL;
  try { url = new URL(target); } catch { throw validationFailed([{ field: 'target', message: 'invalid URL' }]); }
  if (url.protocol !== 'https:' || url.hostname !== 'public.example' || url.username || url.password || url.hash) {
    throw gatewayDenied('GATEWAY_TARGET_DENIED', 'P09 Fake 公共读取仅接受 public.example 的 HTTPS URL。');
  }
  return url.toString();
}

function containsPath(root: string, target: string): boolean {
  const normalizedRoot = process.platform === 'win32' ? root.toLowerCase() : root;
  const normalizedTarget = process.platform === 'win32' ? target.toLowerCase() : target;
  const part = relative(normalizedRoot, normalizedTarget);
  return part !== '' && part !== '..' && !part.startsWith(`..${sep}`) && !isAbsolute(part);
}

async function normalizedWriteTarget(target: string, root: string): Promise<string> {
  if (!isAbsolute(target)) throw validationFailed([{ field: 'target', message: 'must be absolute' }]);
  const parent = await realpath(dirname(target));
  const normalized = resolve(parent, basename(target));
  if (!containsPath(root, normalized)) throw gatewayDenied('GATEWAY_TARGET_DENIED', '最终目标不在已登记资源根内。');
  try {
    const entry = await lstat(normalized);
    if (entry.isSymbolicLink() || !entry.isFile()) throw gatewayDenied('GATEWAY_TARGET_DENIED', '目标已有非普通文件或链接。');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  return normalized;
}

function paramsHash(input: Pick<PrepareGatewayActionInput, 'actionType' | 'params'>, target: string): Buffer {
  return createHash('sha256').update(canonicalizeJson({
    action_type: input.actionType, normalized_target: target, params: input.params,
  })).digest();
}

function targetMatches(prefix: string, target: string, capability: GatewayCapability): boolean {
  if (capability === 'FAKE_PUBLIC_READ') {
    try {
      const policyUrl = new URL(prefix);
      const targetUrl = new URL(target);
      if (policyUrl.origin !== targetUrl.origin || policyUrl.search || policyUrl.hash) return false;
      const path = policyUrl.pathname;
      return targetUrl.pathname === path || targetUrl.pathname.startsWith(path.endsWith('/') ? path : `${path}/`);
    } catch { return false; }
  }
  const left = process.platform === 'win32' ? prefix.toLowerCase() : prefix;
  const right = process.platform === 'win32' ? target.toLowerCase() : target;
  return right === left || right.startsWith(left.endsWith(sep) ? left : `${left}${sep}`);
}

interface SelectedPolicy extends GatewayPermissionVersionRow { readonly id: string; readonly project_id: string }

async function selectedPolicy(repositories: Repositories, input: {
  workspaceId: string; projectId: string; capability: GatewayCapability;
  actionType: string; target: string; payloadBytes: number;
}): Promise<SelectedPolicy> {
  const candidates = (await repositories.gateway.listActivePolicies(input.workspaceId, input.projectId,
    input.capability, input.actionType)).filter((policy) =>
    targetMatches(policy.target_prefix, input.target, input.capability));
  candidates.sort((a, b) => {
    const rank: Record<GatewayDecision, number> = { DENY: 0, ASK: 1, AUTO: 2 };
    return rank[a.decision] - rank[b.decision] || b.target_prefix.length - a.target_prefix.length || a.id.localeCompare(b.id);
  });
  const selected = candidates[0];
  if (selected === undefined || selected.decision === 'DENY' || input.payloadBytes > selected.max_payload_bytes) {
    throw gatewayDenied('GATEWAY_PERMISSION_DENIED', '当前目标、参数与大小未获得有效 Permission。');
  }
  return selected;
}

function ensureRunOwner(task: TaskRow, run: RunRow, workerId: string, workerEpoch: bigint): void {
  if (task.executor_kind !== 'AI' || task.executor_run_id !== run.id ||
      task.ownership_epoch !== run.ownership_epoch || run.worker_id !== workerId ||
      run.worker_epoch !== workerEpoch || run.worker_lease_until === null ||
      run.worker_lease_until.getTime() <= Date.now()) {
    throw gatewayDenied('GATEWAY_STALE_WORKER', 'Worker/Task/Run 的执行令牌已失效。');
  }
}

async function ensureGraphDelivery(repositories: Repositories,
  origin: Extract<GatewayOrigin, { kind: 'RUN' }>): Promise<void> {
  if (origin.delivery !== undefined &&
      !(await repositories.dispatch.hasCurrentCommandInvocation(origin.runId,
        origin.delivery.commandId, origin.workerId, origin.delivery.invocationEpoch))) {
    throw gatewayDenied('GATEWAY_STALE_WORKER', '图命令的外层 invocation 已失效。');
  }
}

function sameOperation(op: LogicalOperationRow, input: PrepareGatewayActionInput,
  target: string, hash: Buffer): boolean {
  return op.id === input.operationId && op.connection_id === input.connectionId &&
    op.action_type === input.actionType && op.normalized_target === target && op.params_hash.equals(hash) &&
    op.origin === input.origin.kind;
}

/** Prepare persists one logical action; ASK creates Review, never an Invocation. */
export async function prepareGatewayAction(db: DbExecutor, input: PrepareGatewayActionInput): Promise<PreparedGatewayAction> {
  if (!input.intentKey) throw validationFailed([{ field: 'intent_key', message: 'must not be empty' }]);
  const capability = capabilityFor(input.actionType);
  if ((input.origin.kind === 'RUN') !== (capability === 'FAKE_WRITE')) {
    throw gatewayDenied('GATEWAY_ORIGIN_DENIED', 'RUN 仅允许 Fake 写，USER_IMPORT 仅允许 Fake 公共读。');
  }
  const resourceBefore = input.origin.kind === 'RUN'
    ? await createRepositories(db).gateway.readResource(input.origin.resourceId) : undefined;
  if (input.origin.kind === 'RUN' && (resourceBefore === undefined || resourceBefore.workspace_id !== input.workspaceId)) {
    throw resourceNotFound('Managed resource');
  }
  const target = input.origin.kind === 'RUN'
    ? await normalizedWriteTarget(input.target, resourceBefore!.canonical_root)
    : normalizedPublicTarget(input.target);
  if (input.actionType === 'WRITE_MARKER' && typeof input.params.content !== 'string') {
    throw validationFailed([{ field: 'params.content', message: 'must be a string' }]);
  }
  if (input.actionType === 'READ_PUBLIC' && Object.keys(input.params).length !== 0) {
    throw validationFailed([{ field: 'params', message: 'Fake public read takes no parameters' }]);
  }
  const hash = paramsHash(input, target);
  const payloadBytes = Buffer.byteLength(canonicalizeJson(input.params));
  return withTransaction(db, async (repositories) => {
    const authority = await repositories.workspaces.lockAuthority(input.workspaceId, 'share');
    if (authority === undefined) throw resourceNotFound('Workspace authority');
    let task: TaskRow | undefined;
    let run: RunRow | undefined;
    let resource: ManagedResourceRow | undefined;
    let projectId: string;
    if (input.origin.kind === 'RUN') {
      ({ task, run } = await lockTaskAndRun(repositories, input.origin.runId, input.workspaceId));
      await requireCurrentRuleSnapshot(repositories, run.id, authority);
      ensureRunOwner(task, run, input.origin.workerId, input.origin.workerEpoch);
      await ensureGraphDelivery(repositories, input.origin);
      if (run.status !== 'RUNNING' || (await repositories.recovery.lockPendingControl(run.id)) !== undefined) {
        throw gatewayDenied('GATEWAY_RUN_NOT_READY', 'Run 不在可准备动作的安全执行状态。');
      }
      if ((await repositories.recovery.listUnresolvedEffects(run.id)).length > 0) {
        throw gatewayDenied('GATEWAY_OPERATION_UNRESOLVED', '该 Run 有尚未核对的受管发布动作。');
      }
      const step = await repositories.runs.readStep(input.origin.stepId);
      if (step?.run_id !== run.id || !['RUNNING', 'SUCCEEDED'].includes(step.status)) throw resourceNotFound('Run step');
      if (task.project_id === null) throw gatewayDenied('GATEWAY_PROJECT_REQUIRED', '写动作必须属于一个 Project。');
      projectId = task.project_id;
      resource = await repositories.gateway.lockResource(input.origin.resourceId);
      if (resource?.project_id !== projectId || resource.workspace_id !== input.workspaceId ||
          resource.identity_key !== resourceBefore?.identity_key || resource.status !== 'ACTIVE') throw resourceNotFound('Managed resource');
    } else {
      const job = await repositories.gateway.lockImportJob(input.origin.importJobId);
      if (job?.workspace_id !== input.workspaceId || job.actor_ref !== input.origin.actorRef ||
          job.config_version !== input.origin.configVersion || job.source_uri !== target ||
          !['QUEUED', 'RUNNING'].includes(job.status)) throw gatewayDenied('GATEWAY_IMPORT_STALE', '导入来源、用户或配置已失效。');
      projectId = job.project_id;
    }

    const existing = await repositories.gateway.findOperationByIntent(input.origin.kind === 'RUN'
      ? { runId: input.origin.runId, stepId: input.origin.stepId, intentKey: input.intentKey }
      : { importJobId: input.origin.importJobId, intentKey: input.intentKey });
    if (existing !== undefined) {
      if (!sameOperation(existing, input, target, hash)) throw gatewayDenied('GATEWAY_INTENT_CONFLICT', '同一 intent_key 已绑定其他最终动作。');
      return { operation_id: existing.id, status: existing.status,
        invocation_id: (await repositories.gateway.lastInvocation(existing.id))?.id ?? null,
        review_id: (await repositories.reviews.readByOperationId(existing.id))?.id ?? null };
    }
    if (run !== undefined && (await repositories.gateway.listUnresolvedRunOperations(run.id)).length > 0) {
      throw gatewayDenied('GATEWAY_OPERATION_UNRESOLVED', '该 Run 有未决 Gateway 动作，不能更换动作身份或目标绕过核对。');
    }
    if (input.origin.kind === 'USER_IMPORT' &&
        (await repositories.gateway.listUnresolvedImportOperations(input.origin.importJobId)).length > 0) {
      throw gatewayDenied('GATEWAY_OPERATION_UNRESOLVED', '该导入已有未决动作，不能更换动作身份绕过核对。');
    }
    if (await repositories.reviews.readByOperationId(input.operationId) !== undefined) {
      throw gatewayDenied('GATEWAY_APPROVAL_ID_CONFLICT', '旧 Review 已使用该 operation_id，不能作为 Gateway 批准。');
    }
    const connection = await repositories.gateway.readConnection(input.connectionId);
    if (connection?.workspace_id !== input.workspaceId || connection.project_id !== projectId ||
        connection.status !== 'ACTIVE' || !(await repositories.gateway.hasConnectionCapability(connection.id, capability))) {
      throw gatewayDenied('GATEWAY_CONNECTION_DENIED', 'Connection 不存在、已停用或不具备该 Capability。');
    }
    const policy = await selectedPolicy(repositories, { workspaceId: input.workspaceId, projectId,
      capability, actionType: input.actionType, target, payloadBytes });
    const op = await repositories.gateway.insertOperation({ id: input.operationId,
      workspace_id: input.workspaceId, project_id: projectId, origin: input.origin.kind,
      task_id: task?.id ?? null,
      run_id: input.origin.kind === 'RUN' ? input.origin.runId : null,
      step_id: input.origin.kind === 'RUN' ? input.origin.stepId : null,
      import_job_id: input.origin.kind === 'USER_IMPORT' ? input.origin.importJobId : null,
      intent_key: input.intentKey, connection_id: connection.id, connection_version: connection.version,
      connection_config: connection.config, policy_id: policy.id, policy_version: policy.version,
      capability_key: capability, action_type: input.actionType, normalized_target: target,
      params_hash: hash, params: input.params,
      resource_id: resource?.id ?? null, status: policy.decision === 'ASK' ? 'WAITING_APPROVAL' : 'PREPARED' });
    if (policy.decision === 'ASK') {
      const review = await createGatewayReview(repositories, op, run, task);
      if (run !== undefined && task !== undefined && input.origin.kind === 'RUN') {
        const changed = await repositories.runs.advanceRun({ runId: run.id, expectedRevision: run.revision,
          status: 'WAITING_APPROVAL', waitReason: 'ACTION_APPROVAL_REQUIRED', resumePhase: 'RUNNING' });
        if (changed === undefined) throw new Error('Gateway Review Run CAS failed');
        if (task.status === 'IN_PROGRESS') {
          const waiting = await repositories.tasks.applyTaskStatus({ taskId: task.id,
            expectedRevision: task.revision, fromStatus: 'IN_PROGRESS', toStatus: 'WAITING' });
          if (waiting === undefined) throw new Error('Gateway Review Task CAS failed');
        }
        const released = await repositories.runs.releaseWorker(run.id, input.origin.workerId, input.origin.workerEpoch);
        if (released === undefined) throw new Error('Gateway Review worker release failed');
      }
      return { operation_id: op.id, status: 'WAITING_APPROVAL', invocation_id: null, review_id: review.id };
    }
    const invocation = await createPreparedInvocation(repositories, authority.revision, op, run, task, resource);
    return { operation_id: op.id, status: 'PREPARED', invocation_id: invocation.id, review_id: null };
  });
}

async function createGatewayReview(repositories: Repositories, op: LogicalOperationRow,
  run: RunRow | undefined, task: TaskRow | undefined) {
  const target: JsonObject = { operation_id: op.id, origin: op.origin, run_id: op.run_id,
    step_id: op.step_id, import_job_id: op.import_job_id, action_type: op.action_type,
    normalized_target: op.normalized_target, params_hash: op.params_hash.toString('hex'),
    connection_id: op.connection_id, connection_version: op.connection_version.toString(),
    policy_id: op.policy_id, policy_version: op.policy_version.toString(),
    acceptance_revision: task?.acceptance_revision.toString() ?? null };
  return repositories.reviews.insertRequest({ id: randomUUID(), workspaceId: op.workspace_id,
    projectId: op.project_id, taskId: task?.id ?? null, runId: run?.id ?? null,
    verificationSessionId: null, criterionId: null, operationId: op.id,
    kind: 'ACTION_APPROVAL', reason: '此 Fake 动作需要针对最终目标与参数的批准。',
    targetHash: reviewTargetHash(target), target,
    evidence: { capability: op.capability_key, action_type: op.action_type },
    effect: { external_effect_executed: false }, allowedDecisions: ['APPROVE', 'DENY'],
    expiresAt: new Date(Date.now() + 30 * 60_000) });
}

async function createPreparedInvocation(repositories: Repositories, authorityRevision: bigint,
  op: LogicalOperationRow, run: RunRow | undefined, task: TaskRow | undefined,
  resource: ManagedResourceRow | undefined, attemptNumber = 1n): Promise<InvocationAttemptRow> {
  let claimId: string | null = null;
  let claimToken: string | null = null;
  let claimEpoch: bigint | null = null;
  if (run !== undefined && task !== undefined && resource !== undefined) {
    await repositories.gateway.lockResourceRegistry();
    if ((await repositories.gateway.listOccupiedResources()).some((occupied) =>
      rootsOverlap(occupied.identity_key, resource.identity_key))) {
      throw gatewayDenied('RESOURCE_OCCUPIED', '实际工作目录已被其他动作占用或隔离。', true);
    }
    claimEpoch = await repositories.gateway.nextResourceEpoch(resource.id);
    claimId = randomUUID();
    claimToken = randomUUID();
    await repositories.gateway.insertClaim({ id: claimId, resourceId: resource.id,
      workspaceId: resource.workspace_id, projectId: resource.project_id,
      taskId: task.id, runId: run.id, workerId: run.worker_id!, workerEpoch: run.worker_epoch,
      claimEpoch, claimToken });
  }
  return repositories.gateway.insertInvocation({ id: randomUUID(), operation_id: op.id,
    origin: op.origin, task_id: op.task_id, run_id: op.run_id, resource_id: op.resource_id,
    attempt_number: attemptNumber, status: 'PREPARED', authority_revision: authorityRevision,
    connection_version: op.connection_version, connection_config: op.connection_config,
    ownership_epoch: task?.ownership_epoch ?? null, worker_id: run?.worker_id ?? null,
    worker_epoch: run?.worker_epoch ?? null, resource_claim_id: claimId,
    claim_token: claimToken, claim_epoch: claimEpoch });
}

export interface DispatchGatewayInput {
  readonly workspaceId: string;
  readonly operationId: string;
  readonly origin: GatewayOrigin;
  readonly signal?: AbortSignal;
  /** Fault and barrier hooks used only by deterministic PG tests. */
  readonly hooks?: {
    readonly afterAdmit?: () => Promise<void>;
    readonly afterFakeEffect?: () => Promise<void>;
  };
}

/** Internal Worker port for a RUNNING Run before its first Gateway Prepare. */
export async function claimRunForGateway(db: DbExecutor, input: {
  readonly workspaceId: string; readonly runId: string; readonly workerId: string;
  readonly delivery?: { readonly commandId: string; readonly invocationEpoch: bigint };
  readonly leaseMs?: number;
}): Promise<{ readonly worker_epoch: string }> {
  if (!input.workerId) throw validationFailed([{ field: 'worker_id', message: 'must not be empty' }]);
  return withTransaction(db, async (repositories) => {
    const authority = await repositories.workspaces.lockAuthority(input.workspaceId, 'share');
    if (authority === undefined) throw resourceNotFound('Workspace authority');
    const { task, run } = await lockTaskAndRun(repositories, input.runId, input.workspaceId);
    if (input.delivery !== undefined &&
        !(await repositories.dispatch.hasCurrentCommandInvocation(run.id,
          input.delivery.commandId, input.workerId, input.delivery.invocationEpoch))) {
      throw gatewayDenied('GATEWAY_STALE_WORKER', '图命令的外层 invocation 已失效。');
    }
    await requireCurrentRuleSnapshot(repositories, run.id, authority);
    if ((await repositories.gateway.listUnresolvedRunOperations(run.id)).length > 0 ||
        (await repositories.recovery.listUnresolvedEffects(run.id)).length > 0) {
      throw gatewayDenied('GATEWAY_OPERATION_UNRESOLVED', 'Run 仍有未决动作，不能另领新动作。');
    }
    if (run.status !== 'RUNNING' || run.worker_id !== null || task.executor_run_id !== run.id ||
        task.ownership_epoch !== run.ownership_epoch ||
        (await repositories.recovery.lockPendingControl(run.id)) !== undefined) {
      throw gatewayDenied('GATEWAY_RUN_NOT_READY', 'Run 当前不可领取新的 Gateway 动作。');
    }
    const claimed = await repositories.runs.claimWorker(run.id, input.workerId,
      new Date(Date.now() + (input.leaseMs ?? 30_000)));
    if (claimed === undefined) throw gatewayDenied('GATEWAY_STALE_WORKER', 'Worker 领取竞争失败。');
    return { worker_epoch: claimed.worker_epoch.toString() };
  });
}

export async function releaseGatewayWorker(db: DbExecutor, input: {
  readonly workspaceId: string; readonly runId: string; readonly workerId: string;
  readonly workerEpoch: bigint;
  readonly delivery?: { readonly commandId: string; readonly invocationEpoch: bigint };
}): Promise<void> {
  await withTransaction(db, async (repositories) => {
    const { run } = await lockTaskAndRun(repositories, input.runId, input.workspaceId);
    if (input.delivery !== undefined &&
        !(await repositories.dispatch.hasCurrentCommandInvocation(run.id,
          input.delivery.commandId, input.workerId, input.delivery.invocationEpoch))) {
      throw gatewayDenied('GATEWAY_STALE_WORKER', '图命令的外层 invocation 已失效。');
    }
    if (run.worker_id !== input.workerId || run.worker_epoch !== input.workerEpoch) {
      throw gatewayDenied('GATEWAY_STALE_WORKER', '旧 Worker 不能释放新占有者的 claim。');
    }
    if ((await repositories.gateway.listUnresolvedRunOperations(run.id)).length > 0 ||
        (await repositories.recovery.listUnresolvedEffects(run.id)).length > 0) {
      throw gatewayDenied('GATEWAY_OPERATION_UNRESOLVED', '未决动作期间不能释放 Worker claim。');
    }
    await repositories.runs.releaseWorker(run.id, input.workerId, input.workerEpoch);
  });
}

/** Approved WAITING operation has no Worker claim; this is its explicit new claim path. */
export async function claimGatewayWorker(db: DbExecutor, input: {
  readonly workspaceId: string; readonly operationId: string; readonly workerId: string;
  readonly delivery?: { readonly commandId: string; readonly invocationEpoch: bigint };
  readonly leaseMs?: number;
}): Promise<{ readonly worker_epoch: string }> {
  if (!input.workerId || (input.leaseMs !== undefined && (input.leaseMs < 1000 || input.leaseMs > 300_000))) {
    throw validationFailed([{ field: 'worker', message: 'invalid worker identity or lease' }]);
  }
  const located = await createRepositories(db).gateway.readOperation(input.operationId);
  if (located?.workspace_id !== input.workspaceId || located.origin !== 'RUN' || located.run_id === null) {
    throw resourceNotFound('Gateway operation');
  }
  return withTransaction(db, async (repositories) => {
    const authority = await repositories.workspaces.lockAuthority(input.workspaceId, 'share');
    if (authority === undefined) throw resourceNotFound('Workspace authority');
    const { task, run } = await lockTaskAndRun(repositories, located.run_id!, input.workspaceId);
    if (input.delivery !== undefined &&
        !(await repositories.dispatch.hasCurrentCommandInvocation(run.id,
          input.delivery.commandId, input.workerId, input.delivery.invocationEpoch))) {
      throw gatewayDenied('GATEWAY_STALE_WORKER', '图命令的外层 invocation 已失效。');
    }
    await requireCurrentRuleSnapshot(repositories, run.id, authority);
    if (task.executor_run_id !== run.id || task.ownership_epoch !== run.ownership_epoch ||
        run.worker_id !== null || (await repositories.recovery.lockPendingControl(run.id)) !== undefined) {
      throw gatewayDenied('GATEWAY_STALE_WORKER', 'Run 已由另一 Worker 占有，或等待控制处理。');
    }
    if ((await repositories.recovery.listUnresolvedEffects(run.id)).length > 0 ||
        (await repositories.gateway.listUnresolvedRunOperations(run.id)).some((row) => row.id !== located.id)) {
      throw gatewayDenied('GATEWAY_OPERATION_UNRESOLVED', '其他未决动作阻止 Worker 领取。');
    }
    const reviewLocated = await repositories.reviews.readByOperationId(located.id);
    const review = reviewLocated === undefined ? undefined : await repositories.reviews.lockRequest(reviewLocated.id);
    const op = await repositories.gateway.lockOperation(located.id);
    if (op === undefined || op.run_id !== run.id ||
        !((op.status === 'WAITING_APPROVAL' && run.status === 'WAITING_APPROVAL') ||
          (op.status === 'PREPARED' && run.status === 'RUNNING'))) {
      throw gatewayDenied('GATEWAY_OPERATION_UNRESOLVED', '操作尚不可重新领取。');
    }
    await requireCurrentGatewayGrant(repositories, op, review);
    const claimed = await repositories.runs.claimWorker(run.id, input.workerId,
      new Date(Date.now() + (input.leaseMs ?? 30_000)));
    if (claimed === undefined) throw gatewayDenied('GATEWAY_STALE_WORKER', 'Worker 领取竞争失败。');
    return { worker_epoch: claimed.worker_epoch.toString() };
  });
}

interface AdmittedInvocation {
  readonly operation: LogicalOperationRow;
  readonly invocation: InvocationAttemptRow;
}

function originMatches(op: LogicalOperationRow, origin: GatewayOrigin): boolean {
  return origin.kind === 'RUN'
    ? op.origin === 'RUN' && op.run_id === origin.runId && op.step_id === origin.stepId &&
      op.resource_id === origin.resourceId
    : op.origin === 'USER_IMPORT' && op.import_job_id === origin.importJobId;
}

function reviewMatchesOperation(review: NonNullable<Awaited<ReturnType<Repositories['reviews']['readByOperationId']>>>,
  op: LogicalOperationRow): boolean {
  const target = review.target;
  return review.kind === 'ACTION_APPROVAL' && review.operation_id === op.id &&
    review.target_hash.equals(reviewTargetHash(target)) && target.operation_id === op.id &&
    target.origin === op.origin && target.run_id === op.run_id && target.step_id === op.step_id &&
    target.import_job_id === op.import_job_id && target.normalized_target === op.normalized_target &&
    target.params_hash === op.params_hash.toString('hex') &&
    target.connection_id === op.connection_id && target.connection_version === op.connection_version.toString() &&
    target.policy_id === op.policy_id && target.policy_version === op.policy_version.toString();
}

async function requireCurrentGatewayGrant(repositories: Repositories, op: LogicalOperationRow,
  review: Awaited<ReturnType<Repositories['reviews']['readByOperationId']>>): Promise<SelectedPolicy> {
  const connection = await repositories.gateway.readConnection(op.connection_id);
  if (connection?.workspace_id !== op.workspace_id || connection.project_id !== op.project_id ||
      connection.status !== 'ACTIVE' || connection.version !== op.connection_version ||
      !(await repositories.gateway.hasConnectionCapability(connection.id, op.capability_key))) {
    throw gatewayDenied('GATEWAY_CONNECTION_STALE', 'Connection 已停用、变更或丧失 Capability。');
  }
  const selected = await selectedPolicy(repositories, { workspaceId: op.workspace_id,
    projectId: op.project_id, capability: op.capability_key, actionType: op.action_type,
    target: op.normalized_target, payloadBytes: Buffer.byteLength(canonicalizeJson(op.params)) });
  if (selected.id !== op.policy_id || selected.version !== op.policy_version) {
    throw gatewayDenied('GATEWAY_PERMISSION_STALE', 'Permission 活动版本已变化，原批准与准备事实失效。');
  }
  if (selected.decision === 'ASK') {
    if (review === undefined || !reviewMatchesOperation(review, op) || review.status !== 'DECIDED' ||
        (review.expires_at !== null && review.expires_at.getTime() <= Date.now()) ||
        (await repositories.reviews.readDecision(review.id))?.decision !== 'APPROVE') {
      throw gatewayDenied('GATEWAY_APPROVAL_REQUIRED', '最终目标的有效批准尚未保存。');
    }
  } else if (review !== undefined) {
    throw gatewayDenied('GATEWAY_APPROVAL_STALE', '动作带有不适用的旧 Review。');
  }
  return selected;
}

async function admitGatewayInvocation(db: DbExecutor, input: DispatchGatewayInput): Promise<AdmittedInvocation> {
  const located = await createRepositories(db).gateway.readOperation(input.operationId);
  if (located?.workspace_id !== input.workspaceId || !originMatches(located, input.origin)) {
    throw resourceNotFound('Gateway operation');
  }
  return withTransaction(db, async (repositories) => {
    const authority = await repositories.workspaces.lockAuthority(input.workspaceId, 'share');
    if (authority === undefined) throw resourceNotFound('Workspace authority');
    let task: TaskRow | undefined;
    let run: RunRow | undefined;
    let resource: ManagedResourceRow | undefined;
    if (input.origin.kind === 'RUN') {
      ({ task, run } = await lockTaskAndRun(repositories, input.origin.runId, input.workspaceId));
      await requireCurrentRuleSnapshot(repositories, run.id, authority);
      ensureRunOwner(task, run, input.origin.workerId, input.origin.workerEpoch);
      await ensureGraphDelivery(repositories, input.origin);
      if (task.project_id !== located.project_id ||
          (await repositories.recovery.lockPendingControl(run.id)) !== undefined) {
        throw gatewayDenied('GATEWAY_RUN_NOT_READY', 'Task 归属或控制意图阻止动作准入。');
      }
      if ((await repositories.recovery.listUnresolvedEffects(run.id)).length > 0 ||
          (await repositories.gateway.listUnresolvedRunOperations(run.id)).some((row) => row.id !== located.id)) {
        throw gatewayDenied('GATEWAY_OPERATION_UNRESOLVED', '该 Run 的其他动作仍未安全核对。');
      }
      const contract = await repositories.runs.readContract(run.id);
      const frozenAction = contract === undefined ? undefined :
        readMockGatewayAction(contract.frozen_snapshot);
      if (frozenAction?.operation_id === located.id &&
          !(await hasCurrentRunContext(repositories, run, task, authority))) {
        throw gatewayDenied('GATEWAY_CONTEXT_STALE', 'Run 的 Context 来源已变化，原动作不得准入。');
      }
      resource = await repositories.gateway.lockResource(input.origin.resourceId);
      if (resource?.project_id !== located.project_id || resource.workspace_id !== input.workspaceId ||
          resource.status !== 'ACTIVE') {
        throw resourceNotFound('Managed resource');
      }
    } else {
      const job = await repositories.gateway.lockImportJob(input.origin.importJobId);
      if (job?.workspace_id !== input.workspaceId || job.project_id !== located.project_id ||
          job.actor_ref !== input.origin.actorRef || job.config_version !== input.origin.configVersion ||
          job.source_uri !== located.normalized_target || !['QUEUED', 'RUNNING'].includes(job.status)) {
        throw gatewayDenied('GATEWAY_IMPORT_STALE', '用户导入来源或状态已失效。');
      }
      if ((await repositories.gateway.listUnresolvedImportOperations(job.id)).some((row) => row.id !== located.id)) {
        throw gatewayDenied('GATEWAY_OPERATION_UNRESOLVED', '导入的其他动作仍未核对。');
      }
    }
    const reviewLocated = await repositories.reviews.readByOperationId(located.id);
    const review = reviewLocated === undefined ? undefined : await repositories.reviews.lockRequest(reviewLocated.id);
    const op = await repositories.gateway.lockOperation(located.id);
    if (op === undefined || !originMatches(op, input.origin) || op.status === 'UNKNOWN') {
      throw gatewayDenied('GATEWAY_OPERATION_UNRESOLVED', '动作身份已失效或处于 UNKNOWN；必须先核对。');
    }
    if (op.status === 'SUCCEEDED' || op.status === 'FAILED' || op.status === 'DENIED' || op.status === 'DISPATCHING') {
      throw gatewayDenied('GATEWAY_OPERATION_SETTLED', '该动作已执行或不允许重复派发。');
    }
    const selected = await requireCurrentGatewayGrant(repositories, op, review);
    if (input.origin.kind === 'RUN' && run !== undefined && task !== undefined) {
      if (op.status === 'WAITING_APPROVAL') {
        if (run.status !== 'WAITING_APPROVAL' || task.status !== 'WAITING') {
          throw gatewayDenied('GATEWAY_RUN_NOT_READY', 'Run 不在等待该批准的状态。');
        }
      } else if (run.status !== 'RUNNING') {
        throw gatewayDenied('GATEWAY_RUN_NOT_READY', 'Run 不在执行状态。');
      }
    }
    let invocation = await repositories.gateway.lastInvocation(op.id);
    if (op.status === 'WAITING_APPROVAL' || invocation?.status === 'NOT_EXECUTED') {
      const nextNumber = (invocation?.attempt_number ?? 0n) + 1n;
      invocation = await createPreparedInvocation(repositories, authority.revision, op, run, task, resource, nextNumber);
      if (review !== undefined) {
        await repositories.gateway.reserveApproval(review.id, op.id);
        const reserved = await repositories.gateway.readReservation(review.id);
        if (reserved?.operation_id !== op.id) throw gatewayDenied('GATEWAY_APPROVAL_CONSUMED', '批准已绑定其他逻辑动作。');
        await repositories.gateway.bindInvocationApproval(invocation.id, review.id, op.id);
      }
    }
    if (invocation === undefined || invocation.status !== 'PREPARED' ||
        invocation.connection_version !== op.connection_version ||
        canonicalizeJson(invocation.connection_config) !== canonicalizeJson(op.connection_config)) {
      throw gatewayDenied('GATEWAY_INVOCATION_STALE', 'Invocation 准备事实不可用于此动作。');
    }
    if (run !== undefined && task !== undefined && resource !== undefined) {
      const claim = await repositories.gateway.activeClaim(resource.id);
      if (claim?.id !== invocation.resource_claim_id || claim.claim_token !== invocation.claim_token ||
          claim.claim_epoch !== invocation.claim_epoch || claim.worker_id !== run.worker_id ||
          claim.worker_epoch !== run.worker_epoch || invocation.ownership_epoch !== task.ownership_epoch) {
        throw gatewayDenied('GATEWAY_STALE_TOKEN', '资源 claim 或 Worker epoch 已失效。');
      }
    }
    const dispatched = await repositories.gateway.transitionInvocation(invocation.id, 'PREPARED', 'DISPATCHING');
    if (dispatched === undefined) throw gatewayDenied('GATEWAY_INVOCATION_STALE', 'Invocation 已被另一执行者准入。');
    await repositories.gateway.setOperationStatus(op.id, 'DISPATCHING');
    if (review !== undefined && selected.decision === 'ASK' && invocation.attempt_number === 1n) {
      // First consumption was saved with the invocation in this same transaction.
      const binding = await repositories.gateway.readReservation(review.id);
      if (binding?.operation_id !== op.id) throw new Error('approval reservation disappeared');
    }
    if (input.origin.kind === 'RUN' && run?.status === 'WAITING_APPROVAL' && task !== undefined) {
      const activated = await repositories.runs.advanceRun({ runId: run.id, expectedRevision: run.revision,
        status: 'RUNNING', waitReason: null, resumePhase: null });
      if (activated === undefined) throw new Error('Gateway approved Run CAS failed');
      const active = await repositories.tasks.applyTaskStatus({ taskId: task.id,
        expectedRevision: task.revision, fromStatus: 'WAITING', toStatus: 'IN_PROGRESS' });
      if (active === undefined) throw new Error('Gateway approved Task CAS failed');
    }
    if (input.origin.kind === 'USER_IMPORT') {
      await repositories.gateway.setImportJobStatus(input.origin.importJobId, 'RUNNING', null);
    }
    return { operation: op, invocation: dispatched };
  });
}

function fakeMarker(op: LogicalOperationRow): string {
  const content = op.params.content;
  if (typeof content !== 'string') throw new Error('Fake write operation has no validated content');
  return canonicalizeJson({ operation_id: op.id, params_hash: op.params_hash.toString('hex'),
    content });
}

async function fakeExecute(op: LogicalOperationRow, invocation: InvocationAttemptRow,
  signal?: AbortSignal): Promise<JsonObject> {
  if (signal?.aborted) throw new Error('Gateway dispatch aborted before Fake effect');
  if (op.capability_key === 'FAKE_PUBLIC_READ') {
    return { source_uri: op.normalized_target, content: `fake-public:${op.normalized_target}`,
      invocation_id: invocation.id };
  }
  // Check parent identity again before use; this Fake path is not a Windows process sandbox.
  const parent = await realpath(dirname(op.normalized_target));
  if (resolve(parent, basename(op.normalized_target)) !== op.normalized_target) throw new Error('target parent changed');
  if (signal?.aborted) throw new Error('Gateway dispatch aborted before Fake write');
  await writeFile(op.normalized_target, fakeMarker(op), {
    encoding: 'utf8', flag: 'wx', ...(signal === undefined ? {} : { signal }),
  });
  return { target: op.normalized_target, operation_id: op.id, invocation_id: invocation.id };
}

/** The inner Run claim can expire while the outer command invocation remains active. */
async function hasCurrentGatewayEffectLease(db: DbExecutor, admitted: AdmittedInvocation,
  origin: GatewayOrigin): Promise<boolean> {
  if (origin.kind !== 'RUN') return true;
  return withTransaction(db, async (repositories) => {
    const { task, run } = await lockTaskAndRun(repositories, origin.runId, admitted.operation.workspace_id);
    await ensureGraphDelivery(repositories, origin);
    const invocation = await repositories.gateway.readInvocation(admitted.invocation.id);
    const claim = admitted.invocation.resource_claim_id === null ? undefined
      : await repositories.gateway.readClaim(admitted.invocation.resource_claim_id);
    return task.executor_kind === 'AI' && task.executor_run_id === run.id &&
      task.ownership_epoch === admitted.invocation.ownership_epoch && run.status === 'RUNNING' &&
      run.worker_id === origin.workerId && run.worker_epoch === origin.workerEpoch &&
      run.worker_lease_until !== null && run.worker_lease_until.getTime() > Date.now() &&
      invocation?.status === 'DISPATCHING' && claim?.status === 'HELD' &&
      claim.worker_id === origin.workerId && claim.worker_epoch === origin.workerEpoch &&
      claim.claim_token === admitted.invocation.claim_token &&
      claim.claim_epoch === admitted.invocation.claim_epoch;
  });
}

async function settleGatewayInvocation(db: DbExecutor, admitted: AdmittedInvocation,
  status: 'SUCCEEDED' | 'UNKNOWN', resultRef: JsonObject,
  origin: GatewayOrigin): Promise<GatewayDispatchResult> {
  const op = admitted.operation;
  return withTransaction(db, async (repositories) => {
    let task: TaskRow | undefined;
    let run: RunRow | undefined;
    if (op.origin === 'RUN') {
      ({ task, run } = await lockTaskAndRun(repositories, op.run_id!, op.workspace_id));
      if (origin.kind === 'RUN') await ensureGraphDelivery(repositories, origin);
      await repositories.gateway.lockResource(op.resource_id!);
    } else {
      await repositories.gateway.lockImportJob(op.import_job_id!);
    }
    const lockedOp = await repositories.gateway.lockOperation(op.id);
    const invocation = await repositories.gateway.lockInvocation(admitted.invocation.id);
    if (lockedOp?.status !== 'DISPATCHING' || invocation?.status !== 'DISPATCHING') {
      throw gatewayDenied('GATEWAY_INVOCATION_STALE', '调用结果只能归属当前 DISPATCHING 身份。');
    }
    const claim = invocation.resource_claim_id === null ? undefined : await repositories.gateway.readClaim(invocation.resource_claim_id);
    const stale = op.origin === 'RUN' && (task?.executor_run_id !== run?.id ||
      task?.ownership_epoch !== invocation.ownership_epoch || run?.worker_id !== invocation.worker_id ||
      run?.worker_epoch !== invocation.worker_epoch || run.worker_lease_until === null ||
      run.worker_lease_until.getTime() <= Date.now() || claim?.status !== 'HELD' ||
      claim.worker_id !== invocation.worker_id || claim.worker_epoch !== invocation.worker_epoch ||
      claim.claim_token !== invocation.claim_token || claim.claim_epoch !== invocation.claim_epoch);
    const finalStatus = stale ? 'UNKNOWN' : status;
    const evidence: JsonObject = stale ? { reason: 'STALE_RESULT_RECONCILE', observed: resultRef } : resultRef;
    const resolved = await repositories.gateway.transitionInvocation(invocation.id, 'DISPATCHING', finalStatus, evidence);
    if (resolved === undefined) throw new Error('Invocation outcome CAS failed');
    await repositories.gateway.setOperationStatus(op.id, finalStatus, evidence);
    if (invocation.resource_claim_id !== null) {
      await repositories.gateway.setClaimStatus(invocation.resource_claim_id,
        finalStatus === 'SUCCEEDED' ? 'RELEASED' : 'QUARANTINED');
    }
    return { operation_id: op.id, invocation_id: invocation.id, status: finalStatus, result_ref: evidence };
  });
}

/** Admit commits before one FakeAdapter call. A crash leaves the same Invocation for reconciliation. */
export async function dispatchGatewayAction(db: DbExecutor, input: DispatchGatewayInput): Promise<GatewayDispatchResult> {
  let admitted: AdmittedInvocation;
  try {
    admitted = await admitGatewayInvocation(db, input);
  } catch (error) {
    if (input.origin.kind === 'RUN' && codeOf(error) === 'GATEWAY_RUN_NOT_READY') {
      await abandonPreparedForControl(db, input);
    }
    if (input.origin.kind === 'RUN' && await releaseUnadmittedApprovalClaim(db, input)) {
      await applySafeControl(db, input.origin.runId);
    }
    throw error;
  }
  await input.hooks?.afterAdmit?.();
  if (!(await hasCurrentGatewayEffectLease(db, admitted, input.origin))) {
    return settleGatewayInvocation(db, admitted, 'UNKNOWN',
      { reason: 'GATEWAY_EFFECT_FENCE_LOST_BEFORE_CALL' }, input.origin);
  }
  let result: JsonObject;
  try {
    result = await fakeExecute(admitted.operation, admitted.invocation, input.signal);
  } catch (error) {
    return settleGatewayInvocation(db, admitted, 'UNKNOWN', {
      reason: 'FAKE_EFFECT_UNCERTAIN', error_kind: error instanceof Error ? error.name : 'UNKNOWN',
    }, input.origin);
  }
  await input.hooks?.afterFakeEffect?.();
  return settleGatewayInvocation(db, admitted, 'SUCCEEDED', result, input.origin);
}

function codeOf(error: unknown): string | undefined {
  return error instanceof DomainError ? error.code : undefined;
}

/** Claim and Admit are separate transactions. A rejected approval may release only
 * its still-unadmitted Worker, never an Invocation with an uncertain effect. */
async function releaseUnadmittedApprovalClaim(db: DbExecutor, input: DispatchGatewayInput): Promise<boolean> {
  const origin = input.origin;
  if (origin.kind !== 'RUN') return false;
  return withTransaction(db, async (repositories) => {
    const { task, run } = await lockTaskAndRun(repositories, origin.runId, input.workspaceId);
    await ensureGraphDelivery(repositories, origin);
    if (run.worker_id !== origin.workerId || run.worker_epoch !== origin.workerEpoch ||
        run.status !== 'WAITING_APPROVAL' || task.executor_run_id !== run.id ||
        task.ownership_epoch !== run.ownership_epoch) return false;
    const op = await repositories.gateway.lockOperation(input.operationId);
    if (op === undefined || !originMatches(op, origin) || op.run_id !== run.id ||
        op.status !== 'WAITING_APPROVAL' ||
        await repositories.gateway.lastInvocation(op.id) !== undefined ||
        (await repositories.recovery.listUnresolvedEffects(run.id)).length > 0) return false;
    await repositories.runs.releaseWorker(run.id, origin.workerId, origin.workerEpoch);
    return true;
  });
}

/** A fixed graph action may end only on a proven pre-invocation authorization refusal.
 * DISPATCHING/UNKNOWN is deliberately excluded: it needs stopped-process reconciliation. */
export async function denyGraphActionBeforeInvocation(db: DbExecutor, input: {
  readonly workspaceId: string; readonly runId: string; readonly operationId: string;
  readonly resourceId: string; readonly workerId: string; readonly workerEpoch?: bigint;
  readonly delivery: { readonly commandId: string; readonly invocationEpoch: bigint };
  readonly reason: string;
}): Promise<boolean> {
  return withTransaction(db, async (repositories) => {
    const { task, run } = await lockTaskAndRun(repositories, input.runId, input.workspaceId);
    if (task.executor_run_id !== run.id || task.ownership_epoch !== run.ownership_epoch ||
        !['WAITING_APPROVAL', 'RUNNING'].includes(run.status) ||
        !(await repositories.dispatch.hasCurrentCommandInvocation(run.id,
          input.delivery.commandId, input.workerId, input.delivery.invocationEpoch))) return false;
    if ((await repositories.recovery.lockPendingControl(run.id)) !== undefined) return false;
    if (run.worker_id !== null && (run.worker_id !== input.workerId ||
        run.worker_epoch !== input.workerEpoch)) return false;
    const resource = await repositories.gateway.lockResource(input.resourceId);
    if (resource?.workspace_id !== input.workspaceId) return false;
    const operation = await repositories.gateway.lockOperation(input.operationId);
    if (operation?.origin !== 'RUN' || operation.run_id !== run.id ||
        operation.resource_id !== resource.id ||
        !['WAITING_APPROVAL', 'PREPARED'].includes(operation.status)) return false;
    const last = await repositories.gateway.lastInvocation(operation.id);
    if (last !== undefined && !['PREPARED', 'NOT_EXECUTED'].includes(last.status)) return false;
    if (last?.status === 'PREPARED') {
      const stopped = await repositories.gateway.transitionInvocation(last.id, 'PREPARED',
        'NOT_EXECUTED', { reason: input.reason });
      if (stopped === undefined) throw new Error('pre-invocation deny CAS failed');
      if (last.resource_claim_id !== null) {
        await repositories.gateway.setClaimStatus(last.resource_claim_id, 'RELEASED');
      }
    }
    await repositories.gateway.setOperationStatus(operation.id, 'DENIED', { reason: input.reason });
    if (run.worker_id !== null && input.workerEpoch !== undefined) {
      const released = await repositories.runs.releaseWorker(run.id, input.workerId, input.workerEpoch);
      if (released === undefined) throw new Error('pre-invocation deny Worker release failed');
    }
    const failed = await repositories.runs.advanceRun({ runId: run.id,
      expectedRevision: run.revision, status: 'FAILED',
      currentStepId: run.current_step_id, waitReason: input.reason, terminal: true });
    if (failed === undefined) throw new Error('pre-invocation deny Run CAS failed');
    const releasedTask = await repositories.tasks.releaseExecutionFromRun({
      taskId: task.id, runId: run.id, expectedRevision: task.revision, toStatus: 'READY',
    });
    if (releasedTask === undefined) throw new Error('pre-invocation deny Task CAS failed');
    await repositories.activities.insertActivityRecord({ id: randomUUID(), actorKind: 'SYSTEM',
      actorRef: `run:${run.id}`, commandId: null, projectId: task.project_id,
      taskId: task.id, eventType: 'RUN_FAILED',
      factRefs: { run_id: run.id, operation_id: operation.id, reason: input.reason } });
    return true;
  });
}

/** A PENDING control wins before Admit: PREPARED has no external effect to reconcile. */
async function abandonPreparedForControl(db: DbExecutor, input: DispatchGatewayInput): Promise<void> {
  const origin = input.origin;
  if (origin.kind !== 'RUN') return;
  const abandoned = await withTransaction(db, async (repositories) => {
    const { task, run } = await lockTaskAndRun(repositories, origin.runId, input.workspaceId);
    await ensureGraphDelivery(repositories, origin);
    if ((await repositories.recovery.lockPendingControl(run.id)) === undefined ||
        run.worker_id !== origin.workerId || run.worker_epoch !== origin.workerEpoch ||
        task.executor_run_id !== run.id) return false;
    const resource = await repositories.gateway.lockResource(origin.resourceId);
    if (resource === undefined) return false;
    const op = await repositories.gateway.lockOperation(input.operationId);
    const invocation = op === undefined ? undefined : await repositories.gateway.lastInvocation(op.id);
    if (op?.run_id !== run.id || op.status !== 'PREPARED' || invocation?.status !== 'PREPARED' ||
        invocation.worker_id !== run.worker_id || invocation.worker_epoch !== run.worker_epoch) return false;
    const changed = await repositories.gateway.transitionInvocation(invocation.id, 'PREPARED', 'NOT_EXECUTED',
      { reason: 'CONTROL_PREEMPTED_BEFORE_ADMIT' });
    if (changed === undefined) throw new Error('Gateway prepared abandon CAS failed');
    await repositories.gateway.setOperationStatus(op.id, 'DENIED', { reason: 'CONTROL_PREEMPTED_BEFORE_ADMIT' });
    if (invocation.resource_claim_id !== null) await repositories.gateway.setClaimStatus(invocation.resource_claim_id, 'RELEASED');
    await repositories.runs.releaseWorker(run.id, run.worker_id!, run.worker_epoch);
    return true;
  });
  if (abandoned) await applySafeControl(db, origin.runId);
}

export async function readGatewayOperation(db: DbExecutor, workspaceId: string,
  operationId: string): Promise<{ readonly operation: LogicalOperationRow;
  readonly invocations: readonly InvocationAttemptRow[] }> {
  const repositories = createRepositories(db);
  const op = await repositories.gateway.readOperation(operationId);
  if (op?.workspace_id !== workspaceId) throw resourceNotFound('Gateway operation');
  return { operation: op, invocations: await repositories.gateway.listInvocations(op.id) };
}

export async function reconcileGatewayInvocation(db: DbExecutor, input: {
  readonly workspaceId: string; readonly operationId: string; readonly invocationId: string;
  /** Caller is the process supervisor; expiry of the Worker lease is not proof of stop. */
  readonly stoppedWorkerId?: string; readonly stoppedWorkerEpoch?: bigint;
  readonly oldProcessStopped: true;
}): Promise<{ readonly status: 'SUCCEEDED' | 'NOT_EXECUTED' | 'UNKNOWN'; readonly operation_id: string }> {
  if (input.oldProcessStopped !== true) throw invalidTransition('必须由恢复调用方确认旧执行进程已退出。');
  const repositories = createRepositories(db);
  const op = await repositories.gateway.readOperation(input.operationId);
  const invocation = await repositories.gateway.readInvocation(input.invocationId);
  if (op?.workspace_id !== input.workspaceId || invocation?.operation_id !== op.id ||
      !['PREPARED', 'DISPATCHING', 'UNKNOWN'].includes(invocation.status)) throw resourceNotFound('Unresolved invocation');
  let observed: 'PRESENT' | 'MISSING' | 'MISMATCH';
  if (invocation.status === 'PREPARED' || op.capability_key === 'FAKE_PUBLIC_READ') {
    observed = 'MISSING';
  } else {
    try { observed = (await readFile(op.normalized_target, 'utf8')) === fakeMarker(op) ? 'PRESENT' : 'MISMATCH'; }
    catch (error) { observed = (error as NodeJS.ErrnoException).code === 'ENOENT' ? 'MISSING' : 'MISMATCH'; }
  }
  return withTransaction(db, async (tx) => {
    let run: RunRow | undefined;
    if (op.origin === 'RUN') {
      ({ run } = await lockTaskAndRun(tx, op.run_id!, op.workspace_id));
      if (invocation.worker_id !== input.stoppedWorkerId || invocation.worker_epoch !== input.stoppedWorkerEpoch) {
        throw gatewayDenied('GATEWAY_STOP_PROOF_MISMATCH', '停机依据与未决 Invocation 的 Worker 身份不一致。');
      }
      if (run.worker_id !== null && (run.worker_id !== invocation.worker_id ||
          run.worker_epoch !== invocation.worker_epoch)) {
        throw gatewayDenied('GATEWAY_STALE_WORKER', '另一个 Worker 已占有 Run，不能核对旧结果。');
      }
      await tx.gateway.lockResource(op.resource_id!);
    } else {
      await tx.gateway.lockImportJob(op.import_job_id!);
    }
    const lockedOp = await tx.gateway.lockOperation(op.id);
    const lockedInvocation = await tx.gateway.lockInvocation(invocation.id);
    if (lockedOp === undefined || lockedInvocation === undefined ||
        !['PREPARED', 'DISPATCHING', 'UNKNOWN'].includes(lockedInvocation.status)) {
      throw gatewayDenied('GATEWAY_INVOCATION_STALE', '未决调用已经变化。');
    }
    if (run?.worker_id !== null && run !== undefined) await tx.runs.fenceWorker(run.id);
    // Once DISPATCHING committed, a missing target could have been written and
    // removed by an external actor. Only PREPARED proves no adapter call began.
    const status = observed === 'PRESENT' ? 'SUCCEEDED'
      : observed === 'MISSING' && (lockedInvocation.status === 'PREPARED' || op.capability_key === 'FAKE_PUBLIC_READ')
        ? 'NOT_EXECUTED' : 'UNKNOWN';
    const changed = await tx.gateway.transitionInvocation(invocation.id, lockedInvocation.status, status,
      { reconciliation: observed, invocation_id: invocation.id });
    if (changed === undefined) throw new Error('reconciliation CAS failed');
    await tx.gateway.setOperationStatus(op.id, status === 'NOT_EXECUTED' ? 'PREPARED' : status,
      { reconciliation: observed, invocation_id: invocation.id });
    if (invocation.resource_claim_id !== null) await tx.gateway.setClaimStatus(invocation.resource_claim_id,
      status === 'UNKNOWN' ? 'QUARANTINED' : 'RELEASED');
    return { status, operation_id: op.id };
  });
}
