import type { FastifyInstance, FastifyRequest } from 'fastify';
import { type Static } from '@sinclair/typebox';

import { createTask } from '../application/create-task.js';
import { applySafeControl } from '../application/control-requests.js';
import { requiredInputMissing, validationFailed } from '../application/domain-error.js';
import { readProjectInWorkspace, requireWorkspaceVisible } from '../application/guards.js';
import { isUuid } from '../application/revisions.js';
import { createRepositories } from '../application/unit-of-work.js';
import type { JsonObject } from '../infrastructure/json.js';
import {
  addTaskDependency,
  cancelTask,
  editTaskPresentation,
  markTaskReady,
  removeTaskDependency,
  setTaskGoalAlignment,
  startHumanTask,
} from '../application/task-commands.js';
import { listTasks, readTaskById } from '../application/task-queries.js';
import { decodeTaskListCursor, encodeTaskListCursor } from './cursor.js';
import {
  AddTaskDependencyBodySchema,
  CancelTaskBodySchema,
  CancelTaskPendingResultSchema,
  CreateTaskBodySchema,
  CreateTaskResultSchema,
  EditTaskPresentationBodySchema,
  TaskCommandResultSchema,
  TaskDependencyBodySchema,
  TaskGoalAlignmentBodySchema,
  TaskGoalAlignmentResultSchema,
  TaskListSchema,
  TaskRevisionBodySchema,
  TaskSchema,
  TasksListQuerySchema,
  WorkspaceParamsSchema,
  WorkspaceTaskParamsSchema,
  commandEnvelopeSchema,
} from './domain-schemas.js';
import { createCommandHandler, sendReadError, type RouteDependencies } from './envelope.js';

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 100;

type TasksListQuery = Static<typeof TasksListQuerySchema>;

/**
 * Task 端点（docs/api/http-command-contract.md 第 3、6 节）。
 *
 * 状态迁移只走显式命令：INBOX → READY → IN_PROGRESS 与人工取消；PATCH 只能改展示字段，
 * 不能改 status / mode / 执行权 / 验收版本。
 */
