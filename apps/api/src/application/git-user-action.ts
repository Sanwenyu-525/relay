import { createHash } from 'node:crypto';

import type { DbExecutor } from '../infrastructure/database.js';
import type { JsonObject, JsonValue } from '../infrastructure/json.js';
import { isPostgresError, POSTGRES_ERROR_CODES } from '../infrastructure/postgres-error.js';
import { computePayloadHash } from '../receipt/payload-hash.js';
import { projectGitDiff, projectGitStatus } from '../git/git-read-projection.js';
import type { GitStatusResult } from '../git/git-adapter.js';
import { LOCAL_ACTOR_REF, httpCommandScopeKey } from './actor.js';
import {
  resolveExistingReceipt, resolveReceiptAfterUniqueViolation,
} from './command.js';
import { DomainError, resourceNotFound, validationFailed } from './domain-error.js';
import {
  dispatchGatewayAction, prepareGatewayAction,
  type GatewayActionType, type PreparedGatewayAction,
} from './gateway-actions.js';
import { readAdmission, requireNormalAdmission } from './maintenance-admission.js';
import { createRepositories, withTransaction } from './unit-of-work.js';

/**
 * M06 人工触发的 Git 只读入口（docs/architecture/tool-adapters.md 开头 2026-10-02 段、
 * docs/frontend/workbench-design.md §14.9）。
 *
 * 协调顺序不可交换：
 *   1. 规范化动作与参数（纯函数，先于任何 IO）；
 *   2. prepare 一个 USER_ACTION 逻辑动作（短事务：Operation + 受管资源 + Connection + 权限
 *      事实 + 人工审计同批提交）；
 *   3. ASK 到此为止——确认是一个独立人工事实，同一请求不代替它决定；
 *   4. AUTO 时派发一次（子进程在事务外）；
 *   5. 投影有界结果，`limit` 与 `truncated` 显式透出。
 *
 * 幂等锚点是 `logical_operations.id`：由 Workspace + Project + 受管资源 + 动作 + 参数确定性
 * 导出，因此同一 `command_id` 的重复投递不会读到第二次；换了参数则得到不同的 ID，
 * `command_receipts` 那一层另行拒绝同一 `command_id` 换内容重放。
 *
 * 只读不代表无事实：读取仍产生 Operation 与 Invocation，账本必须能回答「谁在什么时候读了
 * 哪个受管目录、读到的是什么」，而不是「界面当时显示过一次状态」。
 */

export type UserGitReadAction = Extract<GatewayActionType, 'GIT_STATUS' | 'GIT_DIFF'>;

export const USER_GIT_READ_ACTIONS: readonly UserGitReadAction[] = ['GIT_STATUS', 'GIT_DIFF'];

export const USER_GIT_READ_EVENT_TYPE = 'MANAGED_GIT_READ_REQUESTED';

export interface UserGitReadRequest {
  readonly workspaceId: string;
  readonly projectId: string;
  readonly resourceId: string;
  readonly connectionId: string;
  readonly actionType: UserGitReadAction;
  /** GIT_DIFF 的根内相对路径；缺省表示整个受管根。不接受绝对路径。 */
  readonly relativePath?: string | undefined;
  /** GIT_DIFF 是否读暂存区。 */
  readonly cached?: boolean | undefined;
  /** 有界上限：GIT_STATUS 是路径条目数，GIT_DIFF 是正文字节数。 */
  readonly limit?: number | undefined;
  /** 人工主体标识。V1 是服务端固定的本机单用户，调用方不得自行声明身份。 */
  readonly actorRef?: string | undefined;
  /** 活动留痕用的命令 ID。 */
  readonly commandId?: string | undefined;
}

export interface UserGitReadSettled {
  readonly state: 'SUCCEEDED' | 'FAILED';
  readonly operation_id: string;
  readonly invocation_id: string | null;
  readonly action_type: UserGitReadAction;
  readonly result: JsonObject;
}

