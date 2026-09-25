import type { FastifyReply, FastifyRequest, RouteHandlerMethod } from 'fastify';
import type { Static, TSchema } from '@sinclair/typebox';

import { CommandIdReusedError, type CommandOutcome } from '../application/command.js';
import { DomainError } from '../application/domain-error.js';
import type { DbExecutor, RelayDatabase } from '../infrastructure/database.js';
import type { JsonObject } from '../infrastructure/json.js';
import type { ManagedContentStore } from '../storage/managed-content-store.js';
import { ProblemError, internalError, problemBody, type ProblemDetails } from './problem.js';

/**
 * 命令成功回执与领域错误到 Problem Details 的映射。
 *
 * 依据 docs/api/http-command-contract.md 第 2 节：
 *   * 成功响应统一为 command_id / committed_at / result / links；
 *   * 相同 command_id 与相同内容返回原成功回执与原 HTTP 成功码，即使 revision 已变化；
 *   * 重放附本项目自定义响应头 Command-Replayed: true。
 * 成功码由 command_type 决定（command_type 与 payload_hash 绑定），因此重放能还原原成功码，
 * 不需要在回执里另存一个 HTTP 状态列。
 */

export interface RouteDependencies {
  readonly database: RelayDatabase;
  /** 受管内容存储：Artifact 版本内容与证据核对使用它，路由不直接拼宿主路径。 */
  readonly storage: ManagedContentStore;
}

export interface CommandBody {
  readonly command_id: string;
}

/** 除 Create* 之外，契约第 3 节显式要求 201 的命令（新版本是新建资源）。 */
const CREATED_COMMAND_TYPES: readonly string[] = ['SubmitHumanArtifactVersion'];

export function successStatusOf(commandType: string): 200 | 201 | 202 {
  // Delegate 已原子获得执行权，但工作尚未完成：按契约第 4 节返回 202（已接受）。
  if (commandType === 'DelegateTask' || commandType === 'RequestRunControl' || commandType === 'ResumeRun') {
    return 202;
  }

  return commandType.startsWith('Create') || CREATED_COMMAND_TYPES.includes(commandType)
    ? 201
    : 200;
}

/** 命令回执的资源链接目标（由 command_type 与结果推导，GET 回执与首次响应一致）。 */
export function resourcePathOf(commandType: string, result: JsonObject): string | undefined {
  switch (commandType) {
    case 'CreateProject':
    case 'LinkProjectGoal':
    case 'UnlinkProjectGoal':
      return typeof result.project_id === 'string' ? `projects/${result.project_id}` : undefined;
    case 'SetProjectState':
      return typeof result.project_id === 'string'
        ? `projects/${result.project_id}/state`
        : undefined;
    case 'CreateGoal':
      return typeof result.goal_id === 'string' ? `goals/${result.goal_id}` : undefined;
    case 'CreateArtifactWithVersion':
    case 'SubmitHumanArtifactVersion':
      return typeof result.artifact_id === 'string' ? `artifacts/${result.artifact_id}` : undefined;
    case 'DelegateTask':
    case 'RequestRunControl':
    case 'ResumeRun':
      return typeof result.run_id === 'string' ? `runs/${result.run_id}` : undefined;
    case 'ResolveReview':
      return typeof result.review_id === 'string' ? `reviews/${result.review_id}` : undefined;
    case 'CreateGatewayConnection':
    case 'DisableGatewayConnection':
      return typeof result.project_id === 'string' && typeof result.connection_id === 'string'
        ? `projects/${result.project_id}/connections/${result.connection_id}` : undefined;
    case 'CreateGatewayPolicy':
    case 'AddGatewayPolicyVersion':
    case 'RevokeGatewayPolicy':
      return typeof result.project_id === 'string' && typeof result.policy_id === 'string'
        ? `projects/${result.project_id}/permission-policies/${result.policy_id}` : undefined;
    case 'CreateManagedResource':
    case 'DisableManagedResource':
      return typeof result.project_id === 'string' && typeof result.resource_id === 'string'
        ? `projects/${result.project_id}/managed-resources/${result.resource_id}` : undefined;
    case 'CreateKnowledge':
    case 'AddKnowledgeVersion':
    case 'ArchiveKnowledge':
      return typeof result.knowledge_id === 'string' ? `knowledge/${result.knowledge_id}` : undefined;
    case 'CreateMemory':
    case 'AddMemoryRevision':
    case 'RetireMemory':
      return typeof result.memory_id === 'string' ? `memories/${result.memory_id}` : undefined;
    case 'CreateDecision':
    case 'SupersedeDecision':
      return typeof result.decision_id === 'string' ? `decisions/${result.decision_id}` : undefined;
    case 'CreateRule':
    case 'AddRuleVersion':
    case 'RetireRule':
      return typeof result.rule_id === 'string' ? `rules/${result.rule_id}` : undefined;
    case 'CreateTask':
    case 'EditTaskPresentation':
    case 'MarkTaskReady':
    case 'StartHumanTask':
    case 'CancelTask':
    case 'SetTaskGoalAlignment':
    case 'AddTaskDependency':
    case 'RemoveTaskDependency':
    case 'CompleteHumanTask':
    case 'ReopenTask':
      return typeof result.task_id === 'string' ? `tasks/${result.task_id}` : undefined;
    default:
      return undefined;
  }
}

