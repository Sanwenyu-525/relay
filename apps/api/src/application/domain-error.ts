import type { FieldError } from '../shared/field-error.js';

/**
 * 应用层领域错误。
 *
 * 这里只表达“哪条业务规则没满足”，HTTP 结构（RFC 9457 / code / retry_action）在 api 层映射，
 * 见 docs/api/http-command-contract.md 第 7 节。领域层不直接依赖 Fastify，也不抛裸 Error 让调用方猜语义。
 */

export type RetryAction =
  | 'NONE'
  | 'REFRESH_AND_REDECIDE'
  | 'POLL_RESOURCE'
  | 'CHECK_RECEIPT_THEN_RETRY';

export interface DomainConflict {
  readonly entityType?: string;
  readonly expectedRevision?: string;
  readonly actualRevision?: string;
  readonly field?: string;
  readonly goalId?: string;
  readonly goalIds?: readonly string[];
  readonly taskId?: string;
  readonly dependsOnTaskId?: string;
  readonly impactedTaskIds?: readonly string[];
  readonly blockingTaskIds?: readonly string[];
  readonly blockerIds?: readonly string[];
  readonly cycleTaskIds?: readonly string[];
  /** 完成被拒时的确切验收周期、当前完成凭据与产物/人工项依据（P03）。 */
  readonly acceptanceRevision?: string;
  readonly currentCompletionId?: string;
  readonly criterionIds?: readonly string[];
  readonly artifactVersionIds?: readonly string[];
  readonly artifactKinds?: readonly string[];
}

export interface DomainErrorOptions {
  readonly code: string;
  readonly status: number;
  readonly type: string;
  readonly title: string;
  readonly detail: string;
  readonly retryable: boolean;
  readonly retryAction: RetryAction;
  readonly fieldErrors?: readonly FieldError[];
  readonly conflict?: DomainConflict;
}

export class DomainError extends Error {
  override readonly name = 'DomainError';

  readonly code: string;
  readonly status: number;
  readonly type: string;
  readonly title: string;
  readonly detail: string;
  readonly retryable: boolean;
  readonly retryAction: RetryAction;
  readonly fieldErrors: readonly FieldError[];
  readonly conflict: DomainConflict | undefined;

  constructor(options: DomainErrorOptions) {
    super(`${options.code}: ${options.detail}`);
    this.code = options.code;
    this.status = options.status;
    this.type = options.type;
    this.title = options.title;
    this.detail = options.detail;
    this.retryable = options.retryable;
    this.retryAction = options.retryAction;
    this.fieldErrors = options.fieldErrors ?? [];
    this.conflict = options.conflict;
  }
}

/** 资源在当前作用域不可见：跨 Workspace 或其他作用域的 ID 一律按不可见处理。 */
export function resourceNotFound(entity: string): DomainError {
  return new DomainError({
    code: 'RESOURCE_NOT_FOUND',
    status: 404,
    type: '/problems/resource-not-found',
    title: '资源不存在',
    detail: `${entity}在当前作用域中不可见或不存在。`,
    retryable: false,
    retryAction: 'NONE',
  });
}

export function commandNotFound(): DomainError {
  return new DomainError({
    code: 'COMMAND_NOT_FOUND',
    status: 404,
    type: '/problems/command-not-found',
    title: '命令回执不存在',
    detail: '该 command_id 在当前作用域下没有已提交的回执；这不证明仍有在途请求。',
    retryable: false,
    retryAction: 'CHECK_RECEIPT_THEN_RETRY',
  });
}

/** 版本不匹配：不采用 last-write-wins，调用方刷新后重建意图。 */
export function revisionConflict(input: {
  readonly entityType: string;
  readonly expectedRevision: string;
  readonly actualRevision: string;
}): DomainError {
  return new DomainError({
    code: 'REVISION_CONFLICT',
    status: 409,
    type: '/problems/revision-conflict',
    title: '资源版本已变化',
    detail: `${input.entityType} 已被其他操作更新，请刷新后重新决定。`,
    retryable: false,
    retryAction: 'REFRESH_AND_REDECIDE',
    conflict: {
      entityType: input.entityType,
      expectedRevision: input.expectedRevision,
      actualRevision: input.actualRevision,
    },
  });
}

