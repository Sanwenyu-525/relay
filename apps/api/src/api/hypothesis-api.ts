import { Type } from '@sinclair/typebox';
import type { FastifyInstance } from 'fastify';
import { confirmHypothesisConclusion, createHypothesis, listHypotheses, observeHypothesis,
  readHypothesis, suggestHypothesisConclusion, versionHypothesis } from '../application/hypotheses.js';
import { commandEnvelopeSchema } from './domain-schemas.js';
import { createCommandHandler, sendReadError, type RouteDependencies } from './envelope.js';

const strict = { additionalProperties: false } as const;
const uuid = Type.String({ format: 'uuid' });
const revision = Type.String({ pattern: '^[0-9]+$' });
const text = Type.String({ minLength: 1, maxLength: 4000 });
const projectParams = Type.Object({ workspace_id: uuid, project_id: uuid }, strict);
const params = Type.Object({ workspace_id: uuid, id: uuid }, strict);
const definition = { claim: text, method: text, criterion: text, source_knowledge_version_id: Type.Optional(uuid) };
const creation = Type.Object({ command_id: uuid, confirmed: Type.Literal(true),
  title: Type.String({ minLength: 1, maxLength: 200 }), ...definition }, strict);
const versionBody = Type.Object({ command_id: uuid, expected_revision: revision, ...definition }, strict);
const observationBody = Type.Object({ command_id: uuid, expected_revision: revision, summary: text,
  knowledge_version_id: Type.Optional(uuid) }, strict);
const outcome = Type.Union([Type.Literal('SUPPORTED'), Type.Literal('NOT_SUPPORTED'), Type.Literal('INCONCLUSIVE')]);
const suggestionBody = Type.Object({ command_id: uuid, expected_revision: revision, outcome, rationale: text,
  evidence_sufficient: Type.Boolean(), method_reliable: Type.Boolean() }, strict);
const confirmBody = Type.Object({ command_id: uuid, expected_revision: revision, suggestion_id: uuid, confirmed: Type.Literal(true) }, strict);
const resultSchema = Type.Object({ hypothesis_id: uuid, project_id: uuid, revision, version: revision,
  suggestion_id: Type.Optional(uuid), conclusion_id: Type.Optional(uuid), outcome: Type.Optional(outcome),
  recommendation: Type.Optional(Type.String()), decision_review_count: Type.Optional(revision),
  decision_review_candidates_ref: Type.Optional(Type.String()) }, strict);
const response = { 200: commandEnvelopeSchema(resultSchema) };

export function registerHypothesisRoutes(app: FastifyInstance, dependencies: RouteDependencies): void {
  app.post('/projects/:project_id/hypotheses', { schema: { params: projectParams, body: creation,
    response: { 201: commandEnvelopeSchema(resultSchema) } } }, createCommandHandler(dependencies, {
    commandType: 'CreateHypothesis', bodySchema: creation, execute: async ({ executor, params, body }) => {
      const result = await createHypothesis(executor, { workspaceId: params.workspace_id ?? '', projectId: params.project_id ?? '',
        commandId: body.command_id, confirmed: body.confirmed, title: body.title, claim: body.claim, method: body.method,
        criterion: body.criterion, ...(body.source_knowledge_version_id === undefined ? {} : { sourceKnowledgeVersionId: body.source_knowledge_version_id }) });
      return { outcome: result, result: result.result };
    } }));
  app.post('/hypotheses/:id/versions', { schema: { params, body: versionBody, response } }, createCommandHandler(dependencies, {
    commandType: 'VersionHypothesis', bodySchema: versionBody, execute: async ({ executor, params, body }) => {
      const result = await versionHypothesis(executor, { workspaceId: params.workspace_id ?? '', hypothesisId: params.id ?? '',
        commandId: body.command_id, expectedRevision: body.expected_revision, claim: body.claim, method: body.method,
        criterion: body.criterion, ...(body.source_knowledge_version_id === undefined ? {} : { sourceKnowledgeVersionId: body.source_knowledge_version_id }) });
      return { outcome: result, result: result.result };
    } }));
  app.post('/hypotheses/:id/observations', { schema: { params, body: observationBody, response } }, createCommandHandler(dependencies, {
    commandType: 'ObserveHypothesis', bodySchema: observationBody, execute: async ({ executor, params, body }) => {
      const result = await observeHypothesis(executor, { workspaceId: params.workspace_id ?? '', hypothesisId: params.id ?? '',
        commandId: body.command_id, expectedRevision: body.expected_revision, summary: body.summary,
        ...(body.knowledge_version_id === undefined ? {} : { knowledgeVersionId: body.knowledge_version_id }) });
      return { outcome: result, result: result.result };
    } }));
  app.post('/hypotheses/:id/suggestions', { schema: { params, body: suggestionBody, response } }, createCommandHandler(dependencies, {
    commandType: 'SuggestHypothesisConclusion', bodySchema: suggestionBody, execute: async ({ executor, params, body }) => {
      const result = await suggestHypothesisConclusion(executor, { workspaceId: params.workspace_id ?? '', hypothesisId: params.id ?? '',
        commandId: body.command_id, expectedRevision: body.expected_revision, outcome: body.outcome, rationale: body.rationale,
        evidenceSufficient: body.evidence_sufficient, methodReliable: body.method_reliable });
      return { outcome: result, result: result.result };
    } }));
  app.post('/hypotheses/:id/confirmations', { schema: { params, body: confirmBody, response } }, createCommandHandler(dependencies, {
    commandType: 'ConfirmHypothesisConclusion', bodySchema: confirmBody, execute: async ({ executor, params, body }) => {
      const result = await confirmHypothesisConclusion(executor, { workspaceId: params.workspace_id ?? '', hypothesisId: params.id ?? '',
        commandId: body.command_id, expectedRevision: body.expected_revision, suggestionId: body.suggestion_id, confirmed: body.confirmed });
      return { outcome: result, result: result.result };
    } }));
  app.get('/projects/:project_id/hypotheses', { schema: { params: projectParams } }, async (request, reply) => {
    try {
      const ids = request.params as { workspace_id: string; project_id: string };
      return await listHypotheses(dependencies.database.executor, ids.workspace_id, ids.project_id);
    } catch (error) { return sendReadError(reply, error, request.id); }
  });
  app.get('/hypotheses/:id', { schema: { params } }, async (request, reply) => {
    try {
      const ids = request.params as { workspace_id: string; id: string };
      return await readHypothesis(dependencies.database.executor, ids.workspace_id, ids.id);
    } catch (error) { return sendReadError(reply, error, request.id); }
  });
}
