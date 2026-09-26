import { Type } from '@sinclair/typebox';
import type { FastifyInstance } from 'fastify';

import { setFocusSelection, setTaskSelection } from '../application/today-commands.js';
import { readToday } from '../application/today-queries.js';
import { commandEnvelopeSchema, DecimalSchema, UuidSchema } from './domain-schemas.js';
import { createCommandHandler, sendReadError, type RouteDependencies } from './envelope.js';

const strict = { additionalProperties: false } as const;
const date = Type.String({ pattern: '^\\d{4}-\\d{2}-\\d{2}$' });
const timezone = Type.String({ minLength: 1, maxLength: 100 });
const optionalDate = Type.Union([date, Type.Null()]);
const optionalTimezone = Type.Union([timezone, Type.Null()]);
const workspace = Type.Object({ workspace_id: UuidSchema }, strict);
const task = Type.Object({ workspace_id: UuidSchema, task_id: UuidSchema }, strict);
const query = Type.Object({ date, timezone }, strict);
const selectionResult = Type.Object({ selection_revision: DecimalSchema }, strict);
const taskSelectionBody = Type.Object({ command_id: UuidSchema,
  expected_revision: DecimalSchema, pin: Type.Boolean(),
  later_local_date: optionalDate, timezone: optionalTimezone }, strict);
const focusBody = Type.Object({ command_id: UuidSchema, expected_revision: DecimalSchema,
  date, timezone,
  target_kind: Type.Union([Type.Literal('GOAL'), Type.Literal('PROJECT'),
    Type.Literal('TASK'), Type.Null()]),
  target_id: Type.Union([UuidSchema, Type.Null()]) }, strict);
const todayItem = Type.Object({
  task_id: UuidSchema, task_revision: DecimalSchema,
  project_id: Type.Union([UuidSchema, Type.Null()]), title: Type.String(),
  status: Type.String(), priority: Type.Union([Type.Literal('LOW'),
    Type.Literal('NORMAL'), Type.Literal('HIGH'), Type.Null()]),
  due_local_date: optionalDate, timezone: optionalTimezone,
  pin: Type.Boolean(), later_local_date: optionalDate, later_timezone: optionalTimezone,
  reason_codes: Type.Array(Type.String()), evidence_refs: Type.Array(Type.String()),
  allowed_actions: Type.Array(Type.String()),
}, strict);
const focus = Type.Object({ date, timezone,
  target_kind: Type.Union([Type.Literal('GOAL'), Type.Literal('PROJECT'), Type.Literal('TASK')]),
  target_id: UuidSchema, selection_revision: DecimalSchema, active_in_query: Type.Boolean() }, strict);
const todayResponse = Type.Object({ date, timezone, selection_revision: DecimalSchema,
  focus: Type.Union([focus, Type.Null()]), focus_has_eligible_candidate: Type.Boolean(),
  eligible_items: Type.Array(todayItem), waiting_items: Type.Array(todayItem),
  blocked_pinned_items: Type.Array(todayItem) }, strict);

export function registerTodayRoutes(app: FastifyInstance, dependencies: RouteDependencies): void {
  app.get('/today', { schema: { params: workspace, querystring: query,
    response: { 200: todayResponse } } }, async (request, reply) => {
    try {
      const params = request.params as { workspace_id: string };
      const q = request.query as { date: string; timezone: string };
      return await readToday(dependencies.database.executor, {
        workspaceId: params.workspace_id, date: q.date, timezone: q.timezone });
    } catch (error) { return sendReadError(reply, error, request.id); }
  });
  app.post('/task-selections/:task_id', {
    schema: { params: task, body: taskSelectionBody,
      response: { 200: commandEnvelopeSchema(selectionResult) } },
  }, createCommandHandler(dependencies, { commandType: 'SetTaskSelection',
    bodySchema: taskSelectionBody,
    execute: async ({ executor, body, params }) => {
      const outcome = await setTaskSelection(executor, { workspaceId: params.workspace_id ?? '',
        taskId: params.task_id ?? '', commandId: body.command_id,
        expectedRevision: body.expected_revision, pin: body.pin,
        laterLocalDate: body.later_local_date, timezone: body.timezone });
      return { outcome, result: outcome.result };
    },
  }));
  app.post('/focus-selections', {
    schema: { params: workspace, body: focusBody,
      response: { 200: commandEnvelopeSchema(selectionResult) } },
  }, createCommandHandler(dependencies, { commandType: 'SetFocusSelection',
    bodySchema: focusBody,
    execute: async ({ executor, body, params }) => {
      const outcome = await setFocusSelection(executor, { workspaceId: params.workspace_id ?? '',
        commandId: body.command_id, expectedRevision: body.expected_revision,
        date: body.date, timezone: body.timezone,
        targetKind: body.target_kind, targetId: body.target_id });
      return { outcome, result: outcome.result };
    },
  }));
}
