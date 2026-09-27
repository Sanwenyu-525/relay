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
import { lockWritableProjectInWorkspace } from './guards.js';
import { createRepositories, withTransaction, type Repositories } from './unit-of-work.js';
import { requireCurrentRuleSnapshot } from './rule-fence.js';
import { hasCurrentRunContext } from './context-fence.js';
import { readMockActionOperationId } from '../workflow/execution-contract.js';
import { readWebFetchConfig, webFetchExecute, type WebFetchLimits } from '../web/web-fetch.js';
import {
  executeFileChangeset, reconcileFileChangeset, validateSafeRelativePath, isProtectedPath,
  isFrozenBaseline, type FileChange, type FileChangeOutcome, type FileReconciliationCheck,
} from '../files/file-changeset.js';
import type { ChangeSetLedgerFile, ChangeSetLedgerHeader } from '../files/change-set-repository.js';
import type { ChangeSetFileStatus, ChangeSetStatus } from '../infrastructure/database-schema.js';
import {
  gitGetStatus, gitGetDiff, gitGetLog, gitStageFile, gitCommit, gitPush,
  reconcileGitCommit, reconcileGitPush,
} from '../git/git-adapter.js';
import { executeCliCommand, reconcileCliExecution } from '../cli-worker/cli-adapter.js';
import { getAdapterDescriptor } from '../gateway/adapter-metadata.js';

/** Test-only narrowing of WEB_FETCH budgets (production dispatch passes none). */
type DispatchWebFetchLimits = Partial<WebFetchLimits>;

export type GatewayOrigin =
  | { readonly kind: 'RUN'; readonly runId: string; readonly stepId: string;
      readonly resourceId?: string; readonly workerId: string; readonly workerEpoch: bigint;
      readonly delivery?: { readonly commandId: string; readonly invocationEpoch: bigint } }
  | { readonly kind: 'USER_IMPORT'; readonly importJobId: string;
      readonly actorRef: string; readonly configVersion: string };

export type GatewayActionType =
  | 'WRITE_MARKER'
  | 'READ_PUBLIC'
  | 'READ_FILE'
  | 'WEB_FETCH'
  | 'WRITE_FILE'
  | 'APPLY_CHANGESET'
  | 'GIT_STATUS'
  | 'GIT_DIFF'
  | 'GIT_LOG'
  | 'GIT_STAGE'
  | 'GIT_COMMIT'
  | 'GIT_PUSH'
  | 'RUN_BUILD'
  | 'RUN_TEST'
  | 'CLI_RUN';

export interface PrepareGatewayActionInput {
  readonly workspaceId: string;
  readonly operationId: string;
  readonly intentKey: string;
  readonly connectionId: string;
  readonly origin: GatewayOrigin;
  readonly actionType: GatewayActionType;
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
  readonly status: 'SUCCEEDED' | 'UNKNOWN' | 'FAILED';
  readonly result_ref: JsonObject | null;
}

export class SimulatedGatewayCrash extends Error {
  override readonly name = 'SimulatedGatewayCrash';
}

function gatewayDenied(code: string, detail: string, retryable = false): DomainError {
  return new DomainError({ code, status: 409, type: `/problems/${code.toLowerCase().replaceAll('_', '-')}`,
    title: 'Gateway 拒绝执行', detail, retryable, retryAction: retryable ? 'POLL_RESOURCE' : 'REFRESH_AND_REDECIDE' });
}

