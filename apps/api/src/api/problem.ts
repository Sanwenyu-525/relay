import type { FieldError } from '../shared/field-error.js';

export type { FieldError };

export type RetryAction =
  | 'NONE'
  | 'REFRESH_AND_REDECIDE'
  | 'POLL_RESOURCE'
  | 'CHECK_RECEIPT_THEN_RETRY';

/** 冲突明细：按 code 取其中相关字段，见 docs/api/http-command-contract.md 第 7 节。 */
export interface ConflictDetails {
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
  readonly acceptanceRevision?: string;
  readonly currentCompletionId?: string;
  readonly criterionIds?: readonly string[];
  readonly artifactVersionIds?: readonly string[];
  readonly artifactKinds?: readonly string[];
  readonly blockingReasons?: readonly string[];
}

export interface ProblemDetails {
  readonly type: string;
  readonly title: string;
  readonly status: number;
  readonly detail: string;
  readonly code: string;
  readonly retryable: boolean;
  readonly retryAction: RetryAction;
  readonly fieldErrors?: readonly FieldError[];
  readonly commandId?: string;
  readonly conflict?: ConflictDetails;
}

export class ProblemError extends Error {
  readonly problem: ProblemDetails;

  constructor(problem: ProblemDetails) {
    super(`${problem.code}: ${problem.detail}`);
    this.name = 'ProblemError';
    this.problem = problem;
  }
}

export function problemBody(
  problem: ProblemDetails,
  requestId: string,
): Record<string, unknown> {
  const body: Record<string, unknown> = {
    type: problem.type,
    title: problem.title,
    status: problem.status,
    detail: problem.detail,
    instance: `/requests/${requestId}`,
    code: problem.code,
    request_id: requestId,
    retryable: problem.retryable,
    retry_action: problem.retryAction,
  };

  if (problem.fieldErrors !== undefined && problem.fieldErrors.length > 0) {
    body.field_errors = problem.fieldErrors;
  }

  if (problem.commandId !== undefined) {
    body.command_id = problem.commandId;
  }

  if (problem.conflict !== undefined) {
    body.conflict = conflictBody(problem.conflict);
  }

  return body;
}

function conflictBody(conflict: ConflictDetails): Record<string, unknown> {
  const body: Record<string, unknown> = {};

  if (conflict.entityType !== undefined) {
    body.entity_type = conflict.entityType;
  }

  if (conflict.expectedRevision !== undefined) {
    body.expected_revision = conflict.expectedRevision;
  }

  if (conflict.actualRevision !== undefined) {
    body.actual_revision = conflict.actualRevision;
  }

  if (conflict.field !== undefined) {
    body.field = conflict.field;
  }

  if (conflict.goalId !== undefined) {
    body.goal_id = conflict.goalId;
  }

  if (conflict.goalIds !== undefined) {
    body.goal_ids = conflict.goalIds;
  }

  if (conflict.taskId !== undefined) {
    body.task_id = conflict.taskId;
  }

  if (conflict.dependsOnTaskId !== undefined) {
    body.depends_on_task_id = conflict.dependsOnTaskId;
  }

  if (conflict.impactedTaskIds !== undefined) {
    body.impacted_task_ids = conflict.impactedTaskIds;
  }

  if (conflict.blockingTaskIds !== undefined) {
    body.blocking_task_ids = conflict.blockingTaskIds;
  }

  if (conflict.blockerIds !== undefined) {
    body.blocker_ids = conflict.blockerIds;
  }

  if (conflict.cycleTaskIds !== undefined) {
    body.cycle_task_ids = conflict.cycleTaskIds;
  }

  if (conflict.acceptanceRevision !== undefined) {
    body.acceptance_revision = conflict.acceptanceRevision;
  }

  if (conflict.currentCompletionId !== undefined) {
    body.current_completion_id = conflict.currentCompletionId;
  }

  if (conflict.criterionIds !== undefined) {
    body.criterion_ids = conflict.criterionIds;
  }

  if (conflict.artifactVersionIds !== undefined) {
    body.artifact_version_ids = conflict.artifactVersionIds;
  }

  if (conflict.blockingReasons !== undefined) {
    body.blocking_reasons = conflict.blockingReasons;
  }

  if (conflict.artifactKinds !== undefined) {
    body.artifact_kinds = conflict.artifactKinds;
  }

  return body;
}

export function authRequired(): ProblemDetails {
  return {
    type: '/problems/auth-required',
    title: '需要本机凭据',
    status: 401,
    detail: '该端点需要当前服务实例的 Bearer 凭据。',
    code: 'AUTH_REQUIRED',
    retryable: false,
    retryAction: 'NONE',
  };
}

export function invalidHost(): ProblemDetails {
  return {
    type: '/problems/invalid-host',
    title: 'Host 不被接受',
    status: 400,
    detail: '请求的 Host 必须与当前服务实例绑定的回环地址与端口一致。',
    code: 'MALFORMED_REQUEST',
    retryable: false,
    retryAction: 'NONE',
  };
}

export function invalidOrigin(): ProblemDetails {
  return {
    type: '/problems/invalid-origin',
    title: '来源未被允许',
    status: 403,
    detail: '请求来源不在本机显式允许列表中。',
    code: 'PERMISSION_DENIED',
    retryable: false,
    retryAction: 'NONE',
  };
}

export function malformedRequest(detail: string): ProblemDetails {
  return {
    type: '/problems/malformed-request',
    title: '请求无法解析',
    status: 400,
    detail,
    code: 'MALFORMED_REQUEST',
    retryable: false,
    retryAction: 'NONE',
  };
}

export function resourceNotFound(): ProblemDetails {
  return {
    type: '/problems/resource-not-found',
    title: '资源不存在',
    status: 404,
    detail: '请求的路径在当前服务上不存在。',
    code: 'RESOURCE_NOT_FOUND',
    retryable: false,
    retryAction: 'NONE',
  };
}

export function validationFailed(fieldErrors: readonly FieldError[]): ProblemDetails {
  return {
    type: '/problems/validation-failed',
    title: '请求未通过校验',
    status: 422,
    detail: '请求结构不符合端点契约。',
    code: 'VALIDATION_FAILED',
    retryable: false,
    retryAction: 'NONE',
    fieldErrors,
  };
}

export function databaseUnavailable(): ProblemDetails {
  return {
    type: '/problems/database-unavailable',
    title: '数据库不可用',
    status: 503,
    detail: '当前实例无法连接业务数据库，读写能力关闭。',
    code: 'DATABASE_UNAVAILABLE',
    retryable: true,
    retryAction: 'POLL_RESOURCE',
  };
}

export function schemaUnavailable(): ProblemDetails {
  return {
    type: '/problems/schema-unavailable',
    title: '数据库结构不可用',
    status: 503,
    detail: '数据库可连接，但当前 schema 未满足服务所需的迁移版本或内容摘要。',
    code: 'SCHEMA_UNAVAILABLE',
    retryable: true,
    retryAction: 'POLL_RESOURCE',
  };
}

export function internalError(): ProblemDetails {
  return {
    type: '/problems/internal-error',
    title: '服务内部错误',
    status: 500,
    detail: '请求未能完成，请通过 request_id 在本机日志中核对。',
    code: 'INTERNAL_ERROR',
    retryable: false,
    retryAction: 'CHECK_RECEIPT_THEN_RETRY',
  };
}
