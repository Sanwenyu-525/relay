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
import { readFrozenActionOperationIds } from '../workflow/execution-contract.js';
import { readWebFetchConfig, webFetchExecute, type WebFetchLimits } from '../web/web-fetch.js';
import {
  executeFileChangeset, reconcileFileChangeset, canonicalRelativePath,
  isProtectedPath, isFrozenBaseline, requireMatchingTarget, assertSafeWindowsPathSegments,
  readFrozenFileWriteBaseline,
  type FileChange, type FileChangeOutcome, type FileReconciliationCheck,
} from '../files/file-changeset.js';
import type { ChangeSetLedgerFile, ChangeSetLedgerHeader } from '../files/change-set-repository.js';
import { executeFileQuery, reconcileFileQuery } from '../files/file-query.js';
import type { ChangeSetFileStatus, ChangeSetStatus } from '../infrastructure/database-schema.js';
import {
  captureWindowsFilePaths, executeWindowsFileChangeset, inspectWindowsFileRoot,
  reconcileWindowsFileChangeset, WindowsFileIoError, type WindowsFilePathEvidence,
} from '../files/windows-file-io.js';
import {
  gitGetStatus, gitGetDiff, gitGetLog, gitStageFile, gitCommit, gitPush, gitTracksPath,
  reconcileGitCommit, reconcileGitPush,
} from '../git/git-adapter.js';
import { executeCliCommand, isNormalCliFailure, reconcileCliExecution } from '../cli-worker/cli-adapter.js';
import { evaluateScopeGrant, type FrozenCheck, type ScopeGrantDecision }
  from './run-scope-grant.js';
import { getAdapterDescriptor } from '../gateway/adapter-metadata.js';
import { readAdmission, requireNormalAdmission } from './maintenance-admission.js';

/** Test-only narrowing of WEB_FETCH budgets (production dispatch passes none). */
type DispatchWebFetchLimits = Partial<WebFetchLimits>;

export type GatewayOrigin =
  | { readonly kind: 'RUN'; readonly runId: string; readonly stepId: string;
      readonly resourceId?: string; readonly workerId: string; readonly workerEpoch: bigint;
      readonly delivery?: { readonly commandId: string; readonly invocationEpoch: bigint } }
  | { readonly kind: 'USER_IMPORT'; readonly importJobId: string;
      readonly actorRef: string; readonly configVersion: string }
  /** 0058: 人工在已登记受管资源上直接触发的受控动作。没有 run/task/step/import_job，
   * 因此必须自带 Project 与受管资源；人工主体由 `audit` 在同一事务写入活动记录
   * （USER_ACTION 词表里没有 actor 列，见迁移 0058 注释）。 */
  | { readonly kind: 'USER_ACTION'; readonly projectId: string; readonly resourceId: string }
  /** 0060：人设助手 会话的只读工具轮次。它既没有 Run 也没有 Task，
   * 因此与 USER_ACTION 同样自带 Project 与受管资源；会话与消息身份用来核对
   * 「这条只读动作确实属于这条会话的这一次回答」，也让两种执行身份无法互相冒充。 */
  | { readonly kind: 'ASSISTANT_READ'; readonly projectId: string; readonly resourceId: string;
      readonly sessionId: string; readonly messageId: string };

export type GatewayActionType =
  | 'WRITE_MARKER'
  /** 读取某一次已冻结文件变更的证据；只读，不需要写准入。 */
  | 'READ_CHANGE_SET'
  | 'READ_PUBLIC'
  | 'READ_FILE'
  | 'LIST_DIRECTORY'
  | 'FIND_PATHS'
  | 'SEARCH_TEXT'
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
  /** 工具循环派发检查命令时随冻结检查一并提供；固定动作链不传。 */
  readonly scopeCheck?: FrozenCheck | undefined;
  /** 派发时实测到的可执行程序摘要，用于发现授权之后的脚本变更。 */
  readonly observedExecutableSha256?: string | undefined;
  /** 人工来源的审计行。与 Operation 在同一事务提交：USER_ACTION 没有 actor 列可存人工主体，
   * 把留痕放到调用方自己的事务会出现「动作已存在但没有发起人」的不可追溯状态。 */
  readonly audit?: {
    readonly actorKind: 'HUMAN' | 'SYSTEM';
    readonly actorRef: string;
    readonly commandId: string;
    readonly eventType: string;
  } | undefined;
}

const TERMINAL_RUN_STATUSES: readonly string[] = ['COMPLETED', 'FAILED', 'CANCELLED'];

/**
 * 0058: USER_ACTION 只放行受管资源上的 Git 只读。
 *
 * 写类能力（GIT_WRITE / CLI_RUN / FILE_WRITE / FILE_QUERY）不在此词表内：人工触发的暂存、提交、
 * 推送、受控 CLI 与目录浏览仍无公开入口，这一事实不因本轮放宽 origin 而改变。
 */
const USER_ACTION_ALLOWED_ACTIONS: readonly GatewayActionType[] = ['GIT_STATUS', 'GIT_DIFF'];

/**
 * 0060: ASSISTANT_READ 只放行只读能力。
 *
 * 词表按 capability 而不是逐条动作列举，因为这三种能力下只存在只读动作；
 * 写能力（FILE_WRITE / GIT_WRITE / CLI_RUN）与 WEB_FETCH 一律不在此词表内——
 * B 档是「可读不可写」，写入口继续只有 RUN。
 */
const ASSISTANT_READ_ALLOWED_CAPABILITIES: readonly GatewayCapability[] =
  ['FILE_READ', 'FILE_QUERY', 'GIT_READ'];

export function originAllows(
  origin: GatewayOrigin, actionType: GatewayActionType, capability: GatewayCapability,
): boolean {
  const allowedRunCaps: GatewayCapability[] = [
    'FAKE_WRITE', 'FILE_READ', 'FILE_QUERY', 'WEB_FETCH', 'FILE_WRITE', 'GIT_READ', 'GIT_WRITE', 'CLI_RUN',
  ];
  if (origin.kind === 'RUN') return allowedRunCaps.includes(capability);
  if (origin.kind === 'USER_IMPORT') return ['FAKE_PUBLIC_READ', 'WEB_FETCH'].includes(capability);
  if (origin.kind === 'ASSISTANT_READ') return ASSISTANT_READ_ALLOWED_CAPABILITIES.includes(capability);
  return capability === 'GIT_READ' && USER_ACTION_ALLOWED_ACTIONS.includes(actionType);
}

function originDenialDetail(kind: GatewayOrigin['kind']): string {
  if (kind === 'USER_ACTION') {
    return 'USER_ACTION 仅允许受管资源上的 Git 只读查询。';
  }
  if (kind === 'ASSISTANT_READ') {
    return 'ASSISTANT_READ 仅允许受管资源上的只读查询：人设会话不改文件、不建任务、不派子 Agent。';
  }
  return 'RUN 仅允许受管工具调用，USER_IMPORT 仅允许公共网络导入，USER_ACTION 仅允许受管资源上的 Git 只读。';
}

/**
 * 本次变化集里是否含删除。
 *
 * 从已校验的动作参数读取，而不是从模型原始声明读取：删除是一次不可逆的外部效果，
 * 「授权覆盖不了删除」这条规则必须落在真实将要执行的参数上。
 */