/** 本次请求没有产生可读结果：要么等确认，要么必须先核对在途调用。绝不返回旧内容充数。 */
export interface UserGitReadPending {
  readonly state: 'WAITING_APPROVAL' | 'UNRESOLVED';
  readonly operation_id: string;
  readonly review_id: string | null;
  readonly action_type: UserGitReadAction;
  readonly reason: string;
}

export type UserGitReadOutcome = UserGitReadSettled | UserGitReadPending;

function originDenied(detail: string): DomainError {
  return new DomainError({ code: 'GATEWAY_ORIGIN_DENIED', status: 409,
    type: '/problems/gateway-origin-denied', title: 'Gateway 拒绝执行', detail,
    retryable: false, retryAction: 'REFRESH_AND_REDECIDE' });
}

export function assertUserGitAction(actionType: string): asserts actionType is UserGitReadAction {
  if (!USER_GIT_READ_ACTIONS.includes(actionType as UserGitReadAction)) {
    throw originDenied('人工入口只放行受管资源上的 GIT_STATUS 与 GIT_DIFF。');
  }
}

/** 确定性动作身份：同样的 Workspace + 资源 + 动作 + 参数永远得到同一个 Operation ID。 */
export function userGitOperationId(request: UserGitReadRequest): string {
  const digest = createHash('sha256').update(JSON.stringify({
    workspace_id: request.workspaceId,
    project_id: request.projectId,
    resource_id: request.resourceId,
    action_type: request.actionType,
    path: request.relativePath ?? null,
    cached: request.cached ?? null,
  })).digest('hex');
  // 与既有 Operation ID 同形（uuid 文本），但由摘要导出而不是随机生成，因此可重复定位。
  return [digest.slice(0, 8), digest.slice(8, 12), digest.slice(12, 16),
    digest.slice(16, 20), digest.slice(20, 32)].join('-');
}

/** intent_key 与 operation ID 同源：同一动作重复投递落到同一条意图上，不会新建第二个 Operation。 */
export function userGitIntentKey(operationId: string): string {
  return `user-git-read:${operationId}`;
}

/**
 * 把调用方的可选参数收敛成 Gateway 冻结用的形态。未知或错位的参数在 IO 之前即被拒绝。
 *
 * `limit` **不进**冻结参数：它只决定投影层返回多少，不改变「读了什么」。把它算进 params 会
 * 同时改动 `params_hash`（同一次读取换上限就变成 `GATEWAY_INTENT_CONFLICT`）并虚增
 * `max_payload_bytes` 的比较基数——那是动作载荷大小的口径，不是展示上限的。
 */
export function normalizeUserGitParams(request: UserGitReadRequest): JsonObject {
  if (request.limit !== undefined &&
      (!Number.isInteger(request.limit) || request.limit <= 0)) {
    throw validationFailed([{ field: 'limit', message: 'must be a positive integer' }]);
  }
  if (request.actionType === 'GIT_STATUS') {
    if (request.relativePath !== undefined || request.cached !== undefined) {
      throw validationFailed([{ field: 'params',
        message: 'git_status takes no path or cached' }]);
    }
    return {};
  }
  const params: Record<string, JsonValue> = {};
  if (request.relativePath !== undefined) {
    if (typeof request.relativePath !== 'string' || request.relativePath.trim() === '') {
      throw validationFailed([{ field: 'params.path', message: 'must be a nonempty string' }]);
    }
    params.path = request.relativePath;
  }
  if (request.cached !== undefined) {
    if (typeof request.cached !== 'boolean') {
      throw validationFailed([{ field: 'params.cached', message: 'must be a boolean' }]);
    }
    params.cached = request.cached;
  }
  return params;
}