function capabilityFor(action: GatewayActionType): GatewayCapability {
  if (action === 'WRITE_MARKER') return 'FAKE_WRITE';
  if (action === 'READ_FILE') return 'FILE_READ';
  if (action === 'WEB_FETCH') return 'WEB_FETCH';
  if (action === 'WRITE_FILE' || action === 'APPLY_CHANGESET') return 'FILE_WRITE';
  if (action === 'GIT_STATUS' || action === 'GIT_DIFF' || action === 'GIT_LOG') return 'GIT_READ';
  if (action === 'GIT_STAGE' || action === 'GIT_COMMIT' || action === 'GIT_PUSH') return 'GIT_WRITE';
  if (action === 'RUN_BUILD' || action === 'RUN_TEST' || action === 'CLI_RUN') return 'CLI_RUN';
  return 'FAKE_PUBLIC_READ';
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

/** Reads require an existing regular file; realpath pins the exact frozen path and
 * rejects links or reparse points that could retarget the read outside the root. */
async function normalizedReadTarget(target: string, root: string): Promise<string> {
  if (!isAbsolute(target)) throw validationFailed([{ field: 'target', message: 'must be absolute' }]);
  const resolved = resolve(target);
  if (!containsPath(root, resolved)) throw gatewayDenied('GATEWAY_TARGET_DENIED', '目标不在已登记资源根内。');
  let canonical: string;
  try {
    canonical = await realpath(resolved);
    const entry = await lstat(resolved);
    if (entry.isSymbolicLink() || !entry.isFile()) {
      throw gatewayDenied('GATEWAY_TARGET_DENIED', '目标不是普通文件或经链接重定向。');
    }
  } catch (error) {
    if (error instanceof DomainError) throw error;
    throw gatewayDenied('GATEWAY_TARGET_DENIED', '目标文件不存在或无法安全规范化。');
  }
  if (!containsPath(root, canonical)) throw gatewayDenied('GATEWAY_TARGET_DENIED', '目标经链接逃逸出已登记资源根。');
  return canonical;
}

/** WEB_FETCH normalization is syntactic at prepare: http(s) only, no userinfo,
 * no fragment, lowercase host. The allowed-host and resolved-address checks
 * happen inside the admit transaction and again on every executed hop. */
export function normalizedWebTarget(target: string): string {
  let url: URL;
  try { url = new URL(target); } catch { throw validationFailed([{ field: 'target', message: 'invalid URL' }]); }
  if ((url.protocol !== 'https:' && url.protocol !== 'http:') || url.username || url.password ||
      url.hash !== '' || url.hostname === '') {
    throw gatewayDenied('GATEWAY_TARGET_DENIED', 'WEB_FETCH 仅接受无用户信息、无片段的 http(s) URL。');
  }
  url.hash = '';
  url.hostname = url.hostname.toLowerCase();
  return url.toString();
}

function webFetchAllowedHost(config: JsonObject): string {
  return readWebFetchConfig(config).allowedHost;
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
  if (capability === 'WEB_FETCH') {
    // WEB_FETCH policies match by URL host (the web analogue of a path prefix).
    try {
      return new URL(target).hostname.toLowerCase() === prefix.toLowerCase();
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
  const allowedRunCaps: GatewayCapability[] = [
    'FAKE_WRITE', 'FILE_READ', 'WEB_FETCH', 'FILE_WRITE', 'GIT_READ', 'GIT_WRITE', 'CLI_RUN',
  ];
  if (input.origin.kind === 'RUN' ? !allowedRunCaps.includes(capability)
    : !['FAKE_PUBLIC_READ', 'WEB_FETCH'].includes(capability)) {
    throw gatewayDenied('GATEWAY_ORIGIN_DENIED', 'RUN 仅允许受管工具调用，USER_IMPORT 仅允许公共网络导入。');
  }
  // WEB_FETCH targets a URL, not a filesystem working area: it binds no managed
  // resource and therefore takes no resource claim (reads need no exclusivity).
  const webFetch = input.actionType === 'WEB_FETCH';
  const resourceBefore = input.origin.kind === 'RUN' && !webFetch
    ? await createRepositories(db).gateway.readResource(input.origin.resourceId ?? '') : undefined;
  if (input.origin.kind === 'RUN' && !webFetch &&
      (resourceBefore === undefined || resourceBefore.workspace_id !== input.workspaceId)) {
    throw resourceNotFound('Managed resource');
  }

  let target: string;
  if (input.origin.kind === 'RUN') {
    if (webFetch) {
      target = normalizedWebTarget(input.target);
    } else if (input.actionType === 'READ_FILE') {
      target = await normalizedReadTarget(input.target, resourceBefore!.canonical_root);
    } else if (input.actionType === 'WRITE_FILE') {
      target = await normalizedWriteTarget(input.target, resourceBefore!.canonical_root);
      const rel = relative(resourceBefore!.canonical_root, target);
      if (isProtectedPath(rel)) {
        throw gatewayDenied('GATEWAY_TARGET_DENIED', `目标路径 ${rel} 属于受保护路径，禁止写入。`);
      }
      if (typeof input.params.content !== 'string') {
        throw validationFailed([{ field: 'params.content', message: 'must be a string' }]);
      }
    } else if (input.actionType === 'APPLY_CHANGESET') {
      target = resourceBefore!.canonical_root;
      if (!Array.isArray(input.params.changes) || input.params.changes.length === 0) {
        throw validationFailed([{ field: 'params.changes', message: 'must be a non-empty array' }]);
      }
      for (const [idx, item] of (input.params.changes as any[]).entries()) {
        if (!item || typeof item.path !== 'string' || !['CREATE', 'MODIFY', 'DELETE'].includes(item.action)) {
          throw validationFailed([{ field: `params.changes[${idx}]`, message: 'invalid change item' }]);
        }
        try {
          validateSafeRelativePath(resourceBefore!.canonical_root, item.path);
        } catch (err) {
          throw gatewayDenied('GATEWAY_TARGET_DENIED', (err as Error).message);
        }
        // P1-2：修改/删除既有文件必须在产生副作用前冻结有效基线摘要，供落盘前比对
        // 检测外部编辑；缺失或格式非法在批准之前即按输入校验拒绝，人工批准不可替代。
        if ((item.action === 'MODIFY' || item.action === 'DELETE') && !isFrozenBaseline(item.baselineSha256)) {
          throw validationFailed([{ field: `params.changes[${idx}].baselineSha256`,
            message: 'MODIFY/DELETE requires a valid 64-hex frozen baseline sha256' }]);
        }
      }
    } else if (['GIT_STATUS', 'GIT_DIFF', 'GIT_LOG', 'GIT_STAGE', 'GIT_COMMIT', 'GIT_PUSH'].includes(input.actionType)) {
      target = resourceBefore!.canonical_root;
      if (input.actionType === 'GIT_STAGE') {
        if (typeof input.params.file_path !== 'string' || input.params.file_path === '.' || input.params.file_path === '*') {
          throw validationFailed([{ field: 'params.file_path', message: 'must be a specific file path' }]);
        }
      } else if (input.actionType === 'GIT_COMMIT') {
        if (typeof input.params.message !== 'string' || input.params.message.trim() === '') {
          throw validationFailed([{ field: 'params.message', message: 'commit message is required' }]);
        }
      } else if (input.actionType === 'GIT_PUSH') {
        if (typeof input.params.remote !== 'string' || typeof input.params.ref !== 'string' ||
            input.params.remote.startsWith('-') || input.params.ref.startsWith('-') || input.params.ref.startsWith('+')) {
          throw validationFailed([{ field: 'params.remote', message: 'invalid remote or force-push ref' }]);
        }
      }
    } else if (['RUN_BUILD', 'RUN_TEST', 'CLI_RUN'].includes(input.actionType)) {
      target = resourceBefore!.canonical_root;
      if (typeof input.params.executable !== 'string' || input.params.executable.trim() === '') {
        throw validationFailed([{ field: 'params.executable', message: 'executable is required' }]);
      }
      if (!Array.isArray(input.params.args) || !input.params.args.every((a: any) => typeof a === 'string')) {
        throw validationFailed([{ field: 'params.args', message: 'args must be an array of strings' }]);
      }
    } else {
      target = await normalizedWriteTarget(input.target, resourceBefore!.canonical_root);
    }
  } else {
    target = webFetch ? normalizedWebTarget(input.target) : normalizedPublicTarget(input.target);
  }

  if (input.actionType === 'WRITE_MARKER' && typeof input.params.content !== 'string') {
    throw validationFailed([{ field: 'params.content', message: 'must be a string' }]);
  }
  if ((input.actionType === 'READ_PUBLIC' || input.actionType === 'READ_FILE' ||
      input.actionType === 'WEB_FETCH') && Object.keys(input.params).length !== 0) {
    throw validationFailed([{ field: 'params', message: 'read actions take no parameters' }]);
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
      if (!webFetch) {
        resource = await repositories.gateway.lockResource(input.origin.resourceId ?? '');
        if (resource?.project_id !== projectId || resource.workspace_id !== input.workspaceId ||
            resource.identity_key !== resourceBefore?.identity_key || resource.status !== 'ACTIVE') throw resourceNotFound('Managed resource');
      }
    } else {
      const job = await repositories.gateway.lockImportJob(input.origin.importJobId);
      if (job?.workspace_id !== input.workspaceId || job.actor_ref !== input.origin.actorRef ||
          job.config_version !== input.origin.configVersion || job.source_uri !== target ||
          !['QUEUED', 'RUNNING'].includes(job.status)) throw gatewayDenied('GATEWAY_IMPORT_STALE', '导入来源、用户或配置已失效。');
      projectId = job.project_id;
      await lockWritableProjectInWorkspace(repositories, input.workspaceId, projectId);
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
    if (webFetch) {
      // Host allowlist is the connection's registered boundary; it is re-checked
      // on every executed hop against redirects as well.
      const url = new URL(target);
      if (url.hostname.toLowerCase() !== webFetchAllowedHost(connection.config)) {
        throw gatewayDenied('GATEWAY_TARGET_DENIED', '目标主机不在 WEB_FETCH 连接的允许列表内。');
      }
    }
    const policy = await selectedPolicy(repositories, { workspaceId: input.workspaceId, projectId,
      capability, actionType: input.actionType, target, payloadBytes });

    // Non-passthrough adapters (e.g. file mutations, git writes, cli executions)
    // CANNOT execute automatically without review approval.
    const descriptor = getAdapterDescriptor(capability);
    const effectiveDecision: GatewayDecision =
      !descriptor.approvalPassthrough && policy.decision === 'AUTO' ? 'ASK' : policy.decision;

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
      resource_id: resource?.id ?? null, status: effectiveDecision === 'ASK' ? 'WAITING_APPROVAL' : 'PREPARED' });
    if (effectiveDecision === 'ASK') {
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
    importJobId: op.import_job_id,
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
  /** Adapter deadline (e.g. the Worker execution lease); FILE_READ checks it before reading. */
  readonly deadline?: Date | null;
  /** Deterministic test-only narrowing of WEB_FETCH budgets; production passes none. */
  readonly limits?: DispatchWebFetchLimits | undefined;
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
      op.resource_id === (origin.resourceId ?? null)
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
  // Mirror the prepare-time downgrade: a non-passthrough adapter forces ASK even
  // when the stored policy says AUTO, so the Review that prepare created here is the
  // *expected* effective grant rather than a stale one. Without this, approved real
  // writes (FILE_WRITE / GIT_WRITE / CLI_RUN) would be rejected as GATEWAY_APPROVAL_STALE.
  const effectiveDecision: GatewayDecision =
    !getAdapterDescriptor(op.capability_key).approvalPassthrough && selected.decision === 'AUTO'
      ? 'ASK' : selected.decision;
  if (effectiveDecision === 'ASK') {
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
        readMockActionOperationId(contract.frozen_snapshot);
      if (frozenAction === located.id &&
          !(await hasCurrentRunContext(repositories, run, task, authority))) {
        throw gatewayDenied('GATEWAY_CONTEXT_STALE', 'Run 的 Context 来源已变化，原动作不得准入。');
      }
      if (located.capability_key !== 'WEB_FETCH') {
        resource = await repositories.gateway.lockResource(input.origin.resourceId ?? '');
        if (resource?.project_id !== located.project_id || resource.workspace_id !== input.workspaceId ||
            resource.status !== 'ACTIVE') {
          throw resourceNotFound('Managed resource');
        }
      }
    } else {
      const job = await repositories.gateway.lockImportJob(input.origin.importJobId);
      if (job?.workspace_id !== input.workspaceId || job.project_id !== located.project_id ||
          job.actor_ref !== input.origin.actorRef || job.config_version !== input.origin.configVersion ||
          job.source_uri !== located.normalized_target || !['QUEUED', 'RUNNING'].includes(job.status)) {
        throw gatewayDenied('GATEWAY_IMPORT_STALE', '用户导入来源或状态已失效。');
      }
      await lockWritableProjectInWorkspace(repositories, input.workspaceId, job.project_id);
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
    // WEB_FETCH binds no resource and takes no claim: the fence then rests on
    // the Run/Worker identity and the DISPATCHING invocation alone.
    const claim = admitted.invocation.resource_claim_id === null ? undefined
      : await repositories.gateway.readClaim(admitted.invocation.resource_claim_id);
    return task.executor_kind === 'AI' && task.executor_run_id === run.id &&
      task.ownership_epoch === admitted.invocation.ownership_epoch && run.status === 'RUNNING' &&
      run.worker_id === origin.workerId && run.worker_epoch === origin.workerEpoch &&
      run.worker_lease_until !== null && run.worker_lease_until.getTime() > Date.now() &&
      invocation?.status === 'DISPATCHING' &&
      (claim === undefined ? invocation.resource_claim_id === null
        : claim.status === 'HELD' && claim.worker_id === origin.workerId &&
          claim.worker_epoch === origin.workerEpoch &&
          claim.claim_token === admitted.invocation.claim_token &&
          claim.claim_epoch === admitted.invocation.claim_epoch);
  });
}

/** 逐文件观测：承接 executeFileChangeset 结果或 reconcileFileChangeset 回读；纯内存，无磁盘访问。 */
interface FileObservation {
  readonly path: string;
  readonly status: ChangeSetFileStatus;
  /** 本次尝试之后该路径上实际内容的摘要；null 表示不存在（DELETE 的成功形态）。 */
  readonly actualSha256: string | null;
  /** 执行前实测到的当前内容摘要；核对阶段无法回看前像时为 null。 */
  readonly observedBaselineSha256: string | null;
  readonly error: string | null;
}

/** 变化集账本草稿：冻结输入 + 逐文件观测 + 执行时使用的规范根。 */
interface ChangeSetDraft {
  readonly canonicalRoot: string;
  readonly inputChanges: readonly FileChange[];
  readonly observations: readonly FileObservation[];
}

function targetShaOfContent(content: string): string {
  return createHash('sha256').update(content).digest('hex');
}

/** 预期目标摘要：DELETE 期望文件不存在（null）；否则取冻结目标或按内容计算。 */
function expectedTargetOf(change: FileChange): string | null {
  if (change.action === 'DELETE') return null;
  return change.targetSha256 ?? (change.content !== undefined ? targetShaOfContent(change.content) : null);
}

/** executeFileChangeset 的结果 → 观测。适配器不重读文件：APPLIED 的实际摘要就是写入内容的目标摘要， */
/** 未落盘的 CONFLICT/FAILED 则保留执行前实测内容——它仍代表当前磁盘现状。 */
function executionObservations(outcomes: readonly FileChangeOutcome[]): FileObservation[] {
  return outcomes.map((outcome) => ({
    path: outcome.path,
    status: outcome.status,
    actualSha256: outcome.status === 'APPLIED'
      ? (outcome.action === 'DELETE' ? null : (outcome.targetSha256 ?? null))
      : (outcome.actualBaselineSha256 ?? null),
    observedBaselineSha256: outcome.actualBaselineSha256 ?? null,
    error: outcome.error ?? null,
  }));
}

/** reconcileFileChangeset 的回读 → 观测。命中目标摘要才记 APPLIED；未命中按「没落地」与 */
/** 「内容不符」区分 FAILED/CONFLICT，整体状态由调用方保守收敛为 UNKNOWN。 */
function reconciliationObservations(checks: readonly FileReconciliationCheck[]): FileObservation[] {
  return checks.map((check) => ({
    path: check.path,
    status: check.matches ? 'APPLIED' : (check.actualSha === null ? 'FAILED' : 'CONFLICT'),
    actualSha256: check.actualSha,
    observedBaselineSha256: null,
    error: check.matches ? null : 'RECONCILE_UNCONFIRMED',
  }));
}

/** 以冻结输入为准逐条对齐观测：声明侧取准备期事实，观测侧取真实落盘或回读结果。 */
function ledgerFiles(draft: ChangeSetDraft): ChangeSetLedgerFile[] {
  const byPath = new Map(draft.observations.map((item) => [item.path, item]));
  return draft.inputChanges.map((change) => {
    const observation: FileObservation = byPath.get(change.path) ?? {
      path: change.path, status: 'FAILED', actualSha256: null, observedBaselineSha256: null,
      error: 'NO_OUTCOME_RECORDED',
    };
    return {
      relative_path: change.path, action: change.action,
      baseline_sha256: change.baselineSha256 ?? null,
      observed_baseline_sha256: observation.observedBaselineSha256,
      target_sha256: expectedTargetOf(change),
      actual_sha256: observation.actualSha256,
      status: observation.status, error: observation.error, diff_ref: null,
    };
  });
}

/**
 * 账本作用域取自已锁定的 operation/invocation 事实。FILE_WRITE 只允许 RUN 来源且必带受管
 * 资源（0030 CHECK）；万一归属缺失就不写账本，也不用空值伪造一行证据（外键会拒绝，
 * 结算事务不应因账本本身失败而丢掉调用结果）。
 */
function ledgerHeader(op: LogicalOperationRow, invocationId: string,
  canonicalRoot: string): ChangeSetLedgerHeader | undefined {
  if (op.run_id === null || op.resource_id === null) return undefined;
  return {
    workspace_id: op.workspace_id, project_id: op.project_id,
    run_id: op.run_id, resource_id: op.resource_id,
    operation_id: op.id, invocation_id: invocationId,
    action_type: op.action_type === 'WRITE_FILE' ? 'WRITE_FILE' : 'APPLY_CHANGESET',
    canonical_root: canonicalRoot,
  };
}

/**
 * 整体状态：全部落盘 SUCCEEDED；执行报告存在冲突/失败为 PARTIAL（部分应用不整体成功）；
 * 结果无法归属本次调用时 UNKNOWN，等待核对，不写成功。
 */
function ledgerStatus(files: readonly ChangeSetLedgerFile[],
  settled: 'SUCCEEDED' | 'UNKNOWN' | 'FAILED'): ChangeSetStatus {
  if (settled === 'UNKNOWN') return 'UNKNOWN';
  return files.every((file) => file.status === 'APPLIED') ? 'SUCCEEDED' : 'PARTIAL';
}

/** WRITE_FILE 的单文件退化变化集：执行与核对共用同一构造，账本与磁盘动作不会各自漂移。 */
function fileWriteInputChanges(op: LogicalOperationRow): FileChange[] {
  const baselineSha = typeof op.params.baseline_sha256 === 'string' ? op.params.baseline_sha256 : null;
  const content = typeof op.params.content === 'string' ? op.params.content : '';
  return [{
    path: relative(dirname(op.normalized_target), op.normalized_target),
    action: baselineSha ? 'MODIFY' : 'CREATE',
    baselineSha256: baselineSha,
    content,
    targetSha256: targetShaOfContent(content),
  }];
}

async function settleGatewayInvocation(db: DbExecutor, admitted: AdmittedInvocation,
  status: 'SUCCEEDED' | 'UNKNOWN' | 'FAILED', resultRef: JsonObject,
  origin: GatewayOrigin): Promise<GatewayDispatchResult> {
  const op = admitted.operation;
  return withTransaction(db, async (repositories) => {
    let task: TaskRow | undefined;
    let run: RunRow | undefined;
    if (op.origin === 'RUN') {
      ({ task, run } = await lockTaskAndRun(repositories, op.run_id!, op.workspace_id));
      if (origin.kind === 'RUN') await ensureGraphDelivery(repositories, origin);
      // WEB_FETCH binds no managed resource, so there is no claim row to lock.
      if (op.resource_id !== null) await repositories.gateway.lockResource(op.resource_id);
    } else {
      await repositories.gateway.lockImportJob(op.import_job_id!);
      await lockWritableProjectInWorkspace(repositories, op.workspace_id, op.project_id);
    }
    const lockedOp = await repositories.gateway.lockOperation(op.id);
    const invocation = await repositories.gateway.lockInvocation(admitted.invocation.id);
    if (lockedOp?.status !== 'DISPATCHING' || invocation?.status !== 'DISPATCHING') {
      throw gatewayDenied('GATEWAY_INVOCATION_STALE', '调用结果只能归属当前 DISPATCHING 身份。');
    }
    const claim = invocation.resource_claim_id === null ? undefined : await repositories.gateway.readClaim(invocation.resource_claim_id);
    // WEB_FETCH invocations carry no claim: staleness then rests on the
    // Run/Worker identity and the DISPATCHING invocation alone.
    const claimStale = claim === undefined
      ? invocation.resource_claim_id !== null
      : claim.status !== 'HELD' || claim.worker_id !== invocation.worker_id ||
        claim.worker_epoch !== invocation.worker_epoch ||
        claim.claim_token !== invocation.claim_token || claim.claim_epoch !== invocation.claim_epoch;
    const stale = op.origin === 'RUN' && (task?.executor_run_id !== run?.id ||
      task?.ownership_epoch !== invocation.ownership_epoch || run?.worker_id !== invocation.worker_id ||
      run?.worker_epoch !== invocation.worker_epoch || run.worker_lease_until === null ||
      run.worker_lease_until.getTime() <= Date.now() || claimStale);
    const finalStatus = stale ? 'UNKNOWN' : status;
    const evidence: JsonObject = stale ? { reason: 'STALE_RESULT_RECONCILE', observed: resultRef } : resultRef;
    const resolved = await repositories.gateway.transitionInvocation(invocation.id, 'DISPATCHING', finalStatus, evidence);
    if (resolved === undefined) throw new Error('Invocation outcome CAS failed');
    await repositories.gateway.setOperationStatus(op.id, finalStatus, evidence);
    if (invocation.resource_claim_id !== null) {
      // A read never mutates the resource, so even a FAILED read releases its claim.
      const released = finalStatus === 'SUCCEEDED' ||
        op.capability_key === 'FILE_READ' || op.capability_key === 'WEB_FETCH';
      await repositories.gateway.setClaimStatus(invocation.resource_claim_id,
        released ? 'RELEASED' : 'QUARANTINED');
    }
    if (!stale && op.capability_key === 'FILE_WRITE' && Array.isArray(evidence.changes)) {
      // M06 增量A：把真实执行后的逐文件结果固化为不可变账本，与结算同事务提交，无磁盘访问。
      const canonicalRoot = op.action_type === 'APPLY_CHANGESET'
        ? op.normalized_target : dirname(op.normalized_target);
      const header = ledgerHeader(op, invocation.id, canonicalRoot);
      if (header !== undefined) {
        const inputChanges: readonly FileChange[] = op.action_type === 'APPLY_CHANGESET'
          ? (op.params.changes as unknown as FileChange[])
          : fileWriteInputChanges(op);
        const files = ledgerFiles({ canonicalRoot, inputChanges,
          observations: executionObservations(evidence.changes as unknown as FileChangeOutcome[]) });
        await repositories.changeSets.recordExecution(header, randomUUID(), files, ledgerStatus(files, status));
      }
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
  if (admitted.operation.capability_key === 'FILE_READ') {
    // Reads are bounded by the caller-provided deadline (the Worker execution
    // lease) and the caller's abort signal.
    const read = await fileReadExecute(admitted.operation, admitted.invocation, input.signal,
      input.deadline ?? null);
    await input.hooks?.afterFakeEffect?.();
    return settleGatewayInvocation(db, admitted, read.outcome, read.result, input.origin);
  }
  if (admitted.operation.capability_key === 'WEB_FETCH') {
    const fetch = await webFetchExecute(admitted.operation, admitted.invocation,
      { ...(input.signal === undefined ? {} : { signal: input.signal }),
        ...(input.deadline === undefined ? {} : { deadline: input.deadline }),
        ...(input.limits === undefined ? {} : { limits: input.limits }) });
    await input.hooks?.afterFakeEffect?.();
    return settleGatewayInvocation(db, admitted, fetch.outcome, fetch.result, input.origin);
  }
  if (admitted.operation.capability_key === 'FILE_WRITE') {
    const res = await fileWriteExecute(admitted.operation, admitted.invocation, input.signal);
    await input.hooks?.afterFakeEffect?.();
    return settleGatewayInvocation(db, admitted, res.outcome, res.result, input.origin);
  }
  if (admitted.operation.capability_key === 'GIT_READ' || admitted.operation.capability_key === 'GIT_WRITE') {
    const res = await gitExecute(admitted.operation, admitted.invocation, input.signal);
    await input.hooks?.afterFakeEffect?.();
    return settleGatewayInvocation(db, admitted, res.outcome, res.result, input.origin);
  }
  if (admitted.operation.capability_key === 'CLI_RUN') {
    const res = await cliExecute(admitted.operation, admitted.invocation, input.signal, input.deadline);
    await input.hooks?.afterFakeEffect?.();
    return settleGatewayInvocation(db, admitted, res.outcome, res.result, input.origin);
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

async function fileWriteExecute(op: LogicalOperationRow, invocation: InvocationAttemptRow,
  signal?: AbortSignal): Promise<{ outcome: 'SUCCEEDED' | 'FAILED'; result: JsonObject }> {
  if (signal?.aborted) throw new Error('Gateway dispatch aborted before file write');
  if (op.action_type === 'APPLY_CHANGESET') {
    const changes = (op.params.changes as any[]) as FileChange[];
    const res = await executeFileChangeset(op.normalized_target, changes, signal);
    return {
      outcome: res.outcome,
      result: {
        operation_id: op.id,
        invocation_id: invocation.id,
        changes: res.changes as unknown as JsonObject[],
        ...(res.reason ? { reason: res.reason } : {}),
      },
    };
  }
  const rel = relative(dirname(op.normalized_target), op.normalized_target);
  const baselineSha = typeof op.params.baseline_sha256 === 'string' ? op.params.baseline_sha256 : null;
  const content = typeof op.params.content === 'string' ? op.params.content : '';
  const changes: FileChange[] = [{
    path: rel,
    action: baselineSha ? 'MODIFY' : 'CREATE',
    baselineSha256: baselineSha,
    content,
    targetSha256: createHash('sha256').update(content).digest('hex'),
  }];
  const parent = dirname(op.normalized_target);
  const res = await executeFileChangeset(parent, changes, signal);
  return {
    outcome: res.outcome,
    result: {
      operation_id: op.id,
      invocation_id: invocation.id,
      changes: res.changes as unknown as JsonObject[],
      ...(res.reason ? { reason: res.reason } : {}),
    },
  };
}

async function gitExecute(op: LogicalOperationRow, invocation: InvocationAttemptRow,
  signal?: AbortSignal): Promise<{ outcome: 'SUCCEEDED' | 'FAILED'; result: JsonObject }> {
  if (signal?.aborted) throw new Error('Gateway dispatch aborted before git execution');
  const options = { cwd: op.normalized_target, signal };
  try {
    if (op.action_type === 'GIT_STATUS') {
      const status = await gitGetStatus(options);
      return { outcome: 'SUCCEEDED', result: { status: status as unknown as JsonObject, operation_id: op.id, invocation_id: invocation.id } };
    }
    if (op.action_type === 'GIT_DIFF') {
      const diff = await gitGetDiff(options, op.params as any);
      return { outcome: 'SUCCEEDED', result: { diff, operation_id: op.id, invocation_id: invocation.id } };
    }
    if (op.action_type === 'GIT_LOG') {
      const log = await gitGetLog(options, typeof op.params.max_count === 'number' ? op.params.max_count : 10);
      return { outcome: 'SUCCEEDED', result: { log: log as unknown as JsonObject[], operation_id: op.id, invocation_id: invocation.id } };
    }
    if (op.action_type === 'GIT_STAGE') {
      const res = await gitStageFile(String(op.params.file_path), options);
      return {
        outcome: res.success ? 'SUCCEEDED' : 'FAILED',
        result: {
          success: res.success,
          ...(res.stderr !== undefined ? { stderr: res.stderr } : {}),
          operation_id: op.id,
          invocation_id: invocation.id,
        },
      };
    }
    if (op.action_type === 'GIT_COMMIT') {
      const res = await gitCommit({
        message: String(op.params.message),
        ...(typeof op.params.expected_parent_sha === 'string' ? { expectedParentSha: op.params.expected_parent_sha } : {}),
        ...(typeof op.params.author_name === 'string' ? { authorName: op.params.author_name } : {}),
      }, options);
      return { outcome: 'SUCCEEDED', result: { ...res, operation_id: op.id, invocation_id: invocation.id } };
    }
    if (op.action_type === 'GIT_PUSH') {
      const res = await gitPush({
        remote: String(op.params.remote),
        ref: String(op.params.ref),
        ...(typeof op.params.expected_commit_sha === 'string' ? { expectedCommitSha: op.params.expected_commit_sha } : {}),
      }, options);
      return { outcome: 'SUCCEEDED', result: { ...res, operation_id: op.id, invocation_id: invocation.id } };
    }
    return { outcome: 'FAILED', result: { reason: 'UNKNOWN_GIT_ACTION', action_type: op.action_type } };
  } catch (err) {
    return { outcome: 'FAILED', result: { reason: 'GIT_ERROR', error: (err as Error).message } };
  }
}

async function cliExecute(op: LogicalOperationRow, invocation: InvocationAttemptRow,
  signal?: AbortSignal, deadline?: Date | null): Promise<{ outcome: 'SUCCEEDED' | 'FAILED'; result: JsonObject }> {
  if (signal?.aborted) throw new Error('Gateway dispatch aborted before CLI execution');
  const timeoutMs = deadline ? Math.max(1000, deadline.getTime() - Date.now()) : undefined;
  const res = await executeCliCommand({
    executable: String(op.params.executable),
    args: (op.params.args as any[]) ?? [],
    cwd: op.normalized_target,
    ...(timeoutMs !== undefined ? { timeoutMs } : {}),
    ...(typeof op.params.max_output_bytes === 'number' ? { maxOutputBytes: op.params.max_output_bytes } : {}),
    ...(op.params.env ? { additionalEnv: op.params.env as any } : {}),
  }, signal);
  return {
    outcome: res.outcome === 'SUCCEEDED' ? 'SUCCEEDED' : 'FAILED',
    result: {
      outcome: res.outcome,
      exitCode: res.exitCode,
      stdout: res.stdout,
      stderr: res.stderr,
      truncated: res.truncated,
      durationMs: res.durationMs,
      ...(res.pid !== undefined ? { pid: res.pid } : {}),
      ...(res.reason !== undefined ? { reason: res.reason } : {}),
      operation_id: op.id,
      invocation_id: invocation.id,
    },
  };
}

const FILE_READ_MAX_BYTES = 128 * 1024;

/** Reads are idempotent and side-effect free: a typed failure settles FAILED
 * (nothing happened) instead of UNKNOWN, and reconcile can safely re-read. */
async function fileReadExecute(op: LogicalOperationRow, invocation: InvocationAttemptRow,
  signal?: AbortSignal, deadline?: Date | null): Promise<{
  outcome: 'SUCCEEDED' | 'FAILED'; result: JsonObject;
}> {
  if (signal?.aborted) throw new Error('Gateway dispatch aborted before file read');
  if (deadline !== undefined && deadline !== null && deadline.getTime() <= Date.now()) {
    return { outcome: 'FAILED', result: { reason: 'GATEWAY_DEADLINE_EXCEEDED', target: op.normalized_target } };
  }
  // The frozen path is pinned by realpath at prepare; re-verify before use so a
  // swapped link cannot retarget the read after admission.
  let current: string;
  try {
    current = await realpath(op.normalized_target);
  } catch (error) {
    return { outcome: 'FAILED', result: { reason: 'FILE_UNAVAILABLE', target: op.normalized_target,
      error_code: (error as NodeJS.ErrnoException).code ?? 'UNKNOWN' } };
  }
  if (current !== op.normalized_target) {
    return { outcome: 'FAILED', result: { reason: 'GATEWAY_TARGET_CHANGED',
      target: op.normalized_target, actual: current } };
  }
  const stat = await lstat(op.normalized_target);
  if (!stat.isFile()) {
    return { outcome: 'FAILED', result: { reason: 'FILE_NOT_REGULAR', target: op.normalized_target } };
  }
  if (stat.size > FILE_READ_MAX_BYTES) {
    return { outcome: 'FAILED', result: { reason: 'FILE_TOO_LARGE', target: op.normalized_target,
      size: stat.size, limit_bytes: FILE_READ_MAX_BYTES } };
  }
  const bytes = await readFile(op.normalized_target, { signal });
  if (bytes.includes(0)) {
    return { outcome: 'FAILED', result: { reason: 'FILE_BINARY_UNSUPPORTED',
      target: op.normalized_target, size: stat.size } };
  }
  return { outcome: 'SUCCEEDED', result: { target: op.normalized_target, size: stat.size,
    sha256: createHash('sha256').update(bytes).digest('hex'), truncated: false,
    content: bytes.toString('utf8'), invocation_id: invocation.id, operation_id: op.id } };
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
  /** WEB_FETCH binds no managed resource; the deny then requires resource_id IS NULL. */
  readonly resourceId?: string; readonly workerId: string; readonly workerEpoch?: bigint;
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
    let resourceId: string | null = null;
    if (input.resourceId !== undefined) {
      const resource = await repositories.gateway.lockResource(input.resourceId);
      if (resource?.workspace_id !== input.workspaceId) return false;
      resourceId = resource.id;
    }
    const operation = await repositories.gateway.lockOperation(input.operationId);
    if (operation?.origin !== 'RUN' || operation.run_id !== run.id ||
        operation.resource_id !== resourceId ||
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
      workspaceId: run.workspace_id, runId: run.id,
      actorRef: `run:${run.id}`, commandId: null, projectId: task.project_id,
      taskId: task.id, eventType: 'RUN_FAILED',
      factRefs: { run_id: run.id, operation_id: operation.id, reason: input.reason } });
    return true;
  });
}

/** A settled read failure has no uncertain effect. Converge its owning Run while
 * keeping the original operation and failed Invocation as the failure evidence. */
export async function failGraphReadAfterInvocation(db: DbExecutor, input: {
  readonly workspaceId: string; readonly runId: string; readonly operationId: string;
  readonly workerId: string; readonly workerEpoch?: bigint;
  readonly delivery: { readonly commandId: string; readonly invocationEpoch: bigint };
}): Promise<'FAILED' | 'CONTROL_PENDING' | 'STALE'> {
  return withTransaction(db, async (repositories) => {
    const { task, run } = await lockTaskAndRun(repositories, input.runId, input.workspaceId);
    if (!(await repositories.dispatch.hasCurrentCommandInvocation(run.id,
      input.delivery.commandId, input.workerId, input.delivery.invocationEpoch))) return 'STALE';
    const operation = await repositories.gateway.lockOperation(input.operationId);
    if (operation?.origin !== 'RUN' || operation.run_id !== run.id ||
        !['FILE_READ', 'WEB_FETCH'].includes(operation.capability_key) ||
        operation.status !== 'FAILED') return 'STALE';
    const invocation = await repositories.gateway.lastInvocation(operation.id);
    if (invocation?.status !== 'FAILED' ||
        (await repositories.gateway.listUnresolvedRunOperations(run.id)).length > 0 ||
        (await repositories.recovery.listUnresolvedEffects(run.id)).length > 0) return 'STALE';
    if (run.status === 'FAILED' && task.executor_run_id === null) return 'FAILED';
    if (run.status !== 'RUNNING' || task.executor_run_id !== run.id ||
        task.ownership_epoch !== run.ownership_epoch ||
        (run.worker_id !== null && (run.worker_id !== input.workerId ||
          run.worker_epoch !== input.workerEpoch))) return 'STALE';
    if (run.worker_id !== null) {
      const released = await repositories.runs.releaseWorker(run.id, input.workerId, input.workerEpoch!);
      if (released === undefined) throw new Error('failed read Worker release CAS failed');
    }
    if ((await repositories.recovery.lockPendingControl(run.id)) !== undefined) {
      return 'CONTROL_PENDING';
    }
    const reason = typeof invocation.result_ref?.reason === 'string'
      ? invocation.result_ref.reason : 'GATEWAY_READ_FAILED';
    const failed = await repositories.runs.advanceRun({ runId: run.id,
      expectedRevision: run.revision, status: 'FAILED',
      currentStepId: run.current_step_id, waitReason: reason, terminal: true });
    if (failed === undefined) throw new Error('failed read Run CAS failed');
    const releasedTask = await repositories.tasks.releaseExecutionFromRun({
      taskId: task.id, runId: run.id, expectedRevision: task.revision, toStatus: 'READY',
    });
    if (releasedTask === undefined) throw new Error('failed read Task CAS failed');
    await repositories.activities.insertActivityRecord({ id: randomUUID(), actorKind: 'SYSTEM',
      workspaceId: run.workspace_id, runId: run.id,
      actorRef: `run:${run.id}`, commandId: null, projectId: task.project_id,
      taskId: task.id, eventType: 'RUN_FAILED',
      factRefs: { run_id: run.id, operation_id: operation.id,
        invocation_id: invocation.id, reason } });
    return 'FAILED';
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
    const resource = await repositories.gateway.lockResource(origin.resourceId ?? '');
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
}): Promise<{ readonly status: 'SUCCEEDED' | 'NOT_EXECUTED' | 'UNKNOWN' | 'FAILED'; readonly operation_id: string }> {
  if (input.oldProcessStopped !== true) throw invalidTransition('必须由恢复调用方确认旧执行进程已退出。');
  const repositories = createRepositories(db);
  const op = await repositories.gateway.readOperation(input.operationId);
  const invocation = await repositories.gateway.readInvocation(input.invocationId);
  if (op?.workspace_id !== input.workspaceId || invocation?.operation_id !== op.id ||
      !['PREPARED', 'DISPATCHING', 'UNKNOWN'].includes(invocation.status)) throw resourceNotFound('Unresolved invocation');
  let observed: 'PRESENT' | 'MISSING' | 'MISMATCH' | undefined;
  let readOutcome: { outcome: 'SUCCEEDED' | 'FAILED'; result: JsonObject } | undefined;
  let toolReconciliation: { status: 'SUCCEEDED' | 'NOT_EXECUTED' | 'UNKNOWN' | 'FAILED'; result: JsonObject } | undefined;

  if (op.capability_key === 'FILE_READ') {
    readOutcome = invocation.status === 'PREPARED' ? undefined
      : await fileReadExecute(op, invocation);
  } else if (op.capability_key === 'WEB_FETCH') {
    readOutcome = invocation.status === 'PREPARED' ? undefined
      : await webFetchExecute(op, invocation);
  } else if (op.capability_key === 'GIT_READ') {
    readOutcome = invocation.status === 'PREPARED' ? undefined
      : await gitExecute(op, invocation);
  } else if (op.capability_key === 'FILE_WRITE') {
    if (invocation.status === 'PREPARED') {
      toolReconciliation = { status: 'NOT_EXECUTED', result: { reason: 'PREPARED_NOT_EXECUTED' } };
    } else {
      const canonicalRoot = op.action_type === 'APPLY_CHANGESET'
        ? op.normalized_target : dirname(op.normalized_target);
      // 与执行侧共用同一份冻结输入构造，避免「核对用的期望」和「真正写入的期望」漂移。
      const changes = op.action_type === 'APPLY_CHANGESET'
        ? (op.params.changes as unknown as FileChange[])
        : fileWriteInputChanges(op);
      const check = await reconcileFileChangeset(canonicalRoot, changes);
      toolReconciliation = {
        status: check.outcome === 'SUCCEEDED' ? 'SUCCEEDED' : 'UNKNOWN',
        result: check.details,
      };
    }
  } else if (op.capability_key === 'GIT_WRITE') {
    if (invocation.status === 'PREPARED') {
      toolReconciliation = { status: 'NOT_EXECUTED', result: { reason: 'PREPARED_NOT_EXECUTED' } };
    } else if (op.action_type === 'GIT_COMMIT') {
      const check = await reconcileGitCommit({
        message: String(op.params.message),
        expectedParentSha: typeof op.params.expected_parent_sha === 'string' ? op.params.expected_parent_sha : null,
      }, { cwd: op.normalized_target });
      toolReconciliation = {
        status: check.outcome,
        result: check.details,
      };
    } else if (op.action_type === 'GIT_PUSH') {
      const check = await reconcileGitPush({
        remote: String(op.params.remote),
        ref: String(op.params.ref),
        expectedCommitSha: String(op.params.expected_commit_sha ?? ''),
      }, { cwd: op.normalized_target });
      toolReconciliation = {
        status: check.outcome,
        result: check.details,
      };
    } else {
      toolReconciliation = { status: 'UNKNOWN', result: { reason: 'GIT_STAGE_CANNOT_RECONCILE_ALONE' } };
    }
  } else if (op.capability_key === 'CLI_RUN') {
    if (invocation.status === 'PREPARED') {
      toolReconciliation = { status: 'NOT_EXECUTED', result: { reason: 'PREPARED_NOT_EXECUTED' } };
    } else {
      const recordedPid = typeof invocation.result_ref?.pid === 'number' ? invocation.result_ref.pid : undefined;
      const cliCheck = reconcileCliExecution(recordedPid === undefined ? {} : { pid: recordedPid });
      // DISPATCHING/UNKNOWN 且结果丢失：不能凭缺 PID 或进程停止断定未执行或已知失败，保守 UNKNOWN 隔离。
      toolReconciliation = { status: cliCheck.outcome, result: cliCheck.details };
    }
  } else if (invocation.status === 'PREPARED' || op.capability_key === 'FAKE_PUBLIC_READ') {
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
      if (op.resource_id !== null) await tx.gateway.lockResource(op.resource_id);
    } else {
      await tx.gateway.lockImportJob(op.import_job_id!);
      await lockWritableProjectInWorkspace(tx, op.workspace_id, op.project_id);
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
    const safeReread = op.capability_key === 'FILE_READ' || op.capability_key === 'WEB_FETCH' || op.capability_key === 'GIT_READ';
    const status: 'SUCCEEDED' | 'NOT_EXECUTED' | 'UNKNOWN' | 'FAILED' =
      safeReread
        ? (lockedInvocation.status === 'PREPARED' ? 'NOT_EXECUTED' : readOutcome!.outcome)
        : toolReconciliation !== undefined
          ? toolReconciliation.status
          : observed === 'PRESENT' ? 'SUCCEEDED'
            : observed === 'MISSING' &&
                (lockedInvocation.status === 'PREPARED' || op.capability_key === 'FAKE_PUBLIC_READ')
              ? 'NOT_EXECUTED' : 'UNKNOWN';
    const evidence: JsonObject = toolReconciliation !== undefined
      ? { reconciliation: toolReconciliation.status, ...toolReconciliation.result, invocation_id: invocation.id }
      : readOutcome !== undefined && lockedInvocation.status !== 'PREPARED'
        ? { reconciliation: 'SAFE_REREAD', ...readOutcome.result }
        : { reconciliation: observed ?? 'UNKNOWN', invocation_id: invocation.id };
    const changed = await tx.gateway.transitionInvocation(invocation.id, lockedInvocation.status, status, evidence);
    if (changed === undefined) throw new Error('reconciliation CAS failed');
    await tx.gateway.setOperationStatus(op.id, status === 'NOT_EXECUTED' ? 'PREPARED' : status, evidence);
    if (invocation.resource_claim_id !== null) await tx.gateway.setClaimStatus(invocation.resource_claim_id,
      status === 'UNKNOWN' ? 'QUARANTINED' : 'RELEASED');
    if (op.capability_key === 'FILE_WRITE' && (status === 'SUCCEEDED' || status === 'UNKNOWN') &&
        toolReconciliation?.result !== undefined && Array.isArray(toolReconciliation.result.checks)) {
      // M06 增量A：崩溃后由核对回读固化账本；全匹配=SUCCEEDED，否则保守 UNKNOWN，同事务、无磁盘访问。
      const canonicalRoot = op.action_type === 'APPLY_CHANGESET'
        ? op.normalized_target : dirname(op.normalized_target);
      const header = ledgerHeader(op, invocation.id, canonicalRoot);
      if (header !== undefined) {
        const inputChanges: readonly FileChange[] = op.action_type === 'APPLY_CHANGESET'
          ? (op.params.changes as unknown as FileChange[]) : fileWriteInputChanges(op);
        const files = ledgerFiles({ canonicalRoot, inputChanges,
          observations: reconciliationObservations(
            toolReconciliation.result.checks as unknown as FileReconciliationCheck[]) });
        await tx.changeSets.recordReconciliation(header, randomUUID(), files, status === 'SUCCEEDED');
      }
    }
    return { status, operation_id: op.id };
  });
}