/** 当前事实不满足操作（状态机不允许的迁移、重复的关联事实等）。 */
export function invalidTransition(
  detail: string,
  conflict?: DomainConflict,
): DomainError {
  return new DomainError({
    code: 'INVALID_TRANSITION',
    status: 409,
    type: '/problems/invalid-transition',
    title: '当前事实不满足该操作',
    detail,
    retryable: false,
    retryAction: 'REFRESH_AND_REDECIDE',
    ...(conflict === undefined ? {} : { conflict }),
  });
}

export function validationFailed(fieldErrors: readonly FieldError[]): DomainError {
  return new DomainError({
    code: 'VALIDATION_FAILED',
    status: 422,
    type: '/problems/validation-failed',
    title: '请求未通过校验',
    detail: '请求字段不满足端点契约。',
    retryable: false,
    retryAction: 'NONE',
    fieldErrors,
  });
}

export function requiredInputMissing(fieldErrors: readonly FieldError[]): DomainError {
  return new DomainError({
    code: 'REQUIRED_INPUT_MISSING',
    status: 422,
    type: '/problems/required-input-missing',
    title: '缺少必需输入',
    detail: '请求缺少完成该命令所需的输入。',
    retryable: false,
    retryAction: 'NONE',
    fieldErrors,
  });
}

export function invalidCursor(field: string, detail: string): DomainError {
  return new DomainError({
    code: 'INVALID_CURSOR',
    status: 400,
    type: '/problems/invalid-cursor',
    title: '游标不可用',
    detail,
    retryable: false,
    retryAction: 'NONE',
    fieldErrors: [{ field, message: detail }],
  });
}

/** 解除 Project–Goal 关联时，显式对齐的 Task 集合与调用方提交的清单不一致。 */
export function goalLinkInUse(input: {
  readonly goalId: string;
  readonly impactedTaskIds: readonly string[];
}): DomainError {
  return new DomainError({
    code: 'GOAL_LINK_IN_USE',
    status: 409,
    type: '/problems/goal-link-in-use',
    title: '存在显式 Goal 对齐',
    detail: '该 Goal 仍被 Task 显式对齐；请在同一个解除操作中提交当前受影响清单。',
    retryable: false,
    retryAction: 'REFRESH_AND_REDECIDE',
    conflict: { goalId: input.goalId, impactedTaskIds: input.impactedTaskIds },
  });
}

/** 显式 Goal 集合必须是所属 Project 当前 Goal 的子集，并且只对所属 Project 有效。 */
export function goalAlignmentInvalid(input: {
  readonly detail: string;
  readonly conflict?: DomainConflict;
  readonly fieldErrors?: readonly FieldError[];
}): DomainError {
  return new DomainError({
    code: 'GOAL_ALIGNMENT_INVALID',
    status: 409,
    type: '/problems/goal-alignment-invalid',
    title: 'Goal 对齐不成立',
    detail: input.detail,
    retryable: false,
    retryAction: 'REFRESH_AND_REDECIDE',
    ...(input.conflict === undefined ? {} : { conflict: input.conflict }),
    ...(input.fieldErrors === undefined ? {} : { fieldErrors: input.fieldErrors }),
  });
}

/** 自依赖与依赖环统一按 DEPENDENCY_CYCLE 处理（自依赖是一条长度为 1 的环）。 */
export function dependencyCycle(conflict: DomainConflict): DomainError {
  return new DomainError({
    code: 'DEPENDENCY_CYCLE',
    status: 409,
    type: '/problems/dependency-cycle',
    title: '依赖关系会形成环',
    detail: '任务依赖必须是有向无环关系，禁止自依赖与环。',
    retryable: false,
    retryAction: 'NONE',
    conflict,
  });
}

/** 本阶段未开放的能力（例如 Delegate 与 DELEGATE_AI）。 */
export function capabilityDisabled(field: string, detail: string): DomainError {
  return new DomainError({
    code: 'CAPABILITY_DISABLED',
    status: 409,
    type: '/problems/capability-disabled',
    title: '能力尚未开放',
    detail,
    retryable: false,
    retryAction: 'NONE',
    fieldErrors: [{ field, message: detail }],
  });
}

/**
 * 执行权冲突：Task 已有未释放的 AI 执行权占有者，或并发 Delegate 竞争同一 Task。
 * 依据 contracts/02-state-and-execution.md 第 2 节不变量 1：一个 Task 至多一个 AI 执行权占有者。
 */
