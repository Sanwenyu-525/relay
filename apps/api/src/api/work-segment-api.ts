import { Type } from '@sinclair/typebox';
import type { FastifyInstance } from 'fastify';
import { finishWorkSegment, listWorkSegments, proposeWorkSegmentEvent, readWorkSegment,
  resolveWorkSegmentEvent, startWorkSegment, temporaryRetrospective } from '../application/work-segments.js';
import { commandEnvelopeSchema } from './domain-schemas.js';
import { createCommandHandler, sendReadError, type RouteDependencies } from './envelope.js';

const strict = { additionalProperties: false } as const;
const uuid = Type.String({ format: 'uuid' });
const revision = Type.String({ pattern: '^[0-9]+$' });
const text = Type.String({ minLength: 1, maxLength: 4000 });
const params = Type.Object({ workspace_id: uuid, id: uuid }, strict);
const projectParams = Type.Object({ workspace_id: uuid, project_id: uuid }, strict);
const resultSchema = Type.Object({ segment_id: uuid, project_id: uuid, status: Type.String(), revision,
  event_id: Type.Optional(uuid), event_revision: Type.Optional(revision), event_status: Type.Optional(Type.String()) }, strict);
const response = { 200: commandEnvelopeSchema(resultSchema) };
const startBody = Type.Object({ command_id: uuid, confirmed: Type.Literal(true), title: Type.String({ minLength: 1, maxLength: 200 }), expectation: text,
  tasks: Type.Array(Type.Object({ task_id: uuid, expected_revision: revision, expected_acceptance_revision: revision }, strict), { minItems: 1, maxItems: 64 }) }, strict);
const finishBody = Type.Object({ command_id: uuid, expected_revision: revision }, strict);
const eventBody = Type.Object({ command_id: uuid, expected_revision: revision, kind: Type.Union([Type.Literal('REWORK'), Type.Literal('HUMAN_INTERVENTION')]),
  description: text, task_id: Type.Optional(uuid), source_run_id: Type.Optional(uuid), duration_ms: Type.Optional(Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER })) }, strict);
const resolveBody = Type.Object({ command_id: uuid, expected_revision: revision, action: Type.Union([Type.Literal('CONFIRM'), Type.Literal('WITHDRAW')]), reason: text }, strict);
export function registerWorkSegmentRoutes(app: FastifyInstance, dependencies: RouteDependencies): void {
  app.post('/projects/:project_id/work-segments', { schema: { params: projectParams, body: startBody, response } }, createCommandHandler(dependencies, {
    commandType: 'StartWorkSegment', bodySchema: startBody, execute: async ({ executor, params, body }) => {
      const outcome = await startWorkSegment(executor, { workspaceId: params.workspace_id ?? '', projectId: params.project_id ?? '',
        commandId: body.command_id, confirmed: body.confirmed, title: body.title, expectation: body.expectation,
        tasks: body.tasks.map((t) => ({ taskId: t.task_id, expectedRevision: t.expected_revision, expectedAcceptanceRevision: t.expected_acceptance_revision })) });
      return { outcome, result: outcome.result };
    } }));
  app.post('/work-segments/:id/finishes', { schema: { params, body: finishBody, response } }, createCommandHandler(dependencies, {
    commandType: 'FinishWorkSegment', bodySchema: finishBody, execute: async ({ executor, params, body }) => {
      const outcome = await finishWorkSegment(executor, { workspaceId: params.workspace_id ?? '', segmentId: params.id ?? '', commandId: body.command_id, expectedRevision: body.expected_revision });
      return { outcome, result: outcome.result };
    } }));
  app.post('/work-segments/:id/events', { schema: { params, body: eventBody, response } }, createCommandHandler(dependencies, {
    commandType: 'ProposeWorkSegmentEvent', bodySchema: eventBody, execute: async ({ executor, params, body }) => {
      const outcome = await proposeWorkSegmentEvent(executor, { workspaceId: params.workspace_id ?? '', segmentId: params.id ?? '',
        commandId: body.command_id, expectedRevision: body.expected_revision, kind: body.kind, description: body.description,
        ...(body.task_id === undefined ? {} : { taskId: body.task_id }), ...(body.source_run_id === undefined ? {} : { sourceRunId: body.source_run_id }),
        ...(body.duration_ms === undefined ? {} : { durationMs: body.duration_ms }) });
      return { outcome, result: outcome.result };
    } }));
  app.post('/work-segment-events/:id/resolutions', { schema: { params, body: resolveBody, response } }, createCommandHandler(dependencies, {
    commandType: 'ResolveWorkSegmentEvent', bodySchema: resolveBody, execute: async ({ executor, params, body }) => {
      const outcome = await resolveWorkSegmentEvent(executor, { workspaceId: params.workspace_id ?? '', eventId: params.id ?? '', commandId: body.command_id,
        expectedRevision: body.expected_revision, action: body.action, reason: body.reason });
      return { outcome, result: outcome.result };
    } }));
  app.get('/work-segments/:id', { schema: { params } }, async (request, reply) => {
    try {
      const ids = request.params as { workspace_id: string; id: string };
      return await readWorkSegment(dependencies.database.executor, ids.workspace_id, ids.id);
    } catch (error) { return sendReadError(reply, error, request.id); }
  });
  app.get('/projects/:project_id/work-segments', { schema: { params: projectParams } }, async (request, reply) => {
    try {
      const ids = request.params as { workspace_id: string; project_id: string };
      return await listWorkSegments(dependencies.database.executor, ids.workspace_id, ids.project_id);
    } catch (error) { return sendReadError(reply, error, request.id); }
  });
  app.post('/projects/:project_id/retrospectives', { schema: { params: projectParams, body: Type.Object({ task_ids: Type.Array(uuid, { minItems: 1, maxItems: 64, uniqueItems: true }) }, strict) } }, async (request, reply) => {
    try {
      const ids = request.params as { workspace_id: string; project_id: string };
      const body = request.body as { task_ids: string[] };
      return await temporaryRetrospective(dependencies.database.executor, ids.workspace_id, ids.project_id, body.task_ids);
    } catch (error) { return sendReadError(reply, error, request.id); }
  });
}