export function registerTaskRoutes(app: FastifyInstance, dependencies: RouteDependencies): void {
  app.post(
    '/tasks',
    {
      schema: {
        params: WorkspaceParamsSchema,
        body: CreateTaskBodySchema,
        response: { 201: commandEnvelopeSchema(CreateTaskResultSchema) },
      },
    },
    createCommandHandler(dependencies, {
      commandType: 'CreateTask',
      bodySchema: CreateTaskBodySchema,
      execute: async ({ executor, body, params }) => {
        const outcome = await createTask(executor, {
          workspaceId: params.workspace_id ?? '',
          commandId: body.command_id,
          projectId: body.project_id ?? null,
          title: body.title,
          objective: body.objective,
          mode: body.mode ?? 'ME',
          expectedOutputs: (body.expected_outputs ?? {}) as JsonObject,
          criteria: (body.criteria ?? []).map((criterion) => ({
            criterionId: criterion.criterion_id,
            statement: criterion.statement,
            required: criterion.required,
            method: criterion.method,
            targetSpec: criterion.target_spec as JsonObject | undefined,
          })),
        });

        return { outcome, result: outcome.result };
      },
    }),
  );

  app.get(
    '/tasks',
    {
      schema: {
        params: WorkspaceParamsSchema,
        querystring: TasksListQuerySchema,
        response: { 200: TaskListSchema },
      },
    },
    async (request, reply) => {
      try {
        const params = request.params as { workspace_id: string };
        const query = request.query as TasksListQuery;
        const filter = resolveListFilter(query);
        const limit = resolveLimit(query.limit);

        await requireWorkspaceVisible(dependencies.database.executor, params.workspace_id);

        if (filter.projectId !== null) {
          // 过滤条件里的 Project 也必须在本作用域可见：不可见返回 404，而不是静默空列表。
          await readProjectInWorkspace(
            createRepositories(dependencies.database.executor),
            params.workspace_id,
            filter.projectId,
          );
        }

        const before =
          query.cursor === undefined ? null : decodeTaskListCursor(query.cursor, filter);
        const result = await listTasks(dependencies.database.executor, {
          workspaceId: params.workspace_id,
          projectId: filter.projectId,
          limit,
          before,
        });

        return reply.code(200).send({
          items: result.items,
          next_cursor:
            result.next_cursor === null
              ? null
              : encodeTaskListCursor({
                  filter,
                  createdAt: result.next_cursor.createdAt,
                  id: result.next_cursor.id,
                }),
        });
      } catch (error) {
        return sendReadError(reply, error, request.id);
      }
    },
  );

  app.get(
    '/tasks/:task_id',
    {
      schema: {
        params: WorkspaceTaskParamsSchema,
        response: { 200: TaskSchema },
      },
    },
    async (request, reply) => {
      try {
        return await readTaskResponse(dependencies, request);
      } catch (error) {
        return sendReadError(reply, error, request.id);
      }
    },
  );

  app.patch(
    '/tasks/:task_id',
    {
      schema: {
        params: WorkspaceTaskParamsSchema,
        body: EditTaskPresentationBodySchema,
        response: { 200: commandEnvelopeSchema(TaskCommandResultSchema) },
      },
    },
    createCommandHandler(dependencies, {
      commandType: 'EditTaskPresentation',
      bodySchema: EditTaskPresentationBodySchema,
      execute: async ({ executor, body, params }) => {
        const outcome = await editTaskPresentation(executor, {
          workspaceId: params.workspace_id ?? '',
          taskId: params.task_id ?? '',
          commandId: body.command_id,
          expectedRevision: body.expected_revision,
          title: body.title,
        });

        return { outcome, result: outcome.result };
      },
    }),
  );

  app.post(
    '/tasks/:task_id/ready',
    {
      schema: {
        params: WorkspaceTaskParamsSchema,
        body: TaskRevisionBodySchema,
        response: { 200: commandEnvelopeSchema(TaskCommandResultSchema) },
      },
    },
    createCommandHandler(dependencies, {
      commandType: 'MarkTaskReady',
      bodySchema: TaskRevisionBodySchema,
      execute: async ({ executor, body, params }) => {
        const outcome = await markTaskReady(executor, {
          workspaceId: params.workspace_id ?? '',
          taskId: params.task_id ?? '',
          commandId: body.command_id,
          expectedRevision: body.expected_revision,
        });

        return { outcome, result: outcome.result };
      },
    }),
  );

  app.post(
    '/tasks/:task_id/start',
    {
      schema: {
        params: WorkspaceTaskParamsSchema,
        body: TaskRevisionBodySchema,
        response: { 200: commandEnvelopeSchema(TaskCommandResultSchema) },
      },
    },
    createCommandHandler(dependencies, {
      commandType: 'StartHumanTask',
      bodySchema: TaskRevisionBodySchema,
      execute: async ({ executor, body, params }) => {
        const outcome = await startHumanTask(executor, {
          workspaceId: params.workspace_id ?? '',
          taskId: params.task_id ?? '',
          commandId: body.command_id,
          expectedRevision: body.expected_revision,
        });

        return { outcome, result: outcome.result };
      },
    }),
  );

  app.post(
    '/tasks/:task_id/cancel',
    {
      schema: {
        params: WorkspaceTaskParamsSchema,
        body: CancelTaskBodySchema,
        response: { 200: commandEnvelopeSchema(TaskCommandResultSchema),
          202: commandEnvelopeSchema(CancelTaskPendingResultSchema) },
      },
    },
    createCommandHandler(dependencies, {
      commandType: 'CancelTask',
      bodySchema: CancelTaskBodySchema,
      execute: async ({ executor, body, params, request }) => {
        const outcome = await cancelTask(executor, {
          workspaceId: params.workspace_id ?? '',
          taskId: params.task_id ?? '',
          commandId: body.command_id,
          expectedRevision: body.expected_task_revision,
          expectedRunRevision: body.expected_run_revision,
        });

        if ('control_request_id' in outcome.result) {
          try { await applySafeControl(executor, outcome.result.run_id); }
          catch (error) { request.log.error({ err: error }, 'task_cancel_safe_point_failed'); }
        }

        return { outcome, result: outcome.result };
      },
    }),
  );

  app.post(
    '/tasks/:task_id/goal-alignment',
    {
      schema: {
        params: WorkspaceTaskParamsSchema,
        body: TaskGoalAlignmentBodySchema,
        response: { 200: commandEnvelopeSchema(TaskGoalAlignmentResultSchema) },
      },
    },
    createCommandHandler(dependencies, {
      commandType: 'SetTaskGoalAlignment',
      bodySchema: TaskGoalAlignmentBodySchema,
      execute: async ({ executor, body, params }) => {
        const outcome = await setTaskGoalAlignment(executor, {
          workspaceId: params.workspace_id ?? '',
          taskId: params.task_id ?? '',
          commandId: body.command_id,
          expectedRevision: body.expected_revision,
          mode: body.mode,
          goalIds: body.goal_ids,
        });

        return { outcome, result: outcome.result };
      },
    }),
  );

  app.post(
    '/tasks/:task_id/dependency-links',
    {
      schema: {
        params: WorkspaceTaskParamsSchema,
        body: AddTaskDependencyBodySchema,
        response: { 200: commandEnvelopeSchema(TaskCommandResultSchema) },
      },
    },
    createCommandHandler(dependencies, {
      commandType: 'AddTaskDependency',
      bodySchema: AddTaskDependencyBodySchema,
      execute: async ({ executor, body, params }) => {
        const outcome = await addTaskDependency(executor, {
          workspaceId: params.workspace_id ?? '',
          taskId: params.task_id ?? '',
          commandId: body.command_id,
          expectedRevision: body.expected_revision,
          dependsOnTaskId: body.depends_on_task_id,
          dependencyKind: body.dependency_kind,
        });

        return { outcome, result: outcome.result };
      },
    }),
  );

  app.post(
    '/tasks/:task_id/dependency-unlinks',
    {
      schema: {
        params: WorkspaceTaskParamsSchema,
        body: TaskDependencyBodySchema,
        response: { 200: commandEnvelopeSchema(TaskCommandResultSchema) },
      },
    },
    createCommandHandler(dependencies, {
      commandType: 'RemoveTaskDependency',
      bodySchema: TaskDependencyBodySchema,
      execute: async ({ executor, body, params }) => {
        const outcome = await removeTaskDependency(executor, {
          workspaceId: params.workspace_id ?? '',
          taskId: params.task_id ?? '',
          commandId: body.command_id,
          expectedRevision: body.expected_revision,
          dependsOnTaskId: body.depends_on_task_id,
          dependencyKind: 'BLOCKS',
        });

        return { outcome, result: outcome.result };
      },
    }),
  );
}