export function executorConflict(
  detail: string,
  conflict?: DomainConflict,
): DomainError {
  return new DomainError({
    code: 'EXECUTOR_CONFLICT',
    status: 409,
    type: '/problems/executor-conflict',
    title: '执行权冲突',
    detail,
    retryable: false,
    retryAction: 'POLL_RESOURCE',
    ...(conflict === undefined ? {} : { conflict }),
  });
}

/**
 * 完成时提交的 acceptance_revision 不是 Task 当前周期（详情与失效规则见
 * contracts/03-verification-and-approval.md 第 5 节：验收条件改变后旧凭据不能完成新周期）。
 */
export function acceptanceStale(input: {
  readonly expectedAcceptanceRevision: string;
  readonly actualAcceptanceRevision: string;
  readonly taskId: string;
}): DomainError {
  return new DomainError({
    code: 'ACCEPTANCE_STALE',
    status: 409,
    type: '/problems/acceptance-stale',
    title: '验收契约已变化',
    detail: '提交的 acceptance_revision 不是该 Task 的当前验收版本；旧凭据不能完成新周期。',
    retryable: false,
    retryAction: 'REFRESH_AND_REDECIDE',
    conflict: {
      entityType: 'TASK_ACCEPTANCE',
      expectedRevision: input.expectedAcceptanceRevision,
      actualRevision: input.actualAcceptanceRevision,
      acceptanceRevision: input.actualAcceptanceRevision,
      taskId: input.taskId,
    },
  });
}

/** 首个切片只接受 text/markdown 的 UTF-8 文本（契约第 3、7 节）。 */
export function unsupportedMediaType(mediaType: string): DomainError {
  return new DomainError({
    code: 'UNSUPPORTED_MEDIA_TYPE',
    status: 415,
    type: '/problems/unsupported-media-type',
    title: '内容类型不受支持',
    detail: '首个切片只接受 text/markdown 的 UTF-8 文本。',
    retryable: false,
    retryAction: 'NONE',
    fieldErrors: [{ field: 'media_type', message: `must be one of: text/markdown (received ${mediaType})` }],
  });
}

/** 正文大小上限是本版产品限制（256 KiB），按 UTF-8 字节数判定。 */
export function contentTooLarge(size: number, limit: number): DomainError {
  return new DomainError({
    code: 'CONTENT_TOO_LARGE',
    status: 413,
    type: '/problems/content-too-large',
    title: '内容超出上限',
    detail: `正文的 UTF-8 字节数必须不超过 ${limit}，当前为 ${size}。`,
    retryable: false,
    retryAction: 'NONE',
    fieldErrors: [{ field: 'content', message: `must not exceed ${limit} UTF-8 bytes` }],
  });
}

/** 本地受管存储不可用：不伪造已保存，也不把失败内容登记为版本。 */
export function storageUnavailable(): DomainError {
  return new DomainError({
    code: 'STORAGE_UNAVAILABLE',
    status: 503,
    type: '/problems/storage-unavailable',
    title: '受管内容存储不可用',
    detail: '内容未能完整发布到受管存储，本次命令没有登记任何版本。',
    retryable: true,
    retryAction: 'CHECK_RECEIPT_THEN_RETRY',
  });
}

/**
 * 证据不可用：文件被删除、替换或与登记的 hash/size 不一致。
 * 不伪造内容、不重写旧 hash，也绝不允许依赖该证据的完成继续（物理设计第 7 节）。
 */
export function evidenceUnavailable(input: {
  readonly artifactVersionId: string;
  readonly reason: 'MISSING' | 'TAMPERED' | 'UNREADABLE';
}): DomainError {
  const reasonText =
    input.reason === 'MISSING'
      ? '受管内容文件缺失'
      : input.reason === 'TAMPERED'
        ? '受管内容与登记的 hash/size 不一致'
        : '受管内容无法读取';

  return new DomainError({
    code: 'EVIDENCE_UNAVAILABLE',
    status: 503,
    type: '/problems/evidence-unavailable',
    title: '证据不可用',
    detail: `${reasonText}；该产物版本不能被当作可核对证据使用。`,
    retryable: false,
    retryAction: 'CHECK_RECEIPT_THEN_RETRY',
    conflict: { entityType: 'ARTIFACT_VERSION', artifactVersionIds: [input.artifactVersionId] },
  });
}