import { createHash } from 'node:crypto';
import { isAbsolute, join } from 'node:path';

import type { DbExecutor } from '../infrastructure/database.js';
import type { JsonObject, JsonValue } from '../infrastructure/json.js';
import { isPostgresError, POSTGRES_ERROR_CODES } from '../infrastructure/postgres-error.js';
import { computePayloadHash } from '../receipt/payload-hash.js';
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
 * 人工触发的受管目录浏览与文件读取入口（2026-10-24 工具面板「文件」页签后端；
 * docs/architecture/tool-adapters.md「人工 FILE_READ / FILE_QUERY 只读入口」段、迁移 0134）。
 *
 * 协调顺序与 git-user-action.ts 不可交换的同一顺序：
 *   1. 规范化动作与参数（纯函数，先于任何 IO）；
 *   2. prepare 一个 USER_ACTION 逻辑动作（短事务：Operation + 受管资源 + Connection + 权限
 *      事实 + 人工审计同批提交；在途写入占用目录时按 RESOURCE_OCCUPIED 拒绝）；
 *   3. ASK 到此为止——确认是一个独立人工事实，同一请求不代替它决定；
 *   4. AUTO 时派发一次（适配器在事务外）；
 *   5. 投影校验结果形状，失败按落库的类型化 reason 透出。
 *
 * 与 git 人工读取的**关键差异在动作身份**：git 的 Operation ID 只按参数确定性导出，同参数
 * 永远读回第一次的落库结果；目录浏览如果沿用它，目录树展开一次即永远冻结。这里把
 * `command_id` 一并纳入摘要：同一命令崩溃重投收敛到同一次读取（不二次执行适配器），
 * 新命令（用户每一次点击）产生新的读取事实。两条路径都不产生「同命令读两次」的账本。
 *
 * 与 git 的另一差异是 limit 的归属：LIST_DIRECTORY 的 limit 在适配器内生效（有界枚举），
 * 因此它进冻结参数并参与动作身份；git 的 limit 只管投影层展示，故被排除在冻结之外。
 *
 * 只读不代表无事实：读取仍产生 Operation 与 Invocation，账本必须能回答「谁在什么时候
 * 读了哪个受管目录的哪个路径、读到的是什么」。READ_FILE 正文上限与二进制拒绝由适配器
 * （fileReadExecute）按既有口径裁决，这里不另立一份边界。
 */

export type UserFileReadAction = Extract<GatewayActionType, 'LIST_DIRECTORY' | 'READ_FILE'>;

export const USER_FILE_READ_ACTIONS: readonly UserFileReadAction[] = ['LIST_DIRECTORY', 'READ_FILE'];

export const USER_FILE_READ_EVENT_TYPE = 'MANAGED_FILE_READ_REQUESTED';

export interface UserFileReadRequest {
  readonly workspaceId: string;
  readonly projectId: string;
  readonly resourceId: string;
  readonly connectionId: string;
  readonly actionType: UserFileReadAction;
  /**
   * 受管根内相对路径。LIST_DIRECTORY 缺省表示受管根自身；READ_FILE 必填。
   * 不接受绝对路径与 `..` 段——越界交给 prepare 的根内判定以类型化拒绝，这里的早期
   * 校验只保证「同一个相对路径进 target 与 params 时形状一致」。
   */
  readonly relativePath?: string | undefined;
  /** LIST_DIRECTORY 的条目数上限（1..200，适配器内生效）；READ_FILE 不接受 limit。 */
  readonly limit?: number | undefined;
  /** 人工主体标识。V1 是服务端固定的本机单用户，调用方不得自行声明身份。 */
  readonly actorRef?: string | undefined;
  /** 活动留痕用的命令 ID；同时参与动作身份（见模块注释）。 */
  readonly commandId?: string | undefined;
}

export interface UserFileReadSettled {
  readonly state: 'SUCCEEDED' | 'FAILED';
  readonly operation_id: string;
  readonly invocation_id: string | null;
  readonly action_type: UserFileReadAction;
  readonly result: JsonObject;
}

/** 本次请求没有产生可读结果：要么等确认，要么必须先核对在途调用。绝不返回旧内容充数。 */
export interface UserFileReadPending {
  readonly state: 'WAITING_APPROVAL' | 'UNRESOLVED';
  readonly operation_id: string;
  readonly review_id: string | null;
  readonly action_type: UserFileReadAction;
  readonly reason: string;
}

