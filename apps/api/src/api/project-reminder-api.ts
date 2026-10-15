import { Type } from '@sinclair/typebox';
import type { FastifyInstance } from 'fastify';
import { claimReminderNotifications, createProjectReminder, editProjectReminder, listProjectReminders, listReminderOccurrences,
  readProjectReminder, readReminderOccurrence, resolveReminderOccurrence, setProjectReminderStatus } from '../application/project-reminders.js';
import { commandEnvelopeSchema } from './domain-schemas.js';
import { createCommandHandler, sendReadError, type RouteDependencies } from './envelope.js';
const strict = { additionalProperties: false } as const;
const uuid = Type.String({ format: 'uuid' }); const revision = Type.String({ pattern: '^[0-9]+$' });
const params = Type.Object({ workspace_id: uuid, id: uuid }, strict); const workspaceParams = Type.Object({ workspace_id: uuid }, strict);
const projectParams = Type.Object({ workspace_id: uuid, project_id: uuid }, strict);
const title = Type.String({ minLength: 1, maxLength: 200 }); const reason = Type.String({ minLength: 1, maxLength: 4000 });
const time = { due_at: Type.String({ format: 'date-time' }), timezone: Type.String({ minLength: 1, maxLength: 100 }) };
const status = Type.Union([Type.Literal('ENABLED'), Type.Literal('PAUSED'), Type.Literal('DISABLED')]);
const result = Type.Object({ reminder_id: uuid, project_id: uuid, revision, status, schedule_generation: revision }, strict);
const createBody = Type.Object({ command_id: uuid, confirmed: Type.Literal(true), title, ...time }, strict);
const editBody = Type.Object({ command_id: uuid, expected_revision: revision, confirmed: Type.Literal(true), title, ...time, reason }, strict);
const statusBody = Type.Object({ command_id: uuid, expected_revision: revision, status, reason }, strict);
const resolveBody = Type.Object({ command_id: uuid, expected_revision: revision, action: Type.Union([Type.Literal('HANDLE'), Type.Literal('DISMISS')]), reason }, strict);
export function registerProjectReminderRoutes(app: FastifyInstance, d: RouteDependencies): void {
  app.post('/projects/:project_id/reminders', { schema: { params: projectParams, body: createBody, response: { 201: commandEnvelopeSchema(result) } } }, createCommandHandler(d, {
    commandType: 'CreateProjectReminder', bodySchema: createBody, execute: async ({ executor, params, body }) => {
      const outcome = await createProjectReminder(executor, { workspaceId: params.workspace_id ?? '', projectId: params.project_id ?? '', commandId: body.command_id,
        confirmed: body.confirmed, title: body.title, dueAt: body.due_at, timezone: body.timezone }); return { outcome, result: outcome.result };
    } }));
  app.post('/project-reminders/:id/edits', { schema: { params, body: editBody, response: { 200: commandEnvelopeSchema(result) } } }, createCommandHandler(d, {
    commandType: 'EditProjectReminder', bodySchema: editBody, execute: async ({ executor, params, body }) => {
      const outcome = await editProjectReminder(executor, { workspaceId: params.workspace_id ?? '', reminderId: params.id ?? '', commandId: body.command_id, expectedRevision: body.expected_revision,
        confirmed: body.confirmed, title: body.title, dueAt: body.due_at, timezone: body.timezone, reason: body.reason }); return { outcome, result: outcome.result };
    } }));
  app.post('/project-reminders/:id/status-changes', { schema: { params, body: statusBody, response: { 200: commandEnvelopeSchema(result) } } }, createCommandHandler(d, {
    commandType: 'SetProjectReminderStatus', bodySchema: statusBody, execute: async ({ executor, params, body }) => {
      const outcome = await setProjectReminderStatus(executor, { workspaceId: params.workspace_id ?? '', reminderId: params.id ?? '', commandId: body.command_id,
        expectedRevision: body.expected_revision, status: body.status, reason: body.reason }); return { outcome, result: outcome.result };
    } }));
  app.post('/reminder-occurrences/:id/resolutions', { schema: { params, body: resolveBody, response: { 200: commandEnvelopeSchema(Type.Object({ occurrence_id: uuid, project_id: uuid, status: Type.String(), revision }, strict)) } } }, createCommandHandler(d, {
    commandType: 'ResolveReminderOccurrence', bodySchema: resolveBody, execute: async ({ executor, params, body }) => {
      const outcome = await resolveReminderOccurrence(executor, { workspaceId: params.workspace_id ?? '', occurrenceId: params.id ?? '', commandId: body.command_id,
        expectedRevision: body.expected_revision, action: body.action, reason: body.reason }); return { outcome, result: outcome.result };
    } }));
  app.get('/projects/:project_id/reminders', { schema: { params: projectParams } }, async (request, reply) => {
    try { const p = request.params as { workspace_id: string; project_id: string }; return await listProjectReminders(d.database.executor, p.workspace_id, p.project_id); } catch (e) { return sendReadError(reply, e, request.id); }
  });
  app.get('/project-reminders/:id', { schema: { params } }, async (request, reply) => {
    try { const p = request.params as { workspace_id: string; id: string }; return await readProjectReminder(d.database.executor, p.workspace_id, p.id); } catch (e) { return sendReadError(reply, e, request.id); }
  });
  app.get('/reminder-occurrences', { schema: { params: workspaceParams, querystring: Type.Object({ project_id: Type.Optional(uuid) }, strict) } }, async (request, reply) => {
    try { const p = request.params as { workspace_id: string }; const q = request.query as { project_id?: string }; return await listReminderOccurrences(d.database.executor, p.workspace_id, q.project_id); } catch (e) { return sendReadError(reply, e, request.id); }
  });
  app.get('/reminder-occurrences/:id', { schema: { params } }, async (request, reply) => {
    try { const p = request.params as { workspace_id: string; id: string }; return await readReminderOccurrence(d.database.executor, p.workspace_id, p.id); } catch (e) { return sendReadError(reply, e, request.id); }
  });
  app.post('/project-reminders/notifications/claim', { schema: { params: workspaceParams } }, async (request, reply) => {
    try { const p = request.params as { workspace_id: string }; return await claimReminderNotifications(d.database.executor, p.workspace_id); } catch (e) { return sendReadError(reply, e, request.id); }
  });
}
