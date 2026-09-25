import { Type } from '@sinclair/typebox';
import type { FastifyInstance } from 'fastify';

import { addKnowledgeVersion, addMemoryRevision, addRuleVersion, createDecision,
  createKnowledge, createMemory, createRule, retireInformation, supersedeDecision,
  type KnowledgeSource } from '../application/information-commands.js';
import { listInformation, listInformationVersions, readInformation, searchInformation }
  from '../application/information-queries.js';
import { validationFailed } from '../application/domain-error.js';
import { commandEnvelopeSchema } from './domain-schemas.js';
import { createCommandHandler, sendReadError, type RouteDependencies } from './envelope.js';

const strict = { additionalProperties: false } as const;
const uuid = Type.String({ format: 'uuid' });
const rev = Type.String({ pattern: '^(0|[1-9][0-9]*)$' });
const text = Type.String({ minLength: 1, maxLength: 262144 });
const base = Type.Object({ workspace_id: uuid }, strict);
const item = Type.Object({ workspace_id: uuid, id: uuid }, strict);
const listQuery = Type.Object({ project_id: Type.Optional(uuid) }, strict);
const commandResult = Type.Record(Type.String(), Type.String());
const source = {
  source_kind: Type.Union([Type.Literal('NOTE'), Type.Literal('MANAGED_TEXT'),
    Type.Literal('ARTIFACT_VERSION')]),
  text: Type.Optional(text), media_type: Type.Optional(Type.String()),
  artifact_version_id: Type.Optional(uuid),
};
const createKnowledgeBody = Type.Object({ command_id: uuid, project_id: Type.Union([uuid, Type.Null()]),
  title: text, ...source }, strict);
const versionKnowledgeBody = Type.Object({ command_id: uuid, expected_revision: rev, ...source }, strict);
const memoryFields = { title: text, text, confirmed: Type.Literal(true),
  expires_at: Type.Optional(Type.Union([Type.String({ format: 'date-time' }), Type.Null()])) };
const createMemoryBody = Type.Object({ command_id: uuid,
  project_id: Type.Union([uuid, Type.Null()]), ...memoryFields }, strict);
const versionMemoryBody = Type.Object({ command_id: uuid, expected_revision: rev, ...memoryFields }, strict);
const createDecisionBody = Type.Object({ command_id: uuid,
  project_id: Type.Union([uuid, Type.Null()]), title: text, choice: text, rationale: text,
  alternatives: Type.Array(text), costs: Type.Array(text) }, strict);
const supersedeBody = Type.Object({ command_id: uuid, expected_revision: rev,
  replacement_decision_id: uuid }, strict);
const ruleFields = { rule_key: text, statement: text,
  strength: Type.Union([Type.Literal('HARD'), Type.Literal('PREFERENCE')]),
  applicability: Type.Literal('AI_RUN'),
  enforcement: Type.Union([Type.Literal('PRE_ACTION'), Type.Literal('POST_CHECK'),
    Type.Literal('SEMANTIC'), Type.Literal('HUMAN')]),
  method: Type.Optional(Type.Union([Type.Literal('HUMAN'), Type.Literal('MARKDOWN_STRUCTURE'),
    Type.Literal('CITATION_EXISTS'), Type.Literal('SEMANTIC'), Type.Null()])),
  target_spec: Type.Optional(Type.Object({}, { additionalProperties: true })),
};
const createRuleBody = Type.Object({ command_id: uuid,
  scope: Type.Union([Type.Literal('WORKSPACE'), Type.Literal('PROJECT'), Type.Literal('TASK')]),
  scope_id: uuid, ...ruleFields }, strict);
const versionRuleBody = Type.Object({ command_id: uuid, expected_revision: rev, ...ruleFields }, strict);
const retireBody = Type.Object({ command_id: uuid, expected_revision: rev }, strict);
const searchQuery = Type.Object({ q: Type.String({ minLength: 1, maxLength: 200 }),
  project_id: Type.Optional(uuid), types: Type.Optional(Type.String()),
  limit: Type.Optional(Type.String({ pattern: '^(?:[1-9]|[1-4][0-9]|50)$' })),
  cursor: Type.Optional(Type.String()) }, strict);

function parsedSource(body: { source_kind: KnowledgeSource['sourceKind']; text?: string;
  media_type?: string; artifact_version_id?: string }): KnowledgeSource {
  if (body.source_kind === 'ARTIFACT_VERSION') {
    if (!body.artifact_version_id || body.text !== undefined || body.media_type !== undefined) {
      throw validationFailed([{ field: 'artifact_version_id', message: 'artifact reference required without text' }]);
    }
    return { sourceKind: body.source_kind, artifactVersionId: body.artifact_version_id };
  }
  if (body.text === undefined || body.artifact_version_id !== undefined) {
    throw validationFailed([{ field: 'text', message: 'text required without artifact_version_id' }]);
  }
  return { sourceKind: body.source_kind, text: body.text,
    ...(body.media_type === undefined ? {} : { mediaType: body.media_type }) };
}