export type UserFileReadOutcome = UserFileReadSettled | UserFileReadPending;

function originDenied(detail: string): DomainError {
  return new DomainError({ code: 'GATEWAY_ORIGIN_DENIED', status: 409,
    type: '/problems/gateway-origin-denied', title: 'Gateway 拒绝执行', detail,
    retryable: false, retryAction: 'REFRESH_AND_REDECIDE' });
}

export function assertUserFileAction(actionType: string): asserts actionType is UserFileReadAction {
  if (!USER_FILE_READ_ACTIONS.includes(actionType as UserFileReadAction)) {
    throw originDenied('人工入口只放行受管资源上的 LIST_DIRECTORY 与 READ_FILE。');
  }
}

/**
 * 确定性动作身份：Workspace + 资源 + 动作 + 参数 + command_id 的摘要。
 * command_id 在列是本模块与 git 人工读取的分界（见模块注释）——同命令重投定位同一条
 * 事实，新命令换新身份，目录浏览因此可以刷新而不破坏「一次读取只执行一次」。
 */
export function userFileOperationId(request: UserFileReadRequest): string {
  const digest = createHash('sha256').update(JSON.stringify({
    workspace_id: request.workspaceId,
    project_id: request.projectId,
    resource_id: request.resourceId,
    action_type: request.actionType,
    path: request.relativePath ?? null,
    limit: request.limit ?? null,
    command_id: request.commandId ?? null,
  })).digest('hex');
  // 与既有 Operation ID 同形（uuid 文本），但由摘要导出而不是随机生成，因此可重复定位。
  return [digest.slice(0, 8), digest.slice(8, 12), digest.slice(12, 16),
    digest.slice(16, 20), digest.slice(20, 32)].join('-');
}

/** intent_key 与动作身份同源：同一动作重复投递落到同一条意图上，不会新建第二个 Operation。 */
export function userFileIntentKey(operationId: string): string {
  return `user-file-read:${operationId}`;
}

/**
 * 把调用方的可选参数收敛成 Gateway 冻结用的形态。未知或错位的参数在 IO 之前即被拒绝。
 *
 * 与模型侧 tool-loop 同一口径：READ_FILE 的路径只进 target（params 为空）；
 * LIST_DIRECTORY 的 relative_path 与 limit 进 params，limit 因适配器内生效而属冻结参数。
 */
export function normalizeUserFileParams(request: UserFileReadRequest): JsonObject {
  const path = request.relativePath;
  if (path !== undefined) {
    if (typeof path !== 'string' || path.trim() === '') {
      throw validationFailed([{ field: 'path', message: 'must be a nonempty string' }]);
    }
    if (isAbsolute(path)) {
      throw validationFailed([{ field: 'path', message: 'must be relative to the managed root' }]);
    }
    if (path.split(/[\\/]+/).some((segment) => segment === '..')) {
      throw validationFailed([{ field: 'path', message: 'must not traverse outside the managed root' }]);
    }
  }
  if (request.actionType === 'READ_FILE') {
    if (path === undefined) {
      throw validationFailed([{ field: 'path', message: 'read_file requires a file path' }]);
    }
    if (request.limit !== undefined) {
      throw validationFailed([{ field: 'limit', message: 'read_file takes no limit' }]);
    }
    return {};
  }
  const params: Record<string, JsonValue> = {};
  if (path !== undefined) {
    params.relative_path = path;
  }
  if (request.limit !== undefined) {
    if (!Number.isInteger(request.limit) || request.limit <= 0) {
      throw validationFailed([{ field: 'limit', message: 'must be a positive integer' }]);
    }
    params.limit = request.limit;
  }
  return params;
}

/** READ_FILE 的目标拼到受管根上（绝对路径，prepare 再按 realpath 归一并做根内判定）。 */
export function userFileTarget(canonicalRoot: string, request: UserFileReadRequest): string {
  return join(canonicalRoot, request.relativePath ?? '');
}

/** 准备并（按 Permission 判定）派发一次人工文件只读。 */
export async function readUserFileState(
  db: DbExecutor, request: UserFileReadRequest,
): Promise<UserFileReadOutcome> {
  assertUserFileAction(request.actionType);
  const params = normalizeUserFileParams(request);
  const operationId = userFileOperationId(request);
  const intentKey = userFileIntentKey(operationId);
  const repositories = createRepositories(db);
  const resource = await repositories.gateway.readResource(request.resourceId);
  if (resource === undefined || resource.workspace_id !== request.workspaceId ||
      resource.project_id !== request.projectId) {
    throw resourceNotFound('Managed resource');
  }

  return readUserFileStateOnce(db, request, operationId, intentKey, params,
    userFileTarget(resource.canonical_root, request));
}