async function readTaskResponse(
  dependencies: RouteDependencies,
  request: FastifyRequest,
): Promise<unknown> {
  const params = request.params as { workspace_id: string; task_id: string };

  await requireWorkspaceVisible(dependencies.database.executor, params.workspace_id);

  return readTaskById(dependencies.database.executor, params.workspace_id, params.task_id);
}

/**
 * 列表过滤条件必须显式给出 project_id 或 inbox=true，禁止含糊的空字符串
 * （docs/api/http-command-contract.md 第 3 节 ListTasks）。
 */
function resolveListFilter(query: TasksListQuery): { readonly projectId: string | null } {
  const rawProjectId = query.project_id;
  const hasProject = rawProjectId !== undefined;
  const inbox = query.inbox === 'true';

  if (hasProject && (rawProjectId ?? '').trim() === '') {
    throw validationFailed([
      {
        field: 'project_id',
        message: 'must be a UUID string; use inbox=true for tasks without a project',
      },
    ]);
  }

  if (!hasProject && !inbox) {
    throw requiredInputMissing([
      {
        field: 'project_id',
        message: 'provide project_id=<uuid> or inbox=true; an empty project_id is not allowed',
      },
    ]);
  }

  if (hasProject && query.inbox !== undefined) {
    throw validationFailed([{ field: 'inbox', message: 'must not be combined with project_id' }]);
  }

  if (hasProject && !isUuid(rawProjectId ?? '')) {
    throw validationFailed([{ field: 'project_id', message: 'must be a UUID string' }]);
  }

  return { projectId: hasProject ? (rawProjectId ?? null) : null };
}

function resolveLimit(raw: string | undefined): number {
  if (raw === undefined) {
    return DEFAULT_LIMIT;
  }

  const value = Number.parseInt(raw, 10);

  if (!Number.isSafeInteger(value) || value < 1 || value > MAX_LIMIT) {
    throw validationFailed([
      { field: 'limit', message: `must be an integer between 1 and ${MAX_LIMIT}` },
    ]);
  }

  return value;
}
