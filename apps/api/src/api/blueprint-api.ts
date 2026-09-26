import { Type } from '@sinclair/typebox';
import type { FastifyInstance } from 'fastify';

import { applyBlueprintProposal, rejectBlueprintProposal }
  from '../application/blueprint-apply.js';
import { createBlueprintProposal, listBlueprintProposals,
  readBlueprintProposal } from '../application/blueprint-proposals.js';
import { commandEnvelopeSchema, OpenObjectSchema,
  WorkspaceProjectParamsSchema } from './domain-schemas.js';
import { createCommandHandler, sendReadError, type RouteDependencies }
  from './envelope.js';

const strict = { additionalProperties: false } as const;
const uuid = Type.String({ format: 'uuid' });
const revision = Type.String({ pattern: '^(0|[1-9][0-9]*)$' });
const sha256 = Type.String({ pattern: '^[0-9a-f]{64}$' });
const nullableUuid = Type.Union([uuid, Type.Null()]);
const kind = Type.Union([Type.Literal('general'), Type.Literal('thesis'),
  Type.Literal('development')]);
const proposalParams = Type.Object({ workspace_id: uuid, project_id: uuid,
  proposal_id: uuid }, strict);
const nextAction = Type.Union([
  Type.Object({ kind: Type.Literal('NEW_TASK'), local_key: Type.String() }, strict),
  Type.Object({ kind: Type.Literal('EXISTING_TASK'), task_id: uuid }, strict),
  Type.Object({ kind: Type.Literal('CLEAR') }, strict), Type.Null(),
]);
const draft = Type.Object({
  intent: Type.String({ minLength: 1, maxLength: 2_000 }),
  goal_id: nullableUuid,
  phase_key: Type.Union([Type.String(), Type.Null()]),
  tasks: Type.Array(Type.Object({ local_key: Type.String(),
    title: Type.String(), objective: Type.String() }, strict), { maxItems: 5 }),
  next_action: nextAction,
  view_kind: kind,
  pack_ref: Type.Union([Type.Object({ id: Type.String(),
    version: Type.String() }, strict), Type.Null()]),
}, strict);
const createBody = Type.Object({ command_id: uuid,
  expected_project_revision: revision, expected_state_revision: revision,
  expected_view_revision: revision, draft,
  supersedes_proposal_id: Type.Optional(nullableUuid) }, strict);
const applyBody = Type.Object({ command_id: uuid, candidate_sha256: sha256,
  expected_project_revision: revision, expected_state_revision: revision,
  expected_view_revision: revision }, strict);
const rejectBody = Type.Object({ command_id: uuid,
  candidate_sha256: sha256 }, strict);

export function registerBlueprintRoutes(app: FastifyInstance,
  dependencies: RouteDependencies): void {
  app.get('/projects/:project_id/blueprint-proposals', {
    schema: { params: WorkspaceProjectParamsSchema,
      response: { 200: OpenObjectSchema } },
  }, async (request, reply) => {
    try {
      const params = request.params as { workspace_id: string; project_id: string };
      return await listBlueprintProposals(dependencies.database.executor, {
        workspaceId: params.workspace_id, projectId: params.project_id });
    } catch (error) { return sendReadError(reply, error, request.id); }
  });
  app.get('/projects/:project_id/blueprint-proposals/:proposal_id', {
    schema: { params: proposalParams, response: { 200: OpenObjectSchema } },
  }, async (request, reply) => {
    try {
      const params = request.params as { workspace_id: string; project_id: string;
        proposal_id: string };
      return await readBlueprintProposal(dependencies.database.executor, {
        workspaceId: params.workspace_id, projectId: params.project_id,
        proposalId: params.proposal_id });
    } catch (error) { return sendReadError(reply, error, request.id); }
  });
  app.post('/projects/:project_id/blueprint-proposals', {
    schema: { params: WorkspaceProjectParamsSchema, body: createBody,
      response: { 201: commandEnvelopeSchema(OpenObjectSchema) } },
  }, createCommandHandler(dependencies, { commandType: 'CreateProjectBlueprintProposal',
    bodySchema: createBody, execute: async ({ executor, params, body }) => {
      const outcome = await createBlueprintProposal(executor, {
        workspaceId: params.workspace_id ?? '', projectId: params.project_id ?? '',
        commandId: body.command_id,
        expectedProjectRevision: body.expected_project_revision,
        expectedStateRevision: body.expected_state_revision,
        expectedViewRevision: body.expected_view_revision,
        draft: body.draft, supersedesProposalId: body.supersedes_proposal_id ?? null,
      });
      return { outcome, result: outcome.result };
    } }));
  app.post('/projects/:project_id/blueprint-proposals/:proposal_id/apply', {
    schema: { params: proposalParams, body: applyBody,
      response: { 200: commandEnvelopeSchema(OpenObjectSchema) } },
  }, createCommandHandler(dependencies, { commandType: 'ApplyProjectBlueprint',
    bodySchema: applyBody, execute: async ({ executor, params, body }) => {
      const outcome = await applyBlueprintProposal(executor, {
        workspaceId: params.workspace_id ?? '', projectId: params.project_id ?? '',
        proposalId: params.proposal_id ?? '', commandId: body.command_id,
        candidateSha256: body.candidate_sha256,
        storage: dependencies.storage,
        expectedProjectRevision: body.expected_project_revision,
        expectedStateRevision: body.expected_state_revision,
        expectedViewRevision: body.expected_view_revision,
      });
      return { outcome, result: outcome.result };
    } }));
  app.post('/projects/:project_id/blueprint-proposals/:proposal_id/reject', {
    schema: { params: proposalParams, body: rejectBody,
      response: { 200: commandEnvelopeSchema(OpenObjectSchema) } },
  }, createCommandHandler(dependencies, { commandType: 'RejectProjectBlueprint',
    bodySchema: rejectBody, execute: async ({ executor, params, body }) => {
      const outcome = await rejectBlueprintProposal(executor, {
        workspaceId: params.workspace_id ?? '', projectId: params.project_id ?? '',
        proposalId: params.proposal_id ?? '', commandId: body.command_id,
        candidateSha256: body.candidate_sha256,
      });
      return { outcome, result: outcome.result };
    } }));
}
