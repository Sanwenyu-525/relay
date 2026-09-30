import { Type } from '@sinclair/typebox';
import type { FastifyInstance } from 'fastify';

import {
  captureProjectContinuationPoint,
  compareProjectToContinuationPoint,
  listProjectContinuationPoints,
  readProjectContinuationPoint,
} from '../application/project-continuation-points.js';
import {
  UuidSchema,
  WorkspaceContinuationPointParamsSchema,
  WorkspaceProjectParamsSchema,
  commandEnvelopeSchema,
} from './domain-schemas.js';
import { createCommandHandler, sendReadError, type RouteDependencies } from './envelope.js';

const strict = { additionalProperties: false } as const;
const nullableId = Type.Union([UuidSchema, Type.Null()]);
const revision = Type.String({ pattern: '^(0|[1-9][0-9]*)$' });
const taskStatus = Type.Union(['INBOX', 'READY', 'IN_PROGRESS', 'WAITING', 'BLOCKED',
  'DONE', 'CANCELLED'].map((value) => Type.Literal(value)));
const refKind = Type.Union([Type.Literal('TASK'), Type.Literal('ARTIFACT_VERSION')]);
const change = Type.Union(['UNCHANGED', 'REVISED', 'CLOSED', 'MISSING', 'CURRENT', 'SUPERSEDED']
  .map((value) => Type.Literal(value)));

const capturedState = Type.Object({ phase_key: Type.String(), revision,
  next_action_task_id: nullableId }, strict);
const summary = Type.Object({ id: UuidSchema, project_id: UuidSchema, name: Type.String(),
  note: Type.Union([Type.String(), Type.Null()]), captured_at: Type.String(),
  captured_state: capturedState, ref_count: Type.Integer() }, strict);
const ref = Type.Object({ ref_kind: refKind, ref_id: UuidSchema, captured_revision: revision },
  strict);
const point = Type.Object({ ...summary.properties, refs: Type.Array(ref) }, strict);
const summaryList = Type.Object({ items: Type.Array(summary) }, strict);
const comparison = Type.Object({
  continuation_point: summary,
  current_state: capturedState,
  facts: Type.Object({
    state_revision_changed: Type.Boolean(), phase_changed: Type.Boolean(),
    next_action_changed: Type.Boolean(),
    task_added: Type.Array(Type.Object({ task_id: UuidSchema, title: Type.String(),
      status: taskStatus }, strict)),
    artifact_version_added: Type.Array(Type.Object({ artifact_version_id: UuidSchema,
      artifact_id: UuidSchema, version_number: revision }, strict)),
  }, strict),
  ref_changes: Type.Array(Type.Object({ ...ref.properties, change,
    current_revision: Type.Union([revision, Type.Null()]),
    note: Type.Union([Type.String(), Type.Null()]) }, strict)),
  interpretation: Type.Null(),
}, strict);
const captureBody = Type.Object({ command_id: UuidSchema, name: Type.String({ minLength: 1,
  maxLength: 120 }), note: Type.Union([Type.String({ minLength: 1, maxLength: 2000 }),
  Type.Null()]) }, strict);

export function registerProjectContinuationRoutes(app: FastifyInstance,
  dependencies: RouteDependencies): void {
  app.get('/projects/:project_id/continuation-points', {
    schema: { params: WorkspaceProjectParamsSchema, response: { 200: summaryList } },
  }, async (request, reply) => {
    try {
      const params = request.params as { workspace_id: string; project_id: string };
      return { items: await listProjectContinuationPoints(dependencies.database.executor,
        { workspaceId: params.workspace_id, projectId: params.project_id }) };
    } catch (error) { return sendReadError(reply, error, request.id); }
  });

  app.post('/projects/:project_id/continuation-points', {
    schema: { params: WorkspaceProjectParamsSchema, body: captureBody,
      response: { 201: commandEnvelopeSchema(point) } },
  }, createCommandHandler(dependencies, { commandType: 'CreateProjectContinuationPoint',
    bodySchema: captureBody,
    execute: async ({ executor, body, params }) => {
      const outcome = await captureProjectContinuationPoint(executor, {
        workspaceId: params.workspace_id ?? '', projectId: params.project_id ?? '',
        commandId: body.command_id, name: body.name, note: body.note });
      return { outcome, result: outcome.result };
    } }));

  app.get('/projects/:project_id/continuation-points/:continuation_point_id', {
    schema: { params: WorkspaceContinuationPointParamsSchema, response: { 200: point } },
  }, async (request, reply) => {
    try {
      const params = request.params as { workspace_id: string; project_id: string;
        continuation_point_id: string };
      return await readProjectContinuationPoint(dependencies.database.executor,
        { workspaceId: params.workspace_id, projectId: params.project_id,
          continuationPointId: params.continuation_point_id });
    } catch (error) { return sendReadError(reply, error, request.id); }
  });

  app.get('/projects/:project_id/continuation-points/:continuation_point_id/comparison', {
    schema: { params: WorkspaceContinuationPointParamsSchema, response: { 200: comparison } },
  }, async (request, reply) => {
    try {
      const params = request.params as { workspace_id: string; project_id: string;
        continuation_point_id: string };
      return await compareProjectToContinuationPoint(dependencies.database.executor,
        { workspaceId: params.workspace_id, projectId: params.project_id,
          continuationPointId: params.continuation_point_id });
    } catch (error) { return sendReadError(reply, error, request.id); }
  });
}