export function registerInformationRoutes(app: FastifyInstance, dependencies: RouteDependencies): void {
  for (const [path, kind] of [['knowledge', 'knowledge'], ['memories', 'memory'],
    ['decisions', 'decision'], ['rules', 'rule']] as const) {
    app.get(`/${path}`, { schema: { params: base, querystring: listQuery } }, async (request, reply) => {
      try {
        const p = request.params as { workspace_id: string };
        const q = request.query as { project_id?: string };
        return await listInformation(dependencies.database.executor, kind, p.workspace_id, q.project_id);
      } catch (error) { return sendReadError(reply, error, request.id); }
    });
    app.get(`/${path}/:id`, { schema: { params: item } }, async (request, reply) => {
      try {
        const p = request.params as { workspace_id: string; id: string };
        return await readInformation(dependencies.database.executor, kind, p.workspace_id, p.id);
      } catch (error) { return sendReadError(reply, error, request.id); }
    });
    const versions = kind === 'memory' ? 'revisions' : 'versions';
    app.get(`/${path}/:id/${versions}`, { schema: { params: item } }, async (request, reply) => {
      try {
        const p = request.params as { workspace_id: string; id: string };
        return await listInformationVersions(dependencies.database.executor, kind, p.workspace_id, p.id);
      } catch (error) { return sendReadError(reply, error, request.id); }
    });
  }

  app.post('/knowledge', { schema: { params: base, body: createKnowledgeBody,
    response: { 201: commandEnvelopeSchema(commandResult) } } },
  createCommandHandler(dependencies, { commandType: 'CreateKnowledge', bodySchema: createKnowledgeBody,
    execute: async ({ executor, params, body }) => {
      const outcome = await createKnowledge(executor, { workspaceId: params.workspace_id ?? '',
        commandId: body.command_id, projectId: body.project_id, title: body.title,
        source: parsedSource(body) });
      return { outcome, result: outcome.result };
    } }));
  app.post('/knowledge/:id/versions', { schema: { params: item, body: versionKnowledgeBody,
    response: { 200: commandEnvelopeSchema(commandResult) } } },
  createCommandHandler(dependencies, { commandType: 'AddKnowledgeVersion', bodySchema: versionKnowledgeBody,
    execute: async ({ executor, params, body }) => {
      const outcome = await addKnowledgeVersion(executor, { workspaceId: params.workspace_id ?? '',
        knowledgeId: params.id ?? '', commandId: body.command_id,
        expectedRevision: body.expected_revision, source: parsedSource(body) });
      return { outcome, result: outcome.result };
    } }));
  app.post('/knowledge/:id/archive', { schema: { params: item, body: retireBody,
    response: { 200: commandEnvelopeSchema(commandResult) } } },
  createCommandHandler(dependencies, { commandType: 'ArchiveKnowledge', bodySchema: retireBody,
    execute: async ({ executor, params, body }) => {
      const outcome = await retireInformation(executor, { kind: 'knowledge', id: params.id ?? '',
        workspaceId: params.workspace_id ?? '', commandId: body.command_id,
        expectedRevision: body.expected_revision });
      return { outcome, result: outcome.result };
    } }));

  app.post('/memories', { schema: { params: base, body: createMemoryBody,
    response: { 201: commandEnvelopeSchema(commandResult) } } },
  createCommandHandler(dependencies, { commandType: 'CreateMemory', bodySchema: createMemoryBody,
    execute: async ({ executor, params, body }) => {
      const outcome = await createMemory(executor, { workspaceId: params.workspace_id ?? '',
        commandId: body.command_id, projectId: body.project_id, title: body.title,
        text: body.text, confirmed: body.confirmed,
        ...(body.expires_at === undefined ? {} : { expiresAt: body.expires_at }) });
      return { outcome, result: outcome.result };
    } }));
  app.post('/memories/:id/revisions', { schema: { params: item, body: versionMemoryBody,
    response: { 200: commandEnvelopeSchema(commandResult) } } },
  createCommandHandler(dependencies, { commandType: 'AddMemoryRevision', bodySchema: versionMemoryBody,
    execute: async ({ executor, params, body }) => {
      const outcome = await addMemoryRevision(executor, { workspaceId: params.workspace_id ?? '',
        memoryId: params.id ?? '', commandId: body.command_id,
        expectedRevision: body.expected_revision, title: body.title,
        text: body.text, confirmed: body.confirmed,
        ...(body.expires_at === undefined ? {} : { expiresAt: body.expires_at }) });
      return { outcome, result: outcome.result };
    } }));
  app.post('/memories/:id/retire', { schema: { params: item, body: retireBody,
    response: { 200: commandEnvelopeSchema(commandResult) } } },
  createCommandHandler(dependencies, { commandType: 'RetireMemory', bodySchema: retireBody,
    execute: async ({ executor, params, body }) => {
      const outcome = await retireInformation(executor, { kind: 'memory', id: params.id ?? '',
        workspaceId: params.workspace_id ?? '', commandId: body.command_id,
        expectedRevision: body.expected_revision });
      return { outcome, result: outcome.result };
    } }));

  app.post('/decisions', { schema: { params: base, body: createDecisionBody,
    response: { 201: commandEnvelopeSchema(commandResult) } } },
  createCommandHandler(dependencies, { commandType: 'CreateDecision', bodySchema: createDecisionBody,
    execute: async ({ executor, params, body }) => {
      const outcome = await createDecision(executor, { workspaceId: params.workspace_id ?? '',
        commandId: body.command_id, projectId: body.project_id, title: body.title,
        choice: body.choice, rationale: body.rationale,
        alternatives: body.alternatives, costs: body.costs });
      return { outcome, result: outcome.result };
    } }));
  app.post('/decisions/:id/supersessions', { schema: { params: item, body: supersedeBody,
    response: { 200: commandEnvelopeSchema(commandResult) } } },
  createCommandHandler(dependencies, { commandType: 'SupersedeDecision', bodySchema: supersedeBody,
    execute: async ({ executor, params, body }) => {
      const outcome = await supersedeDecision(executor, { workspaceId: params.workspace_id ?? '',
        decisionId: params.id ?? '', commandId: body.command_id,
        expectedRevision: body.expected_revision,
        replacementDecisionId: body.replacement_decision_id });
      return { outcome, result: outcome.result };
    } }));

  app.post('/rules', { schema: { params: base, body: createRuleBody,
    response: { 201: commandEnvelopeSchema(commandResult) } } },
  createCommandHandler(dependencies, { commandType: 'CreateRule', bodySchema: createRuleBody,
    execute: async ({ executor, params, body }) => {
      const outcome = await createRule(executor, { workspaceId: params.workspace_id ?? '',
        commandId: body.command_id, scope: body.scope, scopeId: body.scope_id,
        ruleKey: body.rule_key, statement: body.statement, strength: body.strength,
        applicability: body.applicability, enforcement: body.enforcement,
        ...(body.method === undefined ? {} : { method: body.method }),
        ...(body.target_spec === undefined ? {} : { targetSpec: body.target_spec }) });
      return { outcome, result: outcome.result };
    } }));
  app.post('/rules/:id/versions', { schema: { params: item, body: versionRuleBody,
    response: { 200: commandEnvelopeSchema(commandResult) } } },
  createCommandHandler(dependencies, { commandType: 'AddRuleVersion', bodySchema: versionRuleBody,
    execute: async ({ executor, params, body }) => {
      const outcome = await addRuleVersion(executor, { workspaceId: params.workspace_id ?? '',
        ruleId: params.id ?? '', commandId: body.command_id,
        expectedRevision: body.expected_revision, ruleKey: body.rule_key,
        statement: body.statement, strength: body.strength,
        applicability: body.applicability, enforcement: body.enforcement,
        ...(body.method === undefined ? {} : { method: body.method }),
        ...(body.target_spec === undefined ? {} : { targetSpec: body.target_spec }) });
      return { outcome, result: outcome.result };
    } }));
  app.post('/rules/:id/retire', { schema: { params: item, body: retireBody,
    response: { 200: commandEnvelopeSchema(commandResult) } } },
  createCommandHandler(dependencies, { commandType: 'RetireRule', bodySchema: retireBody,
    execute: async ({ executor, params, body }) => {
      const outcome = await retireInformation(executor, { kind: 'rule', id: params.id ?? '',
        workspaceId: params.workspace_id ?? '', commandId: body.command_id,
        expectedRevision: body.expected_revision });
      return { outcome, result: outcome.result };
    } }));

  app.get('/search', { schema: { params: base, querystring: searchQuery } }, async (request, reply) => {
    try {
      const p = request.params as { workspace_id: string };
      const q = request.query as { q: string; project_id?: string; types?: string;
        limit?: string; cursor?: string };
      return await searchInformation(dependencies.database.executor, {
        workspaceId: p.workspace_id, query: q.q,
        ...(q.project_id === undefined ? {} : { projectId: q.project_id }),
        ...(q.types === undefined ? {} : { types: q.types }),
        ...(q.limit === undefined ? {} : { limit: Number(q.limit) }),
        ...(q.cursor === undefined ? {} : { cursor: q.cursor }),
      });
    } catch (error) { return sendReadError(reply, error, request.id); }
  });
}
