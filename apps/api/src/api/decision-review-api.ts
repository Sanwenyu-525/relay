import { Type } from '@sinclair/typebox';
import type { FastifyInstance } from 'fastify';
import { listDecisionPremises, listDecisionReviews, registerDecisionPremise, resolveDecisionReview } from '../application/decision-reviews.js';
import { commandEnvelopeSchema } from './domain-schemas.js';
import { createCommandHandler, sendReadError, type RouteDependencies } from './envelope.js';

const strict = { additionalProperties: false } as const;
const uuid = Type.String({ format: 'uuid' });
const revision = Type.String({ pattern: '^[0-9]+$' });
const params = Type.Object({ workspace_id: uuid, id: uuid }, strict);
const registerBody = Type.Object({ command_id: uuid, expected_decision_revision: revision, confirmed: Type.Literal(true),
  statement: Type.String({ minLength: 1, maxLength: 4000 }), knowledge_version_id: Type.Optional(uuid), hypothesis_id: Type.Optional(uuid),
  expected_hypothesis_revision: Type.Optional(revision) }, strict);
const resolveBody = Type.Object({ command_id: uuid, expected_revision: revision,
  action: Type.Union([Type.Literal('KEEP_DECISION'), Type.Literal('DISMISS')]), reason: Type.String({ minLength: 1, maxLength: 4000 }) }, strict);
export function registerDecisionReviewRoutes(app: FastifyInstance, dependencies: RouteDependencies): void {
  app.post('/decisions/:id/premises', { schema: { params, body: registerBody, response: { 200: commandEnvelopeSchema(
    Type.Object({ premise_id: uuid, decision_id: uuid, project_id: uuid, revision }, strict)) } } },
  createCommandHandler(dependencies, { commandType: 'RegisterDecisionPremise', bodySchema: registerBody,
    execute: async ({ executor, params, body }) => {
      const result = await registerDecisionPremise(executor, { workspaceId: params.workspace_id ?? '', decisionId: params.id ?? '',
        commandId: body.command_id, expectedDecisionRevision: body.expected_decision_revision, confirmed: body.confirmed, statement: body.statement,
        ...(body.knowledge_version_id === undefined ? {} : { knowledgeVersionId: body.knowledge_version_id }),
        ...(body.hypothesis_id === undefined ? {} : { hypothesisId: body.hypothesis_id }),
        ...(body.expected_hypothesis_revision === undefined ? {} : { expectedHypothesisRevision: body.expected_hypothesis_revision }) });
      return { outcome: result, result: result.result };
    } }));
  app.get('/decisions/:id/premises', { schema: { params } }, async (request, reply) => {
    try {
      const ids = request.params as { workspace_id: string; id: string };
      return await listDecisionPremises(dependencies.database.executor, ids.workspace_id, ids.id);
    } catch (error) { return sendReadError(reply, error, request.id); }
  });
  app.get('/projects/:project_id/decision-reviews', { schema: { params: Type.Object({ workspace_id: uuid, project_id: uuid }, strict) } }, async (request, reply) => {
    try {
      const ids = request.params as { workspace_id: string; project_id: string };
      return await listDecisionReviews(dependencies.database.executor, ids.workspace_id, ids.project_id);
    } catch (error) { return sendReadError(reply, error, request.id); }
  });
  app.post('/decision-reviews/:id/resolutions', { schema: { params, body: resolveBody, response: { 200: commandEnvelopeSchema(
    Type.Object({ candidate_id: uuid, project_id: uuid, status: Type.String(), revision }, strict)) } } },
  createCommandHandler(dependencies, { commandType: 'ResolveDecisionReview', bodySchema: resolveBody,
    execute: async ({ executor, params, body }) => {
      const result = await resolveDecisionReview(executor, { workspaceId: params.workspace_id ?? '', candidateId: params.id ?? '',
        commandId: body.command_id, expectedRevision: body.expected_revision, action: body.action, reason: body.reason });
      return { outcome: result, result: result.result };
    } }));
}