export function changesetContainsDelete(params: JsonObject): boolean {
  const changes = params.changes;
  if (!Array.isArray(changes)) return false;
  return changes.some((change) => typeof change === 'object' && change !== null &&
    !Array.isArray(change) && (change as JsonObject).action === 'DELETE');
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

/** 动作到能力的映射是 Gateway 的准入口径；B 档只读轮次复用它，不另立一份。 */
export function capabilityFor(action: GatewayActionType): GatewayCapability {
  if (action === 'WRITE_MARKER') return 'FAKE_WRITE';
  if (action === 'READ_FILE') return 'FILE_READ';
  // 变化集证据与文件写在同一个能力下：读的是同一份账本，不是另一种效果。
  if (action === 'READ_CHANGE_SET') return 'FILE_WRITE';
  if (action === 'LIST_DIRECTORY' || action === 'FIND_PATHS' || action === 'SEARCH_TEXT') {
    return 'FILE_QUERY';
  }
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

/** 目录查询的目标可以是受管根本身，因此这里允许「等于根」；文件读写仍用严格包含。 */
function containsDirectory(root: string, target: string): boolean {
  const normalizedRoot = process.platform === 'win32' ? root.toLowerCase() : root;
  const normalizedTarget = process.platform === 'win32' ? target.toLowerCase() : target;
  const part = relative(normalizedRoot, normalizedTarget);
  return part === '' || (part !== '..' && !part.startsWith(`..${sep}`) && !isAbsolute(part));
}

async function normalizedWriteTarget(target: string, root: string): Promise<string> {
  if (!isAbsolute(target)) throw validationFailed([{ field: 'target', message: 'must be absolute' }]);
  try { assertSafeWindowsPathSegments(target); }
  catch (error) { throw gatewayDenied('GATEWAY_TARGET_DENIED', (error as Error).message); }
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

/** FILE_QUERY 冻结的是查询目录而非文件：目录必须已存在、是真实目录、且经 realpath
 * 之后仍在受管根内。相对子目录参数随后再按 canonicalRelativePath 归一，
 * 使 '..'、别名与反斜杠形式不能把查询挪到根外或受保护路径。 */
async function normalizedQueryDirectory(target: string, root: string): Promise<string> {
  if (!isAbsolute(target)) throw validationFailed([{ field: 'target', message: 'must be absolute' }]);
  const resolved = resolve(target);
  if (!containsDirectory(root, resolved)) throw gatewayDenied('GATEWAY_TARGET_DENIED', '目标不在已登记资源根内。');
  let canonical: string;
  try {
    canonical = await realpath(resolved);
    const entry = await lstat(resolved);
    if (entry.isSymbolicLink() || !entry.isDirectory()) {
      throw gatewayDenied('GATEWAY_TARGET_DENIED', '查询目标不是普通目录或经链接重定向。');
    }
  } catch (error) {
    if (error instanceof DomainError) throw error;
    throw gatewayDenied('GATEWAY_TARGET_DENIED', '查询目录不存在或无法安全规范化。');
  }
  if (!containsDirectory(root, canonical)) throw gatewayDenied('GATEWAY_TARGET_DENIED', '目标经链接逃逸出已登记资源根。');
  if (isProtectedPath(relative(root, canonical).replaceAll('\\', '/'))) {
    throw gatewayDenied('GATEWAY_TARGET_DENIED', '查询目录属于受保护路径。');
  }
  return canonical;
}

/**
 * 0058: 人工只读动作不建 Invocation claim（`resource_claims` 强制绑定 task/run，见 0008），
 * 因此不能靠 claim 与写动作争用同一个实际工作目录。取而代之：prepare 与 admit 两处都拒绝
 * 正在被 HELD 或 QUARQUINED 占用的目录，否则一次在途写入会被读成「当前干净状态」。
 * 这是与既有资源排他同一口径的另一种表达，不是更弱的检查。
 */
async function assertResourceNotOccupied(
  repositories: Repositories, resource: ManagedResourceRow,
): Promise<void> {
  await repositories.gateway.lockResourceRegistry();
  if ((await repositories.gateway.listOccupiedResources()).some((occupied) =>
    rootsOverlap(occupied.identity_key, resource.identity_key))) {
    throw gatewayDenied('RESOURCE_OCCUPIED', '实际工作目录已被其他动作占用或隔离。', true);
  }
}

/** 0058 USER_ACTION: 目标是已登记受管根。它必须是真实目录，且 realpath 之后仍是同一个根——
 * 登记之后被换成链接的根会让 Git 读到受管范围之外的另一个仓库，因此在准备期就拒绝。 */
async function normalizedGitManagedRoot(root: string): Promise<string> {
  let canonical: string;
  try {
    canonical = await realpath(root);
    const entry = await lstat(root);
    if (entry.isSymbolicLink() || !entry.isDirectory()) {
      throw gatewayDenied('GATEWAY_TARGET_DENIED', '受管根本身不是普通目录或经链接重定向。');
    }
  } catch (error) {
    if (error instanceof DomainError) throw error;
    throw gatewayDenied('GATEWAY_TARGET_DENIED', '受管根不存在或无法安全规范化。');
  }
  if (!containsDirectory(root, canonical)) {
    throw gatewayDenied('GATEWAY_RESOURCE_ROOT_CHANGED', '受管资源根目录已不是登记时的目录。');
  }
  return canonical;
}

/**
 * 0058 USER_ACTION: 人工给出的相对路径按受管根解析，并返回规范化后的根内 POSIX 相对路径。
 *
 * 解析不到就拒绝，不猜、不退回整仓：存在性由 realpath 判定，链接逃逸与受保护路径同样拒绝；
 * 唯一例外是「已被删除但仍受版本控制」的路径——它对 `git diff` 有真实含义，用一次只读
 * `ls-files --error-unmatch` 判定，不靠猜测。
 */
async function normalizedGitRelativePath(root: string, relativePath: string): Promise<string> {
  let ledgerPath: string;
  try {
    ledgerPath = canonicalRelativePath(root, relativePath);
  } catch (error) {
    throw gatewayDenied('GATEWAY_TARGET_DENIED', (error as Error).message);
  }
  const absolute = resolve(root, ledgerPath);
  if (!containsPath(root, absolute)) throw gatewayDenied('GATEWAY_TARGET_DENIED', '最终目标不在已登记资源根内。');
  try {
    const canonical = await realpath(absolute);
    const entry = await lstat(absolute);
    if (entry.isSymbolicLink()) throw gatewayDenied('GATEWAY_TARGET_DENIED', '目标是符号链接或 junction。');
    if (!containsPath(root, canonical)) {
      throw gatewayDenied('GATEWAY_TARGET_DENIED', '目标经链接逃逸出已登记资源根。');
    }
    return ledgerPath;
  } catch (error) {
    if (error instanceof DomainError) throw error;
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      throw gatewayDenied('GATEWAY_TARGET_DENIED', '目标无法安全规范化。');
    }
    let tracked = false;
    try { tracked = await gitTracksPath({ cwd: root }, ledgerPath); }
    catch (gitError) {
      throw gatewayDenied('GATEWAY_TARGET_DENIED', `Git 无法判定该路径：${(gitError as Error).message}`);
    }
    if (!tracked) {
      throw validationFailed([{ field: 'params.path',
        message: 'path does not resolve inside the managed resource root' }]);
    }
    return ledgerPath;
  }
}

/** WEB_FETCH normalization is syntactic at prepare: http(s) only, no userinfo,
 * no fragment, lowercase host. The allowed-host and resolved-address checks
 * happen inside the admit transaction and again on every executed hop. */export function normalizedWebTarget(target: string): string {
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

type FrozenFileWriteDiffEvidence = { relativePath: string; fileAction: 'MODIFY' | 'DELETE';
  baselineSha256: string; baselineText: string | null; unavailableReason: string | null };

/** Check authority before local capture, then recheck it when the frozen evidence is committed. */
async function captureAuthorizedFileWriteDiffs(db: DbExecutor, input: PrepareGatewayActionInput,
  resourceBefore: ManagedResourceRow, target: string, hash: Buffer,
  payloadBytes: number): Promise<{ frozenDiffs: FrozenFileWriteDiffEvidence[];
    pathEvidence?: WindowsFilePathEvidence }> {
  const origin = input.origin;
  if (origin.kind !== 'RUN') return { frozenDiffs: [] };
  const registered = await withTransaction(db, async (repositories) => {
    const authority = await repositories.workspaces.lockAuthority(input.workspaceId, 'share');
    if (authority === undefined) throw resourceNotFound('Workspace authority');
    const { task, run } = await lockTaskAndRun(repositories, origin.runId, input.workspaceId);
    await requireCurrentRuleSnapshot(repositories, run.id, authority);
    ensureRunOwner(task, run, origin.workerId, origin.workerEpoch);
    await ensureGraphDelivery(repositories, origin);
    if (run.status !== 'RUNNING' || (await repositories.recovery.lockPendingControl(run.id)) !== undefined) {
      throw gatewayDenied('GATEWAY_RUN_NOT_READY', 'Run 不在可准备动作的安全执行状态。');
    }
    if ((await repositories.recovery.listUnresolvedEffects(run.id)).length > 0) {
      throw gatewayDenied('GATEWAY_OPERATION_UNRESOLVED', '该 Run 有尚未核对的受管发布动作。');
    }
    const step = await repositories.runs.readStep(origin.stepId);
    if (step?.run_id !== run.id || !['RUNNING', 'SUCCEEDED'].includes(step.status)) throw resourceNotFound('Run step');
    if (task.project_id === null) throw gatewayDenied('GATEWAY_PROJECT_REQUIRED', '写动作必须属于一个 Project。');
    const resource = await repositories.gateway.lockResource(origin.resourceId ?? '');
    if (resource?.project_id !== task.project_id || resource.workspace_id !== input.workspaceId ||
        resource.identity_key !== resourceBefore.identity_key ||
        resource.file_write_root_id !== resourceBefore.file_write_root_id ||
        resource.status !== 'ACTIVE') {
      throw resourceNotFound('Managed resource');
    }
    const existing = await repositories.gateway.findOperationByIntent({
      runId: run.id, stepId: origin.stepId, intentKey: input.intentKey,
    });
    if (existing !== undefined) {
      if (!sameOperation(existing, input, target, hash)) {
        throw gatewayDenied('GATEWAY_INTENT_CONFLICT', '同一 intent_key 已绑定其他最终动作。');
      }
      return null;
    }
    if ((await repositories.gateway.listUnresolvedRunOperations(run.id)).length > 0) {
      throw gatewayDenied('GATEWAY_OPERATION_UNRESOLVED', '该 Run 有未决 Gateway 动作，不能更换动作身份或目标绕过核对。');
    }
    if (await repositories.reviews.readByOperationId(input.operationId) !== undefined) {
      throw gatewayDenied('GATEWAY_APPROVAL_ID_CONFLICT', '旧 Review 已使用该 operation_id，不能作为 Gateway 批准。');
    }
    const connection = await repositories.gateway.readConnection(input.connectionId);
    if (connection?.workspace_id !== input.workspaceId || connection.project_id !== task.project_id ||
        connection.status !== 'ACTIVE' ||
        !(await repositories.gateway.hasConnectionCapability(connection.id, 'FILE_WRITE'))) {
      throw gatewayDenied('GATEWAY_CONNECTION_DENIED', 'Connection 不存在、已停用或不具备该 Capability。');
    }
    await selectedPolicy(repositories, { workspaceId: input.workspaceId, projectId: task.project_id,
      capability: 'FILE_WRITE', actionType: input.actionType, target, payloadBytes });
    return { root: resource.canonical_root, rootId: resource.file_write_root_id };
  });
  if (registered === null) return { frozenDiffs: [] };
  const { root } = registered;
  if (process.platform === 'win32' && registered.rootId === null) {
    throw gatewayDenied('GATEWAY_RESOURCE_IDENTITY_REQUIRED',
      '该资源登记时未绑定 Windows 目录身份；停用旧资源并重新登记后才能准备新文件写动作。');
  }
  const frozenDiffs: FrozenFileWriteDiffEvidence[] = [];
  const changes = input.actionType === 'APPLY_CHANGESET'
    ? input.params.changes as unknown as FileChange[]
    : [{ path: relative(root, target), action: 'MODIFY' as const,
      baselineSha256: typeof input.params.baseline_sha256 === 'string'
        ? input.params.baseline_sha256 : null }];
  const canonicalChanges = changes.map((change) => ({
    ...change, path: canonicalRelativePath(root, change.path),
    ...(input.actionType !== 'WRITE_FILE' ? {} : {
      action: isFrozenBaseline(change.baselineSha256) ? 'MODIFY' as const : 'CREATE' as const,
    }),
  }));
  const rootId = process.platform === 'win32' ? await inspectWindowsFileRoot(root) : undefined;
  if (rootId !== undefined && rootId.toLowerCase() !== registered.rootId?.toLowerCase()) {
    throw gatewayDenied('GATEWAY_RESOURCE_ROOT_CHANGED',
      '受管资源根目录已不是登记时的目录，不能把原权限用于替换后的目录。');
  }
  const captured = rootId === undefined ? undefined :
    await captureWindowsFilePaths(root, rootId, canonicalChanges);
  if (captured?.some((file, index) => file.path !== canonicalChanges[index]?.path ||
      file.action !== canonicalChanges[index]?.action || file.error !== undefined)) {
    throw gatewayDenied('GATEWAY_TARGET_DENIED', '文件路径物理身份无法安全冻结。');
  }
  for (const [index, change] of canonicalChanges.entries()) {
    if ((change.action !== 'MODIFY' && change.action !== 'DELETE') ||
        !isFrozenBaseline(change.baselineSha256)) continue;
    const rootRelativePath = change.path;
      const relativePath = input.actionType === 'WRITE_FILE' && captured === undefined
        ? basename(target) : rootRelativePath;
    const safeCaptured = captured?.[index];
    const evidence = safeCaptured === undefined
      ? await readFrozenFileWriteBaseline(root, rootRelativePath, change.baselineSha256)
      : safeCaptured.sha256 !== change.baselineSha256.toLowerCase()
        ? { baselineSha256: change.baselineSha256.toLowerCase(),
          baselineText: null, unavailableReason: 'BASELINE_SHA_MISMATCH' }
        : { baselineSha256: change.baselineSha256.toLowerCase(),
          baselineText: safeCaptured.text,
          unavailableReason: safeCaptured.text === null
            ? (safeCaptured.text_unavailable_reason ?? 'UNSAFE_OR_UNREADABLE') : null };
    frozenDiffs.push({ relativePath, fileAction: change.action,
      baselineSha256: evidence.baselineSha256, baselineText: evidence.baselineText,
      unavailableReason: evidence.unavailableReason });
  }
  return { frozenDiffs, ...(rootId === undefined || captured === undefined ? {} : {
    pathEvidence: { root_path: root, root_id: rootId,
      captures: captured.map((file) => ({ ...file, text: null,
        text_unavailable_reason: null })) },
  }) };
}

/** Prepare persists one logical action; ASK creates Review, never an Invocation. */
export async function prepareGatewayAction(db: DbExecutor, input: PrepareGatewayActionInput): Promise<PreparedGatewayAction> {
  if (!input.intentKey) throw validationFailed([{ field: 'intent_key', message: 'must not be empty' }]);
  const capability = capabilityFor(input.actionType);
  const allowedRunCaps: GatewayCapability[] = [
    'FAKE_WRITE', 'FILE_READ', 'FILE_QUERY', 'WEB_FETCH', 'FILE_WRITE', 'GIT_READ', 'GIT_WRITE', 'CLI_RUN',
  ];
  if (!originAllows(input.origin, input.actionType, capability)) {
    throw gatewayDenied('GATEWAY_ORIGIN_DENIED', originDenialDetail(input.origin.kind));
  }
  // WEB_FETCH targets a URL, not a filesystem working area: it binds no managed
  // resource and therefore takes no resource claim (reads need no exclusivity).
  const webFetch = input.actionType === 'WEB_FETCH';
  const resourceBefore = input.origin.kind !== 'USER_IMPORT' && !webFetch
    ? await createRepositories(db).gateway.readResource(
        input.origin.kind === 'RUN' ? input.origin.resourceId ?? '' : input.origin.resourceId)
    : undefined;
  if (input.origin.kind !== 'USER_IMPORT' && !webFetch &&
      (resourceBefore === undefined || resourceBefore.workspace_id !== input.workspaceId ||
        (input.origin.kind !== 'RUN' && resourceBefore.project_id !== input.origin.projectId))) {
    throw resourceNotFound('Managed resource');
  }

  // 受管根已就绪的来源共用同一套目标规范化。
  // 0060: ASSISTANT_READ 与 RUN 同形地解析只读目标——写分支对它是死代码，因为
  // originAllows 已在上面按只读能力词表拒掉 FILE_WRITE / GIT_WRITE / CLI_RUN。
  // 落进 else（公共读取）分支会让目录浏览去校验 HTTPS URL，那不是「更严」而是读错了地方。
  const managedRootOrigin = input.origin.kind === 'RUN' || input.origin.kind === 'ASSISTANT_READ';
  let target: string;
  if (managedRootOrigin) {
    if (webFetch) {
      target = normalizedWebTarget(input.target);
    } else if (input.actionType === 'READ_FILE') {
      target = await normalizedReadTarget(input.target, resourceBefore!.canonical_root);
    } else if (input.actionType === 'LIST_DIRECTORY' || input.actionType === 'FIND_PATHS' ||
        input.actionType === 'SEARCH_TEXT') {
      const relativePath = input.params.relative_path;
      if (relativePath !== undefined && typeof relativePath !== 'string') {
        throw validationFailed([{ field: 'params.relative_path', message: 'must be a string' }]);
      }
      if (input.params.limit !== undefined &&
          (!Number.isInteger(input.params.limit) || (input.params.limit as number) <= 0)) {
        throw validationFailed([{ field: 'params.limit', message: 'must be a positive integer' }]);
      }
      if (input.actionType === 'SEARCH_TEXT' && typeof input.params.query !== 'string') {
        throw validationFailed([{ field: 'params.query', message: 'search_text requires a query string' }]);
      }
      if (input.actionType === 'FIND_PATHS' && typeof input.params.pattern !== 'string') {
        throw validationFailed([{ field: 'params.pattern', message: 'find_paths requires a pattern string' }]);
      }
      if (input.actionType === 'LIST_DIRECTORY' &&
          (input.params.query !== undefined || input.params.pattern !== undefined)) {
        throw validationFailed([{ field: 'params', message: 'list_directory takes no query or pattern' }]);
      }
      target = await normalizedQueryDirectory(input.target, resourceBefore!.canonical_root);
    } else if (input.actionType === 'READ_CHANGE_SET') {
      // 读的是本 Run 自己的变化集证据，因此目标固定为受管根；具体身份由参数给出。
      target = resourceBefore!.canonical_root;
      if (typeof input.params.operation_id !== 'string' || input.params.operation_id === '') {
        throw validationFailed([{ field: 'params.operation_id', message: 'must be a string' }]);
      }
    } else if (input.actionType === 'WRITE_FILE') {
      target = await normalizedWriteTarget(input.target, resourceBefore!.canonical_root);
      const rel = relative(resourceBefore!.canonical_root, target);
      if (isProtectedPath(rel)) {
        throw gatewayDenied('GATEWAY_TARGET_DENIED', `目标路径 ${rel} 属于受保护路径，禁止写入。`);
      }
      try {
        canonicalRelativePath(resourceBefore!.canonical_root, rel);
      } catch (error) {
        throw gatewayDenied('GATEWAY_TARGET_DENIED', (error as Error).message);
      }
      if (typeof input.params.content !== 'string') {
        throw validationFailed([{ field: 'params.content', message: 'must be a string' }]);
      }
      if (Buffer.byteLength(relative(dirname(target), target).replaceAll('\\', '/'), 'utf8') > 1024) {
        throw validationFailed([{ field: 'target', message: 'ledger relative path exceeds 1024 UTF-8 bytes' }]);
      }
    } else if (input.actionType === 'APPLY_CHANGESET') {
      target = resourceBefore!.canonical_root;
      if (!Array.isArray(input.params.changes) || input.params.changes.length === 0 ||
          input.params.changes.length > 16) {
        throw validationFailed([{ field: 'params.changes', message: 'must contain 1 to 16 changes' }]);
      }
      const seenPaths = new Set<string>();
      for (const [idx, item] of (input.params.changes as any[]).entries()) {
        if (!item || typeof item.path !== 'string' || !['CREATE', 'MODIFY', 'DELETE'].includes(item.action)) {
          throw validationFailed([{ field: `params.changes[${idx}]`, message: 'invalid change item' }]);
        }
        let ledgerPath: string;
        try {
          ledgerPath = canonicalRelativePath(resourceBefore!.canonical_root, item.path);
        } catch (err) {
          throw gatewayDenied('GATEWAY_TARGET_DENIED', (err as Error).message);
        }
        if (Buffer.byteLength(ledgerPath, 'utf8') > 1024) {
          throw validationFailed([{ field: `params.changes[${idx}].path`,
            message: 'ledger relative path exceeds 1024 UTF-8 bytes' }]);
        }
        const pathKey = process.platform === 'win32' ? ledgerPath.toLowerCase() : ledgerPath;
        if (seenPaths.has(pathKey)) {
          throw validationFailed([{ field: `params.changes[${idx}].path`, message: 'duplicate target path' }]);
        }
        seenPaths.add(pathKey);
        if (item.action !== 'DELETE' && typeof item.content !== 'string') {
          throw validationFailed([{ field: `params.changes[${idx}].content`, message: 'CREATE/MODIFY requires string content' }]);
        }
        try {
          requireMatchingTarget(item);
        } catch (err) {
          throw validationFailed([{ field: `params.changes[${idx}].targetSha256`, message: (err as Error).message }]);
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
  } else if (input.origin.kind === 'USER_ACTION') {
    // 0058: 目标是已登记受管根本身——不是用户给的任意路径。realpath 在此再取一次，使
    // 「登记之后被替换成链接的根」在准备期就失败，而不是把 Git 读到另一个目录里。
    target = await normalizedGitManagedRoot(resourceBefore!.canonical_root);
    if (input.actionType === 'GIT_DIFF') {
      const relativePath = input.params.path;
      if (relativePath !== undefined) {
        if (typeof relativePath !== 'string' || relativePath === '') {
          throw validationFailed([{ field: 'params.path', message: 'must be a nonempty relative path' }]);
        }
        // 相对路径按受管根解析；解析不到就拒绝，不猜、不退回整仓。
        const ledgerPath = await normalizedGitRelativePath(target, relativePath);
        input = { ...input, params: { ...input.params, path: ledgerPath } };
      }
      if (input.params.cached !== undefined && typeof input.params.cached !== 'boolean') {
        throw validationFailed([{ field: 'params.cached', message: 'must be a boolean' }]);
      }
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
  // Every new Windows write freezes physical identity, including CREATE with no baseline text.
  // A repeated intent never refreshes its original evidence.
  const fileWriteAction = input.actionType === 'WRITE_FILE' || input.actionType === 'APPLY_CHANGESET';
  const readChangeSet = input.actionType === 'READ_CHANGE_SET';
  // 读变化集证据没有落盘副作用，因此不冻结路径与差异。
  const frozen = input.origin.kind === 'RUN' && resourceBefore !== undefined && fileWriteAction
    ? await captureAuthorizedFileWriteDiffs(db, input, resourceBefore, target, hash, payloadBytes)
    : { frozenDiffs: [] };
  if (readChangeSet && input.origin.kind === 'RUN') {
    const owned = await createRepositories(db).gateway.readOperation(input.params.operation_id as string);
    if (owned?.run_id !== input.origin.runId || owned.capability_key !== 'FILE_WRITE') {
      // 不能借别人的 Operation 读证据，也不能读一个非文件写的动作。
      throw gatewayDenied('GATEWAY_TARGET_DENIED', '只能读取本次 Run 自己的文件变更证据。');
    }
  }
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
            resource.identity_key !== resourceBefore?.identity_key || resource.status !== 'ACTIVE' ||
            (frozen.pathEvidence !== undefined &&
              (resource.canonical_root !== frozen.pathEvidence.root_path ||
                resource.file_write_root_id !== frozen.pathEvidence.root_id))) {
          throw resourceNotFound('Managed resource');
        }
      }
    } else if (input.origin.kind === 'USER_IMPORT') {
      const job = await repositories.gateway.lockImportJob(input.origin.importJobId);
      if (job?.workspace_id !== input.workspaceId || job.actor_ref !== input.origin.actorRef ||
          job.config_version !== input.origin.configVersion || job.source_uri !== target ||
          !['QUEUED', 'RUNNING'].includes(job.status)) throw gatewayDenied('GATEWAY_IMPORT_STALE', '导入来源、用户或配置已失效。');
      projectId = job.project_id;
      await lockWritableProjectInWorkspace(repositories, input.workspaceId, projectId);
    } else {
      // 0058 USER_ACTION: 没有 Run 也没有 ImportJob，受管资源与 Project 就是全部归属事实。
      // 锁序与 USER_IMPORT 一致（Project 归档栅栏 → 资源行），因此与既有写路径不会互锁。
      projectId = input.origin.projectId;
      await lockWritableProjectInWorkspace(repositories, input.workspaceId, projectId);
      resource = await repositories.gateway.lockResource(input.origin.resourceId);
      if (resource?.project_id !== projectId || resource.workspace_id !== input.workspaceId ||
          resource.status !== 'ACTIVE' ||
          resource.canonical_root !== resourceBefore?.canonical_root ||
          resource.identity_key !== resourceBefore?.identity_key) {
        throw resourceNotFound('Managed resource');
      }
      await assertResourceNotOccupied(repositories, resource);
    }

    const existing = input.origin.kind === 'RUN'
      ? await repositories.gateway.findOperationByIntent(
          { runId: input.origin.runId, stepId: input.origin.stepId, intentKey: input.intentKey })
      : input.origin.kind === 'USER_IMPORT'
        ? await repositories.gateway.findOperationByIntent(
            { importJobId: input.origin.importJobId, intentKey: input.intentKey })
        : await repositories.gateway.findUserActionOperation(input.intentKey);
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
    // Non-passthrough adapters (e.g. file mutations, git writes, cli executions)
    // CANNOT execute automatically without review approval.
    const descriptor = getAdapterDescriptor(capability);
    // 本次任务范围授权是一个局部豁免：它不改全局 approvalPassthrough，只在本次 Run 的
    // 有效授权覆盖这一个动作时让 AUTO 穿过这条降级。DENY 永不被授权覆盖。
    const scopeDecision = run === undefined || resource === undefined ? undefined :
      await evaluateScopeGrant(db, {
        runId: run.id, actionType: input.actionType, capability,
        canonicalRoot: resource.canonical_root,
        runTerminal: TERMINAL_RUN_STATUSES.includes(run.status),
        ...(input.scopeCheck === undefined ? {} : { check: input.scopeCheck }),
        ...(changesetContainsDelete(input.params)
          ? { containsDelete: true } : {}),
        ...(input.observedExecutableSha256 === undefined ? {} :
          { observedExecutableSha256: input.observedExecutableSha256 }),
      });
    const scopeCovered = scopeDecision?.covered === true && policy.decision === 'AUTO';
    const effectiveDecision: GatewayDecision =
      !descriptor.approvalPassthrough && policy.decision === 'AUTO' && !scopeCovered
        ? 'ASK' : policy.decision;

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
    if (frozen.pathEvidence !== undefined) {
      await repositories.fileWritePaths.insert({ operation_id: op.id,
        workspace_id: op.workspace_id, project_id: op.project_id,
        run_id: op.run_id!, resource_id: op.resource_id!, capability_key: 'FILE_WRITE',
        action_type: op.action_type as 'WRITE_FILE' | 'APPLY_CHANGESET',
        root_path: frozen.pathEvidence.root_path, root_id: frozen.pathEvidence.root_id,
        captures: frozen.pathEvidence.captures as unknown as JsonObject[] });
    }
    for (const evidence of frozen.frozenDiffs) {
      await repositories.fileWriteDiffs.insert({ operation_id: op.id,
        workspace_id: op.workspace_id, project_id: op.project_id,
        run_id: op.run_id!, resource_id: op.resource_id!, capability_key: 'FILE_WRITE',
        action_type: op.action_type as 'WRITE_FILE' | 'APPLY_CHANGESET',
        relative_path: evidence.relativePath, file_action: evidence.fileAction,
        baseline_sha256: evidence.baselineSha256, baseline_text: evidence.baselineText,
        unavailable_reason: evidence.unavailableReason });
    }
    if (input.audit !== undefined) {
      // 人工主体与动作身份在同一事务落库：把留痕放到调用方事务之外会留下「动作已存在但查不到
      // 是谁触发的」这一不可追溯状态，而 USER_ACTION 词表本身没有 actor 列可存。
      await repositories.activities.insertActivityRecord({ id: randomUUID(),
        workspaceId: input.workspaceId, actorKind: input.audit.actorKind,
        actorRef: input.audit.actorRef, commandId: input.audit.commandId,
        projectId, taskId: task?.id ?? null, runId: run?.id ?? null,
        eventType: input.audit.eventType,
        factRefs: { operation_id: op.id, origin: op.origin, action_type: op.action_type,
          resource_id: op.resource_id, capability_key: op.capability_key,
          normalized_target: op.normalized_target, status: op.status } });
    }
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
  /** 工具循环派发检查命令时随冻结检查一并提供，执行前据此复核授权。 */
  readonly scopeCheck?: FrozenCheck | undefined;
  /** 派发时实测到的可执行程序摘要，用于发现授权之后的脚本变更。 */
  readonly observedExecutableSha256?: string | undefined;
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
    if (input.delivery === undefined) requireNormalAdmission(await readAdmission(repositories, 'share'));
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
    if (input.delivery === undefined) requireNormalAdmission(await readAdmission(repositories, 'share'));
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
  if (origin.kind === 'RUN') {
    return op.origin === 'RUN' && op.run_id === origin.runId && op.step_id === origin.stepId &&
      op.resource_id === (origin.resourceId ?? null);
  }
  if (origin.kind === 'USER_IMPORT') return op.origin === 'USER_IMPORT' && op.import_job_id === origin.importJobId;
  // 0058/0060: 人工动作与人设会话的只读动作都没有 Run/ImportJob 可比，
  // 受管资源与 Project 就是它们在 Operation 上的完整归属。
  // 会话与消息身份不在 Operation 上——它由 session_tool_calls 那一行绑定，
  // 由 attachOperation 核对；两种执行身份因此无法互相冒充。
  if (origin.kind === 'ASSISTANT_READ') return op.origin === 'ASSISTANT_READ' &&
    op.resource_id === origin.resourceId && op.project_id === origin.projectId;
  return op.origin === 'USER_ACTION' && op.resource_id === origin.resourceId &&
    op.project_id === origin.projectId;
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
  review: Awaited<ReturnType<Repositories['reviews']['readByOperationId']>>,
  scopeDecision?: ScopeGrantDecision): Promise<SelectedPolicy> {
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
  // The scope grant exemption must be mirrored identically: an operation prepared
  // under a live grant stays executable, while a revoked/expired grant falls back to
  // requiring the single-action approval again.
  const effectiveDecision: GatewayDecision =
    !getAdapterDescriptor(op.capability_key).approvalPassthrough &&
      selected.decision === 'AUTO' && scopeDecision?.covered !== true
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
      const frozenActionIds = contract === undefined ? [] :
        readFrozenActionOperationIds(contract.frozen_snapshot);
      if (frozenActionIds.includes(located.id) &&
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
    } else if (input.origin.kind === 'USER_IMPORT') {
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
    } else if (input.origin.kind === 'ASSISTANT_READ') {
      // 0060: 与 prepare 同一锁序与同一资源判定，并保留「在途目录」拒绝——
      // 一次未完成的写入不得被只读会话读成干净状态。
      // 目标不要求等于受管根本身：READ_FILE 的目标是根内文件，目录查询的目标是根或根内子目录，
      // 只有 GIT_* 才等于根。prepare 已把路径归一，这里再确认它仍落在**同一个**受管根内。
      await lockWritableProjectInWorkspace(repositories, input.workspaceId, input.origin.projectId);
      resource = await repositories.gateway.lockResource(input.origin.resourceId);
      if (resource?.workspace_id !== input.workspaceId || resource.project_id !== located.project_id ||
          resource.project_id !== input.origin.projectId || resource.status !== 'ACTIVE') {
        throw resourceNotFound('Managed resource');
      }
      const insideRoot = located.capability_key === 'FILE_QUERY'
        ? containsDirectory(resource.canonical_root, located.normalized_target)
        : located.capability_key === 'FILE_READ'
          ? containsPath(resource.canonical_root, located.normalized_target)
          : located.normalized_target === resource.canonical_root;
      if (!insideRoot) throw resourceNotFound('Managed resource');
      await assertResourceNotOccupied(repositories, resource);
    } else {
      // 0058: 与 prepare 同一锁序与同一判定。执行前重新确认资源仍是 ACTIVE 且身份未变，
      // 并再次拒绝在途目录——读取不得把一次未完成的写入读成干净状态。
      await lockWritableProjectInWorkspace(repositories, input.workspaceId, input.origin.projectId);
      resource = await repositories.gateway.lockResource(input.origin.resourceId);
      if (resource?.workspace_id !== input.workspaceId || resource.project_id !== located.project_id ||
          resource.project_id !== input.origin.projectId || resource.status !== 'ACTIVE' ||
          resource.canonical_root !== located.normalized_target) {
        throw resourceNotFound('Managed resource');
      }
      await assertResourceNotOccupied(repositories, resource);
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
    // 执行前复核：授权可能已在 prepare 之后被撤销、过期，或脚本已被改动。
    // 这里重新判定而不是信任 prepare 的结论——放行与否取决于「此刻」的事实。
    const admitScope = input.origin.kind === 'RUN' && resource !== undefined
      ? await evaluateScopeGrant(db, { runId: located.run_id!, actionType: op.action_type,
        capability: op.capability_key, canonicalRoot: resource.canonical_root,
        runTerminal: TERMINAL_RUN_STATUSES.includes(run?.status ?? 'FAILED'),
        ...(input.scopeCheck === undefined ? {} : { check: input.scopeCheck }),
        ...(changesetContainsDelete(op.params) ? { containsDelete: true } : {}),
        ...(input.observedExecutableSha256 === undefined ? {} :
          { observedExecutableSha256: input.observedExecutableSha256 }) })
      : undefined;
    const selected = await requireCurrentGatewayGrant(repositories, op, review, admitScope);
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
  if (origin.kind === 'USER_IMPORT') return true;
  if (origin.kind === 'USER_ACTION' || origin.kind === 'ASSISTANT_READ') {
    // 0058/0060: 没有 Worker lease 与资源 claim 可核，栅栏落在「本次调用身份仍是 DISPATCHING」
    // 这一条上——它挡住的是并发重复投递，而不是冒充另一个执行者。
    return (await createRepositories(db).gateway.readInvocation(admitted.invocation.id))?.status === 'DISPATCHING';
  }
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
  return change.targetSha256?.toLowerCase() ?? (change.content !== undefined ? targetShaOfContent(change.content) : null);
}

function jsonObject(value: unknown): JsonObject | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as JsonObject : undefined;
}

function fileWriteReceipt(resultRef: JsonObject | null): JsonObject | undefined {
  return jsonObject(resultRef?.file_write_receipt);
}

/** 回执必须属于原调用，且每项路径、动作和冻结摘要与适配器报告一致。 */
function validatedFileWriteReport(op: LogicalOperationRow, invocation: InvocationAttemptRow,
  changes: readonly FileChange[], receipt: JsonObject | undefined):
  { outcome: 'SUCCEEDED' | 'FAILED'; applied: readonly boolean[] } | undefined {
  if (receipt?.kind !== 'FILE_WRITE_ADAPTER_V1' || receipt.operation_id !== op.id ||
      receipt.invocation_id !== invocation.id ||
      (receipt.outcome !== 'SUCCEEDED' && receipt.outcome !== 'FAILED')) return undefined;
  const result = jsonObject(receipt.result);
  const outcomes = result?.changes;
  if (result?.operation_id !== op.id || result.invocation_id !== invocation.id ||
      !Array.isArray(outcomes) || outcomes.length !== changes.length) return undefined;
  const applied: boolean[] = [];
  for (const [idx, change] of changes.entries()) {
    const observed = jsonObject(outcomes[idx]);
    if (observed?.path !== change.path || observed.action !== change.action ||
        !['APPLIED', 'CONFLICT', 'FAILED'].includes(String(observed.status))) return undefined;
    const expected = expectedTargetOf(change);
    if (observed.targetSha256 != null && observed.targetSha256 !== expected) return undefined;
    if (change.action === 'CREATE' && observed.baselineSha256 != null) return undefined;
    if (change.action !== 'CREATE' && observed.baselineSha256 != null) {
      if (typeof observed.baselineSha256 !== 'string' ||
          observed.baselineSha256.toLowerCase() !== change.baselineSha256?.toLowerCase()) return undefined;
    }
    if (observed.status === 'APPLIED') {
      if (observed.error != null ||
          (change.action === 'DELETE' ? observed.targetSha256 != null : observed.targetSha256 !== expected)) return undefined;
      if (change.action === 'CREATE') {
        if (observed.actualBaselineSha256 != null) return undefined;
      } else if (typeof observed.baselineSha256 !== 'string' ||
          typeof observed.actualBaselineSha256 !== 'string' ||
          observed.actualBaselineSha256.toLowerCase() !== change.baselineSha256?.toLowerCase()) return undefined;
      applied.push(true);
    } else {
      if (typeof observed.error !== 'string' || observed.error === '') return undefined;
      applied.push(false);
    }
  }
  if ((receipt.outcome === 'SUCCEEDED') !== applied.every(Boolean)) return undefined;
  return { outcome: receipt.outcome, applied };
}

/** A partial receipt is usable only while every reported effect still matches disk. */
function confirmedPartialFileWrite(changes: readonly FileChange[], receipt: JsonObject | undefined,
  report: { outcome: 'SUCCEEDED' | 'FAILED'; applied: readonly boolean[] } | undefined,
  checks: readonly FileReconciliationCheck[] | undefined, applied: readonly boolean[]): boolean {
  const outcomes = jsonObject(receipt?.result)?.changes;
  if (report?.outcome !== 'FAILED' || !applied.some(Boolean) ||
      !Array.isArray(outcomes) || outcomes.length !== changes.length ||
      checks?.length !== changes.length) return false;
  return changes.every((change, idx) => {
    const outcome = jsonObject(outcomes[idx]);
    const check = checks[idx];
    if (outcome?.path !== change.path || check?.path !== change.path ||
        check.readError !== undefined) return false;
    if (report.applied[idx]) return applied[idx] === true;
    const baseline = outcome.actualBaselineSha256;
    return outcome.status === 'CONFLICT' && Object.hasOwn(outcome, 'actualBaselineSha256') &&
      (baseline === null || (typeof baseline === 'string' && /^[0-9a-f]{64}$/iu.test(baseline))) &&
      check.actualSha === (typeof baseline === 'string' ? baseline.toLowerCase() : null);
  });
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

/** 原 Invocation 回执确认该文件已应用，且按冻结输入回读匹配，才记 APPLIED。 */
function reconciliationObservations(checks: readonly FileReconciliationCheck[],
  applied: readonly boolean[]): FileObservation[] {
  return checks.map((check, idx) => ({
    path: check.path,
    status: applied[idx] && check.matches ? 'APPLIED' : (check.actualSha === null ? 'FAILED' : 'CONFLICT'),
    actualSha256: check.actualSha,
    observedBaselineSha256: null,
    error: applied[idx] && check.matches ? null : (check.readError ?? 'RECONCILE_UNCONFIRMED'),
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
      relative_path: canonicalRelativePath(draft.canonicalRoot, change.path), action: change.action,
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
function fileWriteInputChanges(op: LogicalOperationRow, root = dirname(op.normalized_target)): FileChange[] {
  const baselineSha = typeof op.params.baseline_sha256 === 'string' ? op.params.baseline_sha256 : null;
  const content = typeof op.params.content === 'string' ? op.params.content : '';
  return [{
    path: relative(root, op.normalized_target).replaceAll('\\', '/'),
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
    } else if (op.origin === 'USER_IMPORT') {
      await repositories.gateway.lockImportJob(op.import_job_id!);
      await lockWritableProjectInWorkspace(repositories, op.workspace_id, op.project_id);
    } else {
      // 0058 USER_ACTION: 锁受管资源而不是 ImportJob（USER_IMPORT 的 else 分支在此会空引用）。
      await lockWritableProjectInWorkspace(repositories, op.workspace_id, op.project_id);
      await repositories.gateway.lockResource(op.resource_id!);
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
    const receipt = op.capability_key === 'FILE_WRITE' ? fileWriteReceipt(invocation.result_ref) : undefined;
    const pathEvidence = op.capability_key === 'FILE_WRITE'
      ? await repositories.fileWritePaths.readByOperation(op.id) : undefined;
    const fileChanges: readonly FileChange[] = op.capability_key !== 'FILE_WRITE' ? [] :
      op.action_type === 'APPLY_CHANGESET'
        ? op.params.changes as unknown as FileChange[]
        : fileWriteInputChanges(op, pathEvidence?.root_path);
    const report = op.capability_key === 'FILE_WRITE'
      ? validatedFileWriteReport(op, invocation, fileChanges, receipt) : undefined;
    const reportedChanges = jsonObject(receipt?.result)?.changes;
    const rootRejectedBeforeWrite = resultRef.reason === 'CANONICAL_ROOT_CHANGED' ||
      resultRef.reason === 'CANONICAL_ROOT_UNAVAILABLE';
    const allConflicted = Array.isArray(reportedChanges) &&
      reportedChanges.every((change) => jsonObject(change)?.status === 'CONFLICT');
    const rootFailedBeforeWrite = rootRejectedBeforeWrite && Array.isArray(reportedChanges) &&
      reportedChanges.every((change) => {
        const row = jsonObject(change);
        return row?.status === 'FAILED' && row.error === resultRef.reason;
      });
    const knownNoFileEffect = status === 'FAILED' && report?.outcome === 'FAILED' &&
      Array.isArray(reportedChanges) && reportedChanges.length === fileChanges.length &&
      (allConflicted || rootFailedBeforeWrite);
    // FAILED is reserved for a proven no-effect action. A write that applied any
    // file, or whose failed I/O could have changed bytes, remains unresolved.
    const finalStatus = stale || (op.capability_key === 'FILE_WRITE' && status === 'FAILED' &&
      !knownNoFileEffect) ? 'UNKNOWN' : status;
    // A configured check can finish normally with failing tests. Its known result is not
    // an unresolved effect: retain any files it produced and let the same Run read and repair.
    // Arbitrary CLI failures, interrupted checks and stale receipts keep their quarantine.
    const completedCheckFailure = !stale && finalStatus === 'FAILED' &&
      op.origin === 'RUN' && op.capability_key === 'CLI_RUN' && op.action_type === 'CLI_RUN' &&
      resultRef.operation_id === op.id && resultRef.invocation_id === invocation.id &&
      isNormalCliFailure(resultRef) &&
      (await repositories.toolCalls.readByOperation(op.run_id!, op.id))
        ?.tool_name === 'run_check';
    const evidence: JsonObject = stale
      ? { reason: 'STALE_RESULT_RECONCILE', observed: resultRef,
          ...(receipt === undefined ? {} : { file_write_receipt: receipt }) }
      : receipt === undefined ? resultRef : { ...resultRef, file_write_receipt: receipt };
    const resolved = await repositories.gateway.transitionInvocation(invocation.id, 'DISPATCHING', finalStatus, evidence);
    if (resolved === undefined) throw new Error('Invocation outcome CAS failed');
    await repositories.gateway.setOperationStatus(op.id, finalStatus, evidence);
    if (invocation.resource_claim_id !== null) {
      // A read never mutates the resource, so even a FAILED read releases its claim.
      const released = finalStatus === 'SUCCEEDED' || (!stale && knownNoFileEffect) ||
        completedCheckFailure ||
        op.capability_key === 'FILE_READ' || op.capability_key === 'WEB_FETCH';
      await repositories.gateway.setClaimStatus(invocation.resource_claim_id,
        released ? 'RELEASED' : 'QUARANTINED');
    }
    if (!stale && op.capability_key === 'FILE_WRITE' && Array.isArray(evidence.changes)) {
      // M06 增量A：把真实执行后的逐文件结果固化为不可变账本，与结算同事务提交，无磁盘访问。
      const canonicalRoot = pathEvidence?.root_path ?? (op.action_type === 'APPLY_CHANGESET'
        ? op.normalized_target : dirname(op.normalized_target));
      const header = ledgerHeader(op, invocation.id, canonicalRoot);
      if (header !== undefined) {
        const files = ledgerFiles({ canonicalRoot, inputChanges: fileChanges,
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
  if (admitted.operation.capability_key === 'FILE_QUERY') {
    // 根边界必须来自已登记的受管资源，而不是查询目录自身：否则一个被替换成链接的
    // 查询目录会把「根」一起挪走，等于没有边界。资源缺失时退回查询目录本身并保持失败关闭。
    const managedRoot = input.origin.kind === 'RUN' && input.origin.resourceId !== undefined
      ? (await createRepositories(db).gateway.readResource(input.origin.resourceId))?.canonical_root
      : undefined;
    const query = await fileQueryExecute(admitted.operation, admitted.invocation, input.signal,
      input.deadline ?? null, managedRoot ?? admitted.operation.normalized_target);
    await input.hooks?.afterFakeEffect?.();
    return settleGatewayInvocation(db, admitted, query.outcome, query.result, input.origin);
  }
  if (admitted.operation.capability_key === 'WEB_FETCH') {
    const fetch = await webFetchExecute(admitted.operation, admitted.invocation,
      { ...(input.signal === undefined ? {} : { signal: input.signal }),
        ...(input.deadline === undefined ? {} : { deadline: input.deadline }),
        ...(input.limits === undefined ? {} : { limits: input.limits }) });
    await input.hooks?.afterFakeEffect?.();
    return settleGatewayInvocation(db, admitted, fetch.outcome, fetch.result, input.origin);
  }
  if (admitted.operation.action_type === 'READ_CHANGE_SET') {
    const evidence = await readChangeSetExecute(db, admitted.operation, admitted.invocation);
    await input.hooks?.afterFakeEffect?.();
    return settleGatewayInvocation(db, admitted, evidence.outcome, evidence.result, input.origin);
  }
  if (admitted.operation.capability_key === 'FILE_WRITE') {
    const res = await fileWriteExecute(db, admitted.operation, admitted.invocation, input.signal);
    const receipt: JsonObject = { kind: 'FILE_WRITE_ADAPTER_V1',
      operation_id: admitted.operation.id, invocation_id: admitted.invocation.id,
      outcome: res.outcome, result: res.result };
    const staged = await createRepositories(db).gateway.stageFileWriteReceipt(
      admitted.invocation.id, admitted.operation.id, receipt);
    if (staged === undefined) throw new Error('FILE_WRITE adapter receipt CAS failed');
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

async function fileWriteExecute(db: DbExecutor, op: LogicalOperationRow, invocation: InvocationAttemptRow,
  signal?: AbortSignal): Promise<{ outcome: 'SUCCEEDED' | 'FAILED'; result: JsonObject }> {
  if (signal?.aborted) throw new Error('Gateway dispatch aborted before file write');
  if (process.platform === 'win32') {
    const pathRow = await createRepositories(db).fileWritePaths.readByOperation(op.id);
    if (pathRow === undefined) throw new Error('Windows FILE_WRITE has no frozen path identity');
    const changes = op.action_type === 'APPLY_CHANGESET'
      ? op.params.changes as unknown as FileChange[]
      : fileWriteInputChanges(op, pathRow.root_path);
    const nativeChanges = changes.map((change) => ({
      ...change, path: canonicalRelativePath(pathRow.root_path, change.path),
    }));
    const capturedRows = pathRow.captures as unknown as WindowsFilePathEvidence['captures'];
    let result: Awaited<ReturnType<typeof executeWindowsFileChangeset>>;
    try {
      result = await executeWindowsFileChangeset({ root_path: pathRow.root_path,
        root_id: pathRow.root_id, captures: capturedRows }, nativeChanges, signal);
    } catch (error) {
      if (error instanceof WindowsFileIoError && new Set([
        'ROOT_CHANGED', 'ROOT_PATH_CHANGED', 'ROOT_UNAVAILABLE', 'UNSAFE_ENTRY', 'INVALID_ROOT',
      ]).has(error.code)) {
        const reason = error.code === 'ROOT_UNAVAILABLE'
          ? 'CANONICAL_ROOT_UNAVAILABLE' : 'CANONICAL_ROOT_CHANGED';
        return { outcome: 'FAILED', result: { operation_id: op.id,
          invocation_id: invocation.id, reason,
          changes: changes.map((change) => ({ path: change.path, action: change.action,
            status: 'FAILED', error: reason })) as unknown as JsonObject[] } };
      }
      throw error;
    }
    if (result.files.some((file) => file.effect_uncertain === true)) {
      throw new Error('Windows FILE_WRITE effect is uncertain after native mutation');
    }
    const outcomes: FileChangeOutcome[] = result.files.map((file, index) => {
      const change = changes[index]!;
      return { path: change.path, action: change.action, status: file.status,
        ...(change.action === 'CREATE' ? {} : { baselineSha256: change.baselineSha256 }),
        actualBaselineSha256: file.status === 'APPLIED'
          ? (change.action === 'CREATE' ? null : capturedRows[index]?.sha256 ?? null)
          : file.actual_sha256,
        ...(file.status === 'APPLIED' && change.action !== 'DELETE'
          ? { targetSha256: expectedTargetOf(change) } : {}),
        ...(file.status === 'APPLIED' ? {} : { error: file.error ?? 'FILE_IO_UNCONFIRMED' }),
      };
    });
    return { outcome: result.outcome, result: { operation_id: op.id,
      invocation_id: invocation.id, changes: outcomes as unknown as JsonObject[],
      physical_files: result.files as unknown as JsonObject[],
      ...(result.outcome === 'FAILED' ? { reason: 'SOME_CHANGES_FAILED_OR_CONFLICTED' } : {}) } };
  }
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
    // `reason` 保持 GIT_ERROR（既有动作历史与 RUN 来源的证据都按这一形态读），
    // 类型化的失败归类另放 `failure_kind`。这样人工只读入口能分辨「非 Git 仓库」与
    // 「外部 clean filter 被拒绝」，而既有 Invocation 的 result_ref 形状不变。
    const message = (err as Error).message;
    return { outcome: 'FAILED', result: { reason: 'GIT_ERROR', failure_kind: gitFailureKind(message),
      error: message } };
  }
}

/**
 * 把 Git 失败归到类型化类别上，而不是只回一段 stderr 文本。
 *
 * 这一层是「读失败/非 Git 仓库不能显示为干净」这条产品规则的落点：适配器原文
 * `not a git repository` 若只作为 `error` 文本出现，调用方很容易把它当成一个普通错误字段
 * 略过，于是空列表被当成「没有变化」。`GIT_ERROR` 仍是兜底类别。
 */
export function gitFailureKind(message: string): string {
  if (/not a git repository/i.test(message)) return 'GIT_REPOSITORY_UNAVAILABLE';
  if (/GIT_READ_EXTERNAL_FILTER_UNSUPPORTED/.test(message)) return 'GIT_READ_EXTERNAL_FILTER_UNSUPPORTED';
  if (/GIT_READ_CONFIG_UNAVAILABLE/.test(message)) return 'GIT_READ_CONFIG_UNAVAILABLE';
  if (/GIT_READ_STATUS_INVALID/.test(message)) return 'GIT_READ_STATUS_INVALID';
  return 'GIT_ERROR';
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

/**
 * 读取一次已冻结文件变更的证据。
 *
 * 只读账本，不碰磁盘：基线与目标摘要来自 prepare 冻结的输入，实际摘要来自执行账本。
 * 因此「计划差异 / 已应用差异 / 当前磁盘」三者各自的来源保持可辨，不会互相冒充。
 */
async function readChangeSetExecute(db: DbExecutor, op: LogicalOperationRow,
  invocation: InvocationAttemptRow): Promise<{ outcome: 'SUCCEEDED' | 'FAILED'; result: JsonObject }> {
  const operationId = op.params.operation_id;
  if (typeof operationId !== 'string' || operationId === '') {
    return { outcome: 'FAILED', result: { reason: 'CHANGE_SET_REFERENCE_MISSING' } };
  }
  const repositories = createRepositories(db);
  const referenced = await repositories.gateway.readOperation(operationId);
  if (referenced?.run_id !== op.run_id) {
    return { outcome: 'FAILED', result: { reason: 'CHANGE_SET_NOT_IN_RUN',
      detail: '只能读取本次 Run 自己的文件变更。' } };
  }
  // 一个动作至多一份账本（uq_change_set_invocation）；这里取唯一一份而不是「最后一份」。
  const [ledger] = await repositories.changeSets.listByOperation(operationId);
  if (ledger === undefined) {
    return { outcome: 'FAILED', result: { reason: 'CHANGE_SET_EVIDENCE_UNAVAILABLE',
      detail: '该动作尚未留下变化集证据。', operation_id: operationId } };
  }
  const files = await repositories.changeSets.listFiles(ledger.id);
  return { outcome: 'SUCCEEDED', result: {
    operation_id: operationId,
    change_set_id: ledger.id,
    change_set_status: ledger.status,
    evidence_source: ledger.evidence_source,
    canonical_root: ledger.canonical_root,
    files: files.map((file) => ({
      path: file.relative_path, action: file.action, status: file.status,
      baseline_sha256: file.baseline_sha256, observed_baseline_sha256: file.observed_baseline_sha256,
      target_sha256: file.target_sha256, actual_sha256: file.actual_sha256,
      ...(file.error === null ? {} : { error: file.error }) })),
    invocation_id: invocation.id,
  } };
}

async function fileQueryExecute(op: LogicalOperationRow, invocation: InvocationAttemptRow,
  signal: AbortSignal | undefined, deadline: Date | null,
  managedRoot: string): Promise<{
  outcome: 'SUCCEEDED' | 'FAILED'; result: JsonObject;
}> {
  if (signal?.aborted) throw new Error('Gateway dispatch aborted before file query');
  if (deadline !== undefined && deadline !== null && deadline.getTime() <= Date.now()) {
    return { outcome: 'FAILED', result: { reason: 'GATEWAY_DEADLINE_EXCEEDED', target: op.normalized_target } };
  }
  // The frozen directory is pinned by realpath at prepare; re-verify before use so a
  // swapped link cannot retarget the query after admission.
  let current: string;
  try {
    current = await realpath(op.normalized_target);
  } catch (error) {
    return { outcome: 'FAILED', result: { reason: 'FILE_QUERY_ROOT_UNAVAILABLE', target: op.normalized_target,
      error_code: (error as NodeJS.ErrnoException).code ?? 'UNKNOWN' } };
  }
  if (current !== op.normalized_target) {
    return { outcome: 'FAILED', result: { reason: 'GATEWAY_TARGET_CHANGED',
      target: op.normalized_target, actual: current } };
  }
  const executed = await executeFileQuery({ kind: op.action_type as 'LIST_DIRECTORY' | 'FIND_PATHS' | 'SEARCH_TEXT',
    directory: op.normalized_target, root: managedRoot,
    query: (typeof op.params.query === 'string' ? op.params.query
      : typeof op.params.pattern === 'string' ? op.params.pattern : undefined),
    limit: typeof op.params.limit === 'number' ? op.params.limit : undefined,
    signal });
  return { outcome: executed.outcome,
    result: { ...executed.result, target: op.normalized_target, action_type: op.action_type,
      invocation_id: invocation.id, operation_id: op.id } };
}

export function codeOf(error: unknown): string | undefined {
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

/** A settled read failure, or a file write proven to have changed no file,
 * can end its owning Run while retaining the original failure evidence. */
export async function failGraphActionAfterInvocation(db: DbExecutor, input: {
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
        !['FILE_READ', 'FILE_QUERY', 'WEB_FETCH', 'FILE_WRITE'].includes(operation.capability_key) ||
        operation.status !== 'FAILED') return 'STALE';
    const invocation = await repositories.gateway.lastInvocation(operation.id);
    if (invocation?.status !== 'FAILED' ||
        (await repositories.gateway.listUnresolvedRunOperations(run.id)).length > 0 ||
        (await repositories.recovery.listUnresolvedEffects(run.id)).length > 0) return 'STALE';
    if (operation.capability_key === 'FILE_WRITE') {
      const ledger = await repositories.changeSets.readLedgerByInvocation(invocation.id);
      const claim = invocation.resource_claim_id === null ? undefined :
        await repositories.gateway.readClaim(invocation.resource_claim_id);
      const rootRejectedBeforeWrite = invocation.result_ref?.reason === 'CANONICAL_ROOT_CHANGED' ||
        invocation.result_ref?.reason === 'CANONICAL_ROOT_UNAVAILABLE';
      const noFileEffect = ledger?.files.every((file) => file.status === 'CONFLICT') ||
        (rootRejectedBeforeWrite && ledger?.files.every((file) => file.status === 'FAILED' &&
          file.error === invocation.result_ref?.reason));
      if (ledger === undefined || ledger.files.length === 0 || !noFileEffect ||
          claim?.status !== 'RELEASED') {
        return 'STALE';
      }
    }
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
      ? invocation.result_ref.reason : 'GATEWAY_ACTION_FAILED';
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
  } else if (op.capability_key === 'FILE_QUERY') {
    // Bounded read-only query: safe re-read of the same frozen input, never a blind re-execution.
    if (invocation.status === 'PREPARED') {
      toolReconciliation = { status: 'NOT_EXECUTED', result: { reason: 'PREPARED_NOT_EXECUTED' } };
    } else {
      const managedRoot = op.resource_id === null ? op.normalized_target
        : (await repositories.gateway.readResource(op.resource_id))?.canonical_root
          ?? op.normalized_target;
      const recheck = await reconcileFileQuery(op, managedRoot);
      toolReconciliation = { status: recheck.status, result: recheck.result };
    }
  } else if (op.capability_key === 'WEB_FETCH') {
    readOutcome = invocation.status === 'PREPARED' ? undefined
      : await webFetchExecute(op, invocation);
  } else if (op.capability_key === 'GIT_READ') {
    readOutcome = invocation.status === 'PREPARED' ? undefined
      : await gitExecute(op, invocation);
  } else if (op.capability_key === 'FILE_WRITE' && op.action_type === 'READ_CHANGE_SET') {
    // 读证据没有外部效果：按同一冻结引用安全重读一次即可，不需要 UNKNOWN 隔离。
    if (invocation.status === 'PREPARED') {
      toolReconciliation = { status: 'NOT_EXECUTED', result: { reason: 'PREPARED_NOT_EXECUTED' } };
    } else {
      const recheck = await readChangeSetExecute(db, op, invocation);
      toolReconciliation = { status: recheck.outcome === 'SUCCEEDED' ? 'SUCCEEDED' : 'NOT_EXECUTED',
        result: { reconciliation: 'SAFE_RE_READ', ...recheck.result } };
    }
  } else if (op.capability_key === 'FILE_WRITE') {
    if (invocation.status === 'PREPARED') {
      toolReconciliation = { status: 'NOT_EXECUTED', result: { reason: 'PREPARED_NOT_EXECUTED' } };
    } else {
      const pathRow = await repositories.fileWritePaths.readByOperation(op.id);
      const canonicalRoot = pathRow?.root_path ?? (op.action_type === 'APPLY_CHANGESET'
        ? op.normalized_target : dirname(op.normalized_target));
      // 与执行侧共用同一份冻结输入构造，避免「核对用的期望」和「真正写入的期望」漂移。
      const changes = op.action_type === 'APPLY_CHANGESET'
        ? (op.params.changes as unknown as FileChange[])
        : fileWriteInputChanges(op, canonicalRoot);
      if (process.platform === 'win32') {
        const receipt = fileWriteReceipt(invocation.result_ref);
        const physical = jsonObject(receipt?.result)?.physical_files;
        if (pathRow === undefined || !Array.isArray(physical) || physical.length !== changes.length) {
          const checks: FileReconciliationCheck[] = changes.map((change) => ({
            path: change.path, expectedSha: expectedTargetOf(change), actualSha: null,
            matches: false, readError: 'FILE_WRITE_PHYSICAL_RECEIPT_MISSING',
          }));
          toolReconciliation = { status: 'UNKNOWN',
            result: { reason: 'FILE_WRITE_PHYSICAL_RECEIPT_MISSING',
              checks: checks as unknown as JsonObject[] } };
        } else {
          try {
            const outcomes = jsonObject(receipt?.result)?.changes;
            if (!Array.isArray(outcomes) || outcomes.length !== changes.length) {
              throw new Error('FILE_WRITE_REPORT_MISSING');
            }
            const files = changes.map((change, index) => {
              const observed = jsonObject(physical[index]);
              const reported = jsonObject(outcomes[index]);
              const path = canonicalRelativePath(canonicalRoot, change.path);
              if (observed?.path !== path || reported?.path !== change.path ||
                  !Array.isArray(observed.parent_chain) ||
                  (observed.target_id !== null && typeof observed.target_id !== 'string')) {
                throw new Error('FILE_WRITE_PHYSICAL_RECEIPT_MISMATCH');
              }
              const expectedSha = reported.status === 'APPLIED'
                ? expectedTargetOf(change)
                : typeof reported.actualBaselineSha256 === 'string'
                  ? reported.actualBaselineSha256 : null;
              return { path, parent_chain: observed.parent_chain as unknown as WindowsFilePathEvidence['captures'][number]['parent_chain'],
                target_id: observed.target_id, expected_sha256: expectedSha };
            });
            const observed = await reconcileWindowsFileChangeset({ root_path: pathRow.root_path,
              root_id: pathRow.root_id,
              captures: pathRow.captures as unknown as WindowsFilePathEvidence['captures'] }, files);
            const checks: FileReconciliationCheck[] = observed.map((file, index) => {
              const change = changes[index]!;
              const expectedSha = expectedTargetOf(change);
              return { path: change.path, expectedSha, actualSha: file.sha256,
                matches: file.matches && file.sha256 === expectedSha,
                ...(!file.matches || file.error !== undefined
                  ? { readError: file.error ?? 'PHYSICAL_IDENTITY_MISMATCH' } : {}) };
            });
            const allMatch = checks.every((check) => check.matches);
            toolReconciliation = { status: allMatch ? 'SUCCEEDED' : 'UNKNOWN',
              result: { reconciliation: allMatch ? 'ALL_MATCH' : 'MISMATCH_OR_PARTIAL',
                checks: checks as unknown as JsonObject[] } };
          } catch (error) {
            const checks: FileReconciliationCheck[] = changes.map((change) => ({
              path: change.path, expectedSha: expectedTargetOf(change), actualSha: null,
              matches: false, readError: 'FILE_WRITE_PHYSICAL_RECONCILE_FAILED',
            }));
            toolReconciliation = { status: 'UNKNOWN',
              result: { reason: 'FILE_WRITE_PHYSICAL_RECONCILE_FAILED',
                error_kind: error instanceof Error ? error.name : 'UNKNOWN',
                checks: checks as unknown as JsonObject[] } };
          }
        }
      } else {
        const check = await reconcileFileChangeset(canonicalRoot, changes);
        toolReconciliation = {
          status: check.outcome === 'SUCCEEDED' ? 'SUCCEEDED' : 'UNKNOWN',
          result: { ...check.details, checks: check.checks as unknown as JsonObject[] },
        };
      }
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
    } else if (op.origin === 'USER_IMPORT') {
      await tx.gateway.lockImportJob(op.import_job_id!);
      await lockWritableProjectInWorkspace(tx, op.workspace_id, op.project_id);
    } else {
      // 0058 USER_ACTION: 同 settle，锁受管资源。
      await lockWritableProjectInWorkspace(tx, op.workspace_id, op.project_id);
      await tx.gateway.lockResource(op.resource_id!);
    }
    const lockedOp = await tx.gateway.lockOperation(op.id);
    const lockedInvocation = await tx.gateway.lockInvocation(invocation.id);
    if (lockedOp === undefined || lockedInvocation === undefined ||
        !['PREPARED', 'DISPATCHING', 'UNKNOWN'].includes(lockedInvocation.status)) {
      throw gatewayDenied('GATEWAY_INVOCATION_STALE', '未决调用已经变化。');
    }
    if (run?.worker_id !== null && run !== undefined) await tx.runs.fenceWorker(run.id);
    let fileWriteProven = false;
    let fileWritePartialProven = false;
    let fileWriteApplied: boolean[] = [];
    let fileWritePartialObservations: FileObservation[] | undefined;
    const pathRow = op.capability_key === 'FILE_WRITE'
      ? await tx.fileWritePaths.readByOperation(op.id) : undefined;
    if (op.capability_key === 'FILE_WRITE' && lockedInvocation.status !== 'PREPARED') {
      const canonicalRoot = pathRow?.root_path ?? (op.action_type === 'APPLY_CHANGESET'
        ? op.normalized_target : dirname(op.normalized_target));
      const changes: readonly FileChange[] = op.action_type === 'APPLY_CHANGESET'
        ? (op.params.changes as unknown as FileChange[]) : fileWriteInputChanges(op, canonicalRoot);
      const receipt = fileWriteReceipt(lockedInvocation.result_ref);
      const report = validatedFileWriteReport(lockedOp, lockedInvocation, changes, receipt);
      const checks = toolReconciliation?.result.checks as unknown as FileReconciliationCheck[] | undefined;
      const priorLedger = await tx.changeSets.readLedgerByInvocation(invocation.id);
      const priorEvidenceAgrees = priorLedger === undefined ||
        (priorLedger.files.length === changes.length && priorLedger.files.every((file) => file.status === 'APPLIED'));
      const previousStatus = new Map(priorLedger?.files.map((file) => [file.relative_path, file.status]));
      fileWriteApplied = changes.map((change, idx) => report?.applied[idx] === true &&
        checks?.[idx]?.path === change.path && checks[idx]?.matches === true &&
        previousStatus.get(canonicalRelativePath(canonicalRoot, change.path)) !== 'CONFLICT' &&
        previousStatus.get(canonicalRelativePath(canonicalRoot, change.path)) !== 'FAILED');
      fileWriteProven = toolReconciliation?.status === 'SUCCEEDED' &&
        report?.outcome === 'SUCCEEDED' && fileWriteApplied.every(Boolean) && priorEvidenceAgrees;
      fileWritePartialProven = priorLedger === undefined &&
        confirmedPartialFileWrite(changes, receipt, report, checks, fileWriteApplied);
      if (fileWritePartialProven) {
        const receiptChanges = jsonObject(receipt?.result)?.changes;
        fileWritePartialObservations = executionObservations(receiptChanges as unknown as FileChangeOutcome[]);
      }
      toolReconciliation = {
        status: fileWriteProven ? 'SUCCEEDED' : 'UNKNOWN',
        result: { ...toolReconciliation!.result,
          ...(receipt === undefined ? { reason: 'FILE_WRITE_RECEIPT_MISSING' }
            : { file_write_receipt: receipt,
                ...(fileWriteProven ? {} : { reason: 'FILE_WRITE_RECEIPT_OR_DISK_UNCONFIRMED' }) }) },
      };
    }
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
      // 原 Invocation 适配器回执、冻结输入和当前回读共同限定逐文件结果；未确认保持 UNKNOWN。
      const canonicalRoot = pathRow?.root_path ?? (op.action_type === 'APPLY_CHANGESET'
        ? op.normalized_target : dirname(op.normalized_target));
      const header = ledgerHeader(op, invocation.id, canonicalRoot);
      if (header !== undefined) {
        const inputChanges: readonly FileChange[] = op.action_type === 'APPLY_CHANGESET'
          ? (op.params.changes as unknown as FileChange[]) : fileWriteInputChanges(op, canonicalRoot);
        const files = ledgerFiles({ canonicalRoot, inputChanges,
          observations: fileWritePartialObservations ?? reconciliationObservations(
            toolReconciliation.result.checks as unknown as FileReconciliationCheck[], fileWriteApplied) });
        await tx.changeSets.recordReconciliation(header, randomUUID(), files,
          status === 'SUCCEEDED', fileWritePartialProven);
      }
    }
    return { status, operation_id: op.id };
  });
}
