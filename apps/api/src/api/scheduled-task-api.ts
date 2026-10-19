import { Type } from '@sinclair/typebox';
import type { FastifyInstance } from 'fastify';
import {
  createScheduledTask, editScheduledTask, listScheduledTasks, readScheduledTask,
  resolveScheduledTaskOccurrence, setScheduledTaskStatus,
} from '../application/scheduled-tasks.js';
import type { TaskChainExecutionInput } from '../application/task-chain-execution.js';
import { commandEnvelopeSchema, OpenObjectSchema } from './domain-schemas.js';
import { createCommandHandler, sendReadError, type RouteDependencies } from './envelope.js';
import { execution as executionSchema } from './task-chain-api.js';

const strict = { additionalProperties: false } as const;
const uuid = Type.String({ format: 'uuid' });
const revision = Type.String({ pattern: '^[0-9]+$' });
const params = Type.Object({ workspace_id: uuid, id: uuid }, strict);
const workspaceParams = Type.Object({ workspace_id: uuid }, strict);
const projectParams = Type.Object({ workspace_id: uuid, project_id: uuid }, strict);
const title = Type.String({ minLength: 1, maxLength: 200 });
const reason = Type.String({ minLength: 1, maxLength: 4000 });

const criterion = Type.Object({
  criterion_id: Type.Optional(Type.String({ maxLength: 64 })),
  statement: Type.String({ minLength: 1, maxLength: 500 }),
  required: Type.Optional(Type.Boolean()),
  method: Type.Optional(Type.String({ maxLength: 32 })),
  target_spec: Type.Optional(OpenObjectSchema),
}, strict);

/** 任务模板：与 CreateTask 的入参同形，创建时即按同一口径校验。 */
const template = Type.Object({
  task_title: Type.String({ minLength: 1, maxLength: 200 }),
  objective: Type.String({ minLength: 1, maxLength: 2000 }),
  mode: Type.Optional(Type.Union([Type.Literal('ME'), Type.Literal('AI_ASSIST'), Type.Literal('DELEGATE_AI')])),
  expected_outputs: Type.Optional(OpenObjectSchema),
  criteria: Type.Optional(Type.Array(criterion, { maxItems: 20 })),
}, strict);

/** 只支持「每 N 天」与「每周指定星期几」两种规则；cron 表达式不在本片范围。 */
const repeatRule = Type.Union([
  Type.Object({ kind: Type.Literal('DAILY'), interval_days: Type.Integer({ minimum: 1, maximum: 30 }) }, strict),
  Type.Object({ kind: Type.Literal('WEEKLY'), weekdays: Type.Array(Type.Integer({ minimum: 1, maximum: 7 }), { minItems: 1, maxItems: 7 }) }, strict),
]);

const scheduleFields = {
  title,
  template,
  repeat_rule: repeatRule,
  timezone: Type.String({ minLength: 1, maxLength: 100 }),
  local_time: Type.String({ pattern: '^([01][0-9]|2[0-3]):[0-5][0-9]$' }),
  first_local_date: Type.String({ pattern: '^\\d{4}-\\d{2}-\\d{2}$' }),
  max_runs: Type.Integer({ minimum: 1, maximum: 100 }),
  authorization_expires_at: Type.String({ format: 'date-time' }),
  execution: Type.Optional(executionSchema),
};

const createBody = Type.Object({ command_id: uuid, confirmed: Type.Literal(true), ...scheduleFields }, strict);
const editBody = Type.Object({ command_id: uuid, expected_revision: revision, confirmed: Type.Literal(true), ...scheduleFields, reason }, strict);
const statusBody = Type.Object({
  command_id: uuid, expected_revision: revision, reason,
  status: Type.Union([Type.Literal('ENABLED'), Type.Literal('PAUSED'), Type.Literal('DISABLED')]),
}, strict);
const resolveBody = Type.Object({
  command_id: uuid, expected_revision: revision, reason,
  action: Type.Union([Type.Literal('RETRY'), Type.Literal('DISMISS')]),
}, strict);

const result = Type.Object({
  scheduled_task_id: uuid, project_id: uuid, status: Type.String(), revision,
  schedule_generation: revision, next_due_at: Type.Union([Type.String(), Type.Null()]),
}, strict);