/** 准备并（按 Permission 判定）派发一次人工 Git 只读。 */
export async function readUserGitState(
  db: DbExecutor, request: UserGitReadRequest,
): Promise<UserGitReadOutcome> {
  assertUserGitAction(request.actionType);
  const params = normalizeUserGitParams(request);
  const operationId = userGitOperationId(request);
  const intentKey = userGitIntentKey(operationId);
  const repositories = createRepositories(db);
  const resource = await repositories.gateway.readResource(request.resourceId);
  if (resource === undefined || resource.workspace_id !== request.workspaceId ||
      resource.project_id !== request.projectId) {
    throw resourceNotFound('Managed resource');
  }

  return readUserGitStateOnce(db, request, operationId, intentKey, params, resource.canonical_root);
}

/** 一次尝试；并发重复投递的唯一约束冲突在这里收敛为「读已存在的事实」，不重跑适配器。 */
async function readUserGitStateOnce(
  db: DbExecutor,
  request: UserGitReadRequest,
  operationId: string,
  intentKey: string,
  params: JsonObject,
  canonicalRoot: string,
): Promise<UserGitReadOutcome> {
  const repositories = createRepositories(db);
  const origin = { kind: 'USER_ACTION' as const,
    projectId: request.projectId, resourceId: request.resourceId };
  let prepared: PreparedGatewayAction;
  const located = await repositories.gateway.readOperation(operationId);
  if (located !== undefined) {
    if (located.origin !== 'USER_ACTION' || located.capability_key !== 'GIT_READ') {
      throw new DomainError({ code: 'GATEWAY_INTENT_CONFLICT', status: 409,
        type: '/problems/gateway-intent-conflict', title: 'Gateway 事实冲突',
        detail: '同一动作身份已绑定其他 Gateway 动作。',
        retryable: false, retryAction: 'REFRESH_AND_REDECIDE' });
    }
    if (located.normalized_target !== canonicalRoot) {
      // 受管根身份变了（停用后以同一路径重新登记会得到新的资源行）：原动作冻结的目标不再指向
      // 当前资源，因此不能沿用旧结果，也不静默改读新根。
      throw new DomainError({ code: 'GATEWAY_RESOURCE_ROOT_CHANGED', status: 409,
        type: '/problems/gateway-resource-root-changed', title: '受管资源已变化',
        detail: '受管资源根目录已不是登记时的目录，请重新发起读取。',
        retryable: false, retryAction: 'REFRESH_AND_REDECIDE' });
    }
    prepared = { operation_id: located.id, status: located.status,
      invocation_id: (await repositories.gateway.lastInvocation(located.id))?.id ?? null,
      review_id: (await repositories.reviews.readByOperationId(located.id))?.id ?? null };
    if (located.status === 'SUCCEEDED' || located.status === 'FAILED') {
      // 重复投递读到的是**同一次读取**的落库结果，不是第二次读取：适配器不再被调用。
      // FAILED 也照实投影（含类型化 reason），不重试、更不显示成干净。
      return { state: located.status, operation_id: located.id,
        invocation_id: prepared.invocation_id, action_type: request.actionType,
        result: projectUserGitResult(request, located.result_ref) };
    }
  } else {
    prepared = await prepareGatewayAction(db, {
      workspaceId: request.workspaceId, operationId, intentKey,
      connectionId: request.connectionId, origin,
      actionType: request.actionType, target: canonicalRoot, params,
      // 人工主体与动作身份在同一事务落库。USER_ACTION 词表没有 actor 列（迁移 0058），
      // 把留痕放到本模块自己的事务会留下「动作已存在但查不到是谁触发的」这一状态。
      audit: { actorKind: 'HUMAN', actorRef: request.actorRef ?? LOCAL_ACTOR_REF,
        commandId: request.commandId ?? operationId, eventType: USER_GIT_READ_EVENT_TYPE },
    });
  }

  if (prepared.status === 'WAITING_APPROVAL') {
    const review = await repositories.reviews.readByOperationId(prepared.operation_id);
    const decision = review === undefined ? undefined : await repositories.reviews.readDecision(review.id);
    if (decision?.decision !== 'APPROVE') {
      return { state: 'WAITING_APPROVAL', operation_id: prepared.operation_id,
        review_id: prepared.review_id, action_type: request.actionType,
        reason: decision?.decision === 'DENY' ? 'HUMAN_DENIED' : 'ACTION_APPROVAL_REQUIRED' };
    }
  }
  if (prepared.status === 'DISPATCHING' || prepared.status === 'UNKNOWN') {
    return { state: 'UNRESOLVED', operation_id: prepared.operation_id,
      review_id: prepared.review_id, action_type: request.actionType,
      reason: prepared.status === 'UNKNOWN' ? 'GATEWAY_RESULT_UNRESOLVED' : 'GATEWAY_IN_FLIGHT' };
  }
  if (prepared.status === 'DENIED') {
    return { state: 'UNRESOLVED', operation_id: prepared.operation_id,
      review_id: prepared.review_id, action_type: request.actionType, reason: 'HUMAN_DENIED' };
  }

  try {
    const dispatched = await dispatchGatewayAction(db, {
      workspaceId: request.workspaceId, operationId: prepared.operation_id, origin,
    });
    if (dispatched.status === 'UNKNOWN') {
      // UNKNOWN 必须以 UNKNOWN 结束：不因「再读一次大概相同」写成成功。
      return { state: 'UNRESOLVED', operation_id: dispatched.operation_id,
        review_id: prepared.review_id, action_type: request.actionType,
        reason: 'GATEWAY_RESULT_UNRESOLVED' };
    }
    return { state: dispatched.status, operation_id: dispatched.operation_id,
      invocation_id: dispatched.invocation_id, action_type: request.actionType,
      result: projectUserGitResult(request, dispatched.result_ref) };
  } catch (error) {
    if (!isPostgresError(error, POSTGRES_ERROR_CODES.uniqueViolation)) throw error;
    // 并发重复投递：另一请求已用同一确定性 ID 建好 Operation。按已存在的事实重新判定一次，
    // 它的状态决定返回什么；不因此再执行一次适配器。
    const concurrent = await repositories.gateway.readOperation(operationId);
    if (concurrent === undefined) throw error;
    return readUserGitStateOnce(db, request, operationId, intentKey, params, canonicalRoot);
  }
}