export interface CommandEnvelope {
  readonly command_id: string;
  readonly committed_at: string;
  readonly result: JsonObject;
  readonly links: { readonly resource: string };
}

export function buildCommandEnvelope(input: {
  readonly workspaceId: string;
  readonly commandId: string;
  readonly commandType: string;
  readonly committedAt: Date;
  readonly result: JsonObject;
}): CommandEnvelope {
  const resource = resourcePathOf(input.commandType, input.result);

  return {
    command_id: input.commandId,
    committed_at: input.committedAt.toISOString(),
    result: input.result,
    links: { resource: `/api/v1/workspaces/${input.workspaceId}/${resource ?? ''}` },
  };
}

/** 领域错误 → RFC 9457 Problem Details。未识别的错误统一为 INTERNAL_ERROR，不泄漏堆栈/SQL。 */
export function problemFromError(error: unknown, commandId?: string): ProblemDetails {
  if (error instanceof DomainError) {
    return {
      type: error.type,
      title: error.title,
      status: error.status,
      detail: error.detail,
      code: error.code,
      retryable: error.retryable,
      retryAction: error.retryAction,
      ...(error.fieldErrors.length === 0 ? {} : { fieldErrors: error.fieldErrors }),
      ...(commandId === undefined ? {} : { commandId }),
      ...(error.conflict === undefined ? {} : { conflict: error.conflict }),
    };
  }

  if (error instanceof CommandIdReusedError) {
    return {
      type: '/problems/command-id-reused',
      title: 'command_id 已被不同内容使用',
      status: 409,
      detail: '同一 command_id 在同一作用域下已提交过不同内容；修正内容必须换 command_id。',
      code: 'COMMAND_ID_REUSED',
      retryable: false,
      retryAction: 'NONE',
      fieldErrors: [{ field: 'command_id', message: '已被使用，必须为修正后的内容换新 ID' }],
      ...(commandId === undefined ? {} : { commandId }),
    };
  }

  return internalError();
}

export function sendProblem(
  reply: FastifyReply,
  problem: ProblemDetails,
  requestId: string,
): FastifyReply {
  return reply
    .code(problem.status)
    .type('application/problem+json')
    .send(problemBody(problem, requestId));
}

export interface CommandHandlerOptions<TBodySchema extends TSchema, TResult extends JsonObject> {
  readonly commandType: string;
  /** 仅用于类型推导：必须与路由注册时使用的 body schema 是同一个常量。 */
  readonly bodySchema: TBodySchema;
  readonly execute: (input: {
    readonly dependencies: RouteDependencies;
    readonly executor: DbExecutor;
    readonly request: FastifyRequest;
    readonly body: Static<TBodySchema>;
    readonly params: Readonly<Record<string, string>>;
  }) => Promise<{ readonly outcome: CommandOutcome<TResult>; readonly result: TResult }>;
}

/**
 * 所有写命令共用的处理流程：执行用例 → 成功回执（含重放头）或映射后的 Problem Details。
 * 幂等与回执由应用用例负责；这里只负责 HTTP 表达，不重复业务校验。
 */
export function createCommandHandler<TBodySchema extends TSchema, TResult extends JsonObject>(
  dependencies: RouteDependencies,
  options: CommandHandlerOptions<TBodySchema, TResult>,
): RouteHandlerMethod {
  return async (request, reply) => {
    const body = request.body as Static<TBodySchema> & CommandBody;
    const params = (request.params ?? {}) as Record<string, string>;

    try {
      const { outcome, result } = await options.execute({
        dependencies,
        executor: dependencies.database.executor,
        request,
        body,
        params,
      });

      if (outcome.replayed) {
        reply.header('command-replayed', 'true');
      }

      return reply.code(options.commandType === 'CancelTask' && 'control_request_id' in result ? 202 : successStatusOf(options.commandType)).send(
        buildCommandEnvelope({
          workspaceId: params.workspace_id ?? '',
          commandId: body.command_id,
          commandType: options.commandType,
          committedAt: outcome.committedAt,
          result,
        }),
      );
    } catch (error) {
      if (error instanceof ProblemError) {
        return sendProblem(reply, error.problem, request.id);
      }

      if (!(error instanceof DomainError) && !(error instanceof CommandIdReusedError)) {
        request.log.error({ err: error }, 'command_failed');
      }

      return sendProblem(reply, problemFromError(error, body.command_id), request.id);
    }
  };
}

/** 读取端点的错误映射：同样是 Problem Details，不带 command_id。 */
export function sendReadError(
  reply: FastifyReply,
  error: unknown,
  requestId: string,
): FastifyReply {
  if (error instanceof ProblemError) {
    return sendProblem(reply, error.problem, requestId);
  }

  return sendProblem(reply, problemFromError(error), requestId);
}