export function registerScheduledTaskRoutes(app: FastifyInstance, d: RouteDependencies): void {
  app.post('/projects/:project_id/scheduled-tasks', { schema: { params: projectParams, body: createBody, response: { 201: commandEnvelopeSchema(result) } } }, createCommandHandler(d, {
    commandType: 'CreateScheduledTask', bodySchema: createBody, execute: async ({ executor, params, body }) => {
      const outcome = await createScheduledTask(executor, {
        workspaceId: params.workspace_id ?? '', projectId: params.project_id ?? '', commandId: body.command_id,
        title: body.title, template: { ...body.template, mode: body.template.mode ?? 'ME', expected_outputs: body.template.expected_outputs ?? {}, criteria: body.template.criteria ?? [] },
        repeat: body.repeat_rule, timezone: body.timezone, localTime: body.local_time, firstLocalDate: body.first_local_date,
        maxRuns: body.max_runs, authorizationExpiresAt: body.authorization_expires_at, confirmed: body.confirmed,
        execution: body.execution as TaskChainExecutionInput | undefined,
      });
      return { outcome, result: outcome.result };
    },
  }));

  app.post('/scheduled-tasks/:id/edits', { schema: { params, body: editBody, response: { 200: commandEnvelopeSchema(result) } } }, createCommandHandler(d, {
    commandType: 'EditScheduledTask', bodySchema: editBody, execute: async ({ executor, params, body }) => {
      const outcome = await editScheduledTask(executor, {
        workspaceId: params.workspace_id ?? '', scheduledTaskId: params.id ?? '', commandId: body.command_id,
        expectedRevision: body.expected_revision, title: body.title,
        template: { ...body.template, mode: body.template.mode ?? 'ME', expected_outputs: body.template.expected_outputs ?? {}, criteria: body.template.criteria ?? [] },
        repeat: body.repeat_rule, timezone: body.timezone, localTime: body.local_time, firstLocalDate: body.first_local_date,
        maxRuns: body.max_runs, authorizationExpiresAt: body.authorization_expires_at, confirmed: body.confirmed,
        execution: body.execution as TaskChainExecutionInput | undefined, reason: body.reason,
      });
      return { outcome, result: outcome.result };
    },
  }));

  app.post('/scheduled-tasks/:id/status-changes', { schema: { params, body: statusBody, response: { 200: commandEnvelopeSchema(result) } } }, createCommandHandler(d, {
    commandType: 'SetScheduledTaskStatus', bodySchema: statusBody, execute: async ({ executor, params, body }) => {
      const outcome = await setScheduledTaskStatus(executor, {
        workspaceId: params.workspace_id ?? '', scheduledTaskId: params.id ?? '', commandId: body.command_id,
        expectedRevision: body.expected_revision, status: body.status, reason: body.reason,
      });
      return { outcome, result: outcome.result };
    },
  }));

  app.post('/scheduled-task-occurrences/:id/resolutions', {
    schema: { params, body: resolveBody, response: { 200: commandEnvelopeSchema(Type.Object({ occurrence_id: uuid, scheduled_task_id: uuid, status: Type.String(), revision }, strict)) } },
  }, createCommandHandler(d, {
    commandType: 'ResolveScheduledTaskOccurrence', bodySchema: resolveBody, execute: async ({ executor, params, body }) => {
      const outcome = await resolveScheduledTaskOccurrence(executor, {
        workspaceId: params.workspace_id ?? '', occurrenceId: params.id ?? '', commandId: body.command_id,
        expectedRevision: body.expected_revision, action: body.action, reason: body.reason,
      });
      return { outcome, result: outcome.result };
    },
  }));

  app.get('/scheduled-tasks', { schema: { params: workspaceParams, querystring: Type.Object({ project_id: Type.Optional(uuid) }, strict) } }, async (request, reply) => {
    try {
      const p = request.params as { workspace_id: string };
      const q = request.query as { project_id?: string };
      return await listScheduledTasks(d.database.executor, p.workspace_id, q.project_id);
    } catch (error) { return sendReadError(reply, error, request.id); }
  });

  app.get('/scheduled-tasks/:id', { schema: { params } }, async (request, reply) => {
    try {
      const p = request.params as { workspace_id: string; id: string };
      return await readScheduledTask(d.database.executor, p.workspace_id, p.id);
    } catch (error) { return sendReadError(reply, error, request.id); }
  });
}