/** 一次尝试；并发重复投递的唯一约束冲突在这里收敛为「读已存在的事实」，不重跑适配器。 */
async function readUserFileStateOnce(
  db: DbExecutor,
  request: UserFileReadRequest,
  operationId: string,
  intentKey: string,
  params: JsonObject,
  target: string,
): Promise<UserFileReadOutcome> {
  const repositories = createRepositories(db);
  const origin = { kind: 'USER_ACTION' as const,
    projectId: request.projectId, resourceId: request.resourceId };
  let prepared: PreparedGatewayAction;
  const located = await repositories.gateway.readOperation(operationId);
  if (located !== undefined) {
    // 动作身份含 command_id，因此定位到既有动作只发生在「同一命令重投」（崩溃后补回执、
    // 或未结算时核对）：按落库事实返回，不再执行适配器。能力核对防止身份摘要碰撞被
    // 当成合法重放。
    const expectedCapability = request.actionType === 'LIST_DIRECTORY' ? 'FILE_QUERY' : 'FILE_READ';
    if (located.origin !== 'USER_ACTION' || located.capability_key !== expectedCapability) {
      throw new DomainError({ code: 'GATEWAY_INTENT_CONFLICT', status: 409,
        type: '/problems/gateway-intent-conflict', title: 'Gateway 事实冲突',
        detail: '同一动作身份已绑定其他 Gateway 动作。',
        retryable: false, retryAction: 'REFRESH_AND_REDECIDE' });
    }
    prepared = { operation_id: located.id, status: located.status,
      invocation_id: (await repositories.gateway.lastInvocation(located.id))?.id ?? null,
      review_id: (await repositories.reviews.readByOperationId(located.id))?.id ?? null };
    if (located.status === 'SUCCEEDED' || located.status === 'FAILED') {
      return { state: located.status, operation_id: located.id,
        invocation_id: prepared.invocation_id, action_type: request.actionType,
        result: projectUserFileResult(request, located.result_ref) };
    }
  } else {
    prepared = await prepareGatewayAction(db, {
      workspaceId: request.workspaceId, operationId, intentKey,
      connectionId: request.connectionId, origin,
      actionType: request.actionType, target, params,
      // 人工主体与动作身份在同一事务落库。USER_ACTION 词表没有 actor 列（迁移 0058），
      // 把留痕放到本模块自己的事务会留下「动作已存在但查不到是谁触发的」这一状态。
      audit: { actorKind: 'HUMAN', actorRef: request.actorRef ?? LOCAL_ACTOR_REF,
        commandId: request.commandId ?? operationId, eventType: USER_FILE_READ_EVENT_TYPE },
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
      result: projectUserFileResult(request, dispatched.result_ref) };
  } catch (error) {
    if (!isPostgresError(error, POSTGRES_ERROR_CODES.uniqueViolation)) throw error;
    // 并发重复投递：另一请求已用同一确定性 ID 建好 Operation。按已存在的事实重新判定一次，
    // 它的状态决定返回什么；不因此再执行一次适配器。
    const concurrent = await repositories.gateway.readOperation(operationId);
    if (concurrent === undefined) throw error;
    return readUserFileStateOnce(db, request, operationId, intentKey, params, target);
  }
}

/**
 * 把 Gateway 落库的结果投影成形状稳定的只读响应。
 *
 * 有界化（条目数、正文字节、截断标记）在适配器内完成，这里只做两件事：
 *   * 失败先取落库的**类型化类别**（`failure_kind` / `reason`），不是空结果；
 *   * 结果缺失时落到 `*_RESULT_MISSING`，不把缺结果冒充成空目录或空文件。
 */
export function projectUserFileResult(request: UserFileReadRequest,
  resultRef: JsonObject | null): JsonObject {
  const failure = typeof resultRef?.failure_kind === 'string' && resultRef.failure_kind !== ''
    ? resultRef.failure_kind
    : typeof resultRef?.reason === 'string' && resultRef.reason !== '' ? resultRef.reason : undefined;
  if (failure !== undefined) {
    return typeof resultRef?.error === 'string'
      ? { reason: failure, detail: resultRef.error }
      : { reason: failure };
  }
  if (request.actionType === 'LIST_DIRECTORY') {
    const entries = resultRef?.entries;
    if (!Array.isArray(entries)) {
      return { reason: 'FILE_QUERY_RESULT_MISSING', detail: '本次读取没有留下目录结果。' };
    }
    return resultRef as JsonObject;
  }
  if (typeof resultRef?.content !== 'string') {
    return { reason: 'FILE_READ_RESULT_MISSING', detail: '本次读取没有留下文件正文。' };
  }
  return resultRef as JsonObject;
}

export const USER_FILE_READ_COMMAND_TYPE = 'ReadManagedFileState';

export interface UserFileReadCommandOutcome {
  readonly result: UserFileReadOutcome;
  readonly replayed: boolean;
  readonly committedAt: Date;
}

/**
 * 命令级幂等：同一 `command_id` 换内容重放被确定性拒绝（COMMAND_ID_REUSED），同内容重放返回
 * 原回执。
 *
 * 与 git 同一理由**不**用 `runIdempotentCommand`：适配器真实读磁盘，不能放进事务。回执分
 * 两段短事务：先读既有回执（挡住重放与换内容），读取结算后再补写。「补写前崩溃」的窗口由
 * 含 command_id 的确定性 Operation ID 兜底：下次投递定位到已结算的同一个 Operation，返回
 * 同一份落库结果，不会第二次执行适配器。
 */
export async function runUserFileReadCommand(
  db: DbExecutor, request: UserFileReadRequest & { readonly commandId: string },
): Promise<UserFileReadCommandOutcome> {
  assertUserFileAction(request.actionType);
  const scopeKey = httpCommandScopeKey(request.workspaceId);
  const payloadHash = computePayloadHash({
    commandType: USER_FILE_READ_COMMAND_TYPE,
    target: { project_id: request.projectId, resource_id: request.resourceId },
    body: {
      connection_id: request.connectionId,
      action_type: request.actionType,
      path: request.relativePath ?? null,
      limit: request.limit ?? null,
    },
  });
  const repositories = createRepositories(db);
  const existing = await repositories.receipts.findReceipt({ scopeKey, commandId: request.commandId });
  if (existing !== undefined) {
    const replayed = resolveExistingReceipt<JsonObject>(existing, payloadHash);
    return { result: replayed.result as unknown as UserFileReadOutcome,
      replayed: true, committedAt: replayed.committedAt };
  }
  // 与其他命令同一道维护准入门：排空期间不接新工作，但既有回执仍可读。
  requireNormalAdmission(await readAdmission(repositories, 'share'));
  const outcome = await readUserFileState(db, request);
  // 未结算时不写回执：等待确认或在途时，这次读取还没有产生可被重放的结果，而同一
  // command_id 在确认之后必须还能推进到真正的读取。
  const settled = await isOperationSettled(db, request, outcome);
  if (!settled) {
    return { result: outcome, replayed: false, committedAt: new Date() };
  }
  const result = outcome as unknown as JsonObject;
  try {
    const receipt = await withTransaction(db, (tx) => tx.receipts.insertReceipt({
      scopeKey, commandId: request.commandId, commandType: USER_FILE_READ_COMMAND_TYPE,
      payloadHash, result }));
    return { result: outcome, replayed: false, committedAt: receipt.created_at };
  } catch (error) {
    const winner = await resolveReceiptAfterUniqueViolation<JsonObject>(
      db, error, scopeKey, request.commandId, payloadHash);
    // 并发首次投递由唯一约束裁决：本次返回胜出回执，而不是自己那份尚未被承认的结果。
    return { result: winner.result as unknown as UserFileReadOutcome,
      replayed: true, committedAt: winner.committedAt };
  }
}

/** 只有终态动作才写回执；WAITING_APPROVAL / DISPATCHING / UNKNOWN 都不是可重放的结果。 */
async function isOperationSettled(
  db: DbExecutor, request: UserFileReadRequest, outcome: UserFileReadOutcome,
): Promise<boolean> {
  if (outcome.state === 'SUCCEEDED' || outcome.state === 'FAILED') return true;
  if (outcome.state !== 'UNRESOLVED') return false;
  const operation = await createRepositories(db).gateway.readOperation(outcome.operation_id);
  return operation?.status === 'DENIED';
}