/**
 * 把 Gateway 落库的结果投影成有界、形状稳定的只读响应。
 *
 * 这一层是「读失败/非 Git 仓库不能显示为干净」的落点：
 *   * 失败时先取落库的**类型化类别**（`GIT_REPOSITORY_UNAVAILABLE` 等），不是空列表；
 *   * 连类别都没有（结果缺失）才落到 `*_RESULT_MISSING`，同样不返回任何路径列表。
 * 两条分支都不产生 staged/unstaged/untracked——空列表正是「非 Git 目录被当成干净」。
 */
export function projectUserGitResult(request: UserGitReadRequest, resultRef: JsonObject | null): JsonObject {
  // 先取类型化失败类别（`failure_kind`），其次是动作级 reason。两者都拿不到才落到
  // `*_RESULT_MISSING`。三条分支都不产生任何路径列表——空列表正是「非 Git 目录被当成干净」。
  const failure = typeof resultRef?.failure_kind === 'string' && resultRef.failure_kind !== ''
    ? resultRef.failure_kind
    : typeof resultRef?.reason === 'string' && resultRef.reason !== '' ? resultRef.reason : undefined;
  if (failure !== undefined) {
    return typeof resultRef?.error === 'string'
      ? { reason: failure, detail: resultRef.error }
      : { reason: failure };
  }
  if (request.actionType === 'GIT_STATUS') {
    const status = resultRef?.status;
    if (status === null || typeof status !== 'object' || Array.isArray(status)) {
      return { reason: 'GIT_STATUS_RESULT_MISSING', detail: '本次读取没有留下状态结果。' };
    }
    return projectGitStatus(status as unknown as GitStatusResult, request.limit);
  }
  const diff = resultRef?.diff;
  if (typeof diff !== 'string') {
    return { reason: 'GIT_DIFF_RESULT_MISSING', detail: '本次读取没有留下差异正文。' };
  }
  return projectGitDiff(diff, request.limit);
}

export const USER_GIT_READ_COMMAND_TYPE = 'ReadManagedGitState';

export interface UserGitReadCommandOutcome {
  readonly result: UserGitReadOutcome;
  readonly replayed: boolean;
  readonly committedAt: Date;
}

/**
 * 命令级幂等：同一 `command_id` 换内容重放被确定性拒绝（COMMAND_ID_REUSED），同内容重放返回
 * 原回执。
 *
 * 这里**不**用 `runIdempotentCommand`：它把业务回调放进自己的事务，而本次读取要真实启动
 * `git` 子进程——契约明确禁止把子进程放进事务。因此回执分两段短事务：先读既有回执（挡住
 * 重放与换内容），读取结算后再补写。「补写前崩溃」的窗口由确定性 Operation ID 兜底：
 * 下次投递读到已结算的同一个 Operation，返回同一份落库结果，不会第二次执行适配器。
 */
export async function runUserGitReadCommand(
  db: DbExecutor, request: UserGitReadRequest & { readonly commandId: string },
): Promise<UserGitReadCommandOutcome> {
  assertUserGitAction(request.actionType);
  const scopeKey = httpCommandScopeKey(request.workspaceId);
  const payloadHash = computePayloadHash({
    commandType: USER_GIT_READ_COMMAND_TYPE,
    target: { project_id: request.projectId, resource_id: request.resourceId },
    body: {
      connection_id: request.connectionId,
      action_type: request.actionType,
      path: request.relativePath ?? null,
      cached: request.cached ?? null,
      limit: request.limit ?? null,
    },
  });
  const repositories = createRepositories(db);
  const existing = await repositories.receipts.findReceipt({ scopeKey, commandId: request.commandId });
  if (existing !== undefined) {
    const replayed = resolveExistingReceipt<JsonObject>(existing, payloadHash);
    return { result: replayed.result as unknown as UserGitReadOutcome,
      replayed: true, committedAt: replayed.committedAt };
  }
  // 与其他命令同一道维护准入门：排空期间不接新工作，但既有回执仍可读。
  requireNormalAdmission(await readAdmission(repositories, 'share'));
  const outcome = await readUserGitState(db, request);
  // 未结算时不写回执。理由是硬的：等待确认或仍在途时，这次读取还没有产生可被重放的结果，
  // 而同一 command_id 在确认之后必须还能推进到真正的读取。持久事实是 Operation 行本身，
  // 它由确定性 ID 保证「一次读取」，因此这里不放宽幂等，只是不冻结一个尚未成立的结论。
  const settled = await isOperationSettled(db, request, outcome);
  if (!settled) {
    return { result: outcome, replayed: false, committedAt: new Date() };
  }
  const result = outcome as unknown as JsonObject;
  try {
    const receipt = await withTransaction(db, (tx) => tx.receipts.insertReceipt({
      scopeKey, commandId: request.commandId, commandType: USER_GIT_READ_COMMAND_TYPE,
      payloadHash, result }));
    return { result: outcome, replayed: false, committedAt: receipt.created_at };
  } catch (error) {
    const winner = await resolveReceiptAfterUniqueViolation<JsonObject>(
      db, error, scopeKey, request.commandId, payloadHash);
    // 并发首次投递由唯一约束裁决：本次返回胜出回执，而不是自己那份尚未被承认的结果。
    return { result: winner.result as unknown as UserGitReadOutcome,
      replayed: true, committedAt: winner.committedAt };
  }
}

/** 只有终态动作才写回执；WAITING_APPROVAL / DISPATCHING / UNKNOWN 都不是可重放的结果。 */
async function isOperationSettled(
  db: DbExecutor, request: UserGitReadRequest, outcome: UserGitReadOutcome,
): Promise<boolean> {
  if (outcome.state === 'SUCCEEDED' || outcome.state === 'FAILED') return true;
  if (outcome.state !== 'UNRESOLVED') return false;
  const operation = await createRepositories(db).gateway.readOperation(outcome.operation_id);
  return operation?.status === 'DENIED';
}
